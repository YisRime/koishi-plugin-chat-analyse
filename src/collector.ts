import { Context, Session, Element, Tables } from 'koishi';

// 扩展 Koishi 的 Tables 接口
declare module 'koishi' {
  interface Tables {
    // 存储原始消息记录
    analyse_msg: {
      channelId: string;
      userId: string;
      type: string;
      content: string;
      timestamp: Date;
    };
    // 存储 ID 与名称的映射关系
    analyse_name: {
      channelId: string;
      channelName: string;
      userId: string;
      userName: string;
    }
  }
}

/**
 * @class Collector
 * @description
 * 负责初始化数据库表、监听消息，并将处理后的数据高效存入数据库。
 */
export class Collector {
  // 每隔 1 分钟将缓冲区数据写入数据库
  private static readonly FLUSH_INTERVAL = 60 * 1000;
  // 当缓冲区数据达到 100 条时，立即写入数据库
  private static readonly BUFFER_THRESHOLD = 100;

  // 消息数据写入缓冲区
  private msgBuffer: Tables['analyse_msg'][] = [];
  // 定时器，用于周期性地清空缓冲区
  private flushInterval: NodeJS.Timeout;
  // 名称缓存，减少不必要的 API 请求 (key: 'channelId:userId')
  private nameCache = new Map<string, { name: string, timestamp: number }>();

  /**
   * @constructor
   * @param ctx {Context} Koishi 的上下文对象
   */
  constructor(private ctx: Context) {
    // 初始化 `analyse_msg` 表
    this.ctx.model.extend('analyse_msg', {
      channelId: 'string', userId: 'string', type: 'string', content: 'text', timestamp: 'timestamp',
    }, {
      primary: ['channelId', 'userId', 'timestamp'],
      indexes: ['type']
    });

    // 初始化 `analyse_name` 表，用于存储 ID-名称映射
    this.ctx.model.extend('analyse_name', {
      channelId: 'string', channelName: 'string', userId: 'string', userName: 'string',
    }, {
      primary: ['channelId', 'userId']
    });

    // 监听所有消息事件
    ctx.on('message', (session: Session) => {
      this.handleMessage(session);
    });

    // 设置定时任务，周期性地将缓冲区数据写入数据库
    this.flushInterval = setInterval(() => this.flushBuffer(), Collector.FLUSH_INTERVAL);

    // 在插件停用时，确保将所有剩余数据写入数据库
    ctx.on('dispose', () => {
      clearInterval(this.flushInterval);
      this.flushBuffer();
    });
  }

  /**
   * 核心消息处理函数。
   * @param session {Session} 消息会话对象
   */
  private async handleMessage(session: Session) {
    const { userId, channelId, guildId, content, timestamp, argv, elements } = session;
    const effectiveId = channelId || guildId;

    if (!effectiveId || !userId) return;

    // 按需更新用户和群组的名称
    this.updateNameIfNeeded(session, effectiveId);

    // 判断消息是否为命令，并确定其类型
    const isCommand = !!argv?.command;
    const type = isCommand
      ? argv.command.name
      : this.summarizeElementTypes(elements);

    // 标准化消息内容
    const finalContent = isCommand ? content : this.sanitizeContent(elements);

    if (!finalContent?.trim()) return;

    // 将处理后的消息推入缓冲区
    this.msgBuffer.push({
      channelId: effectiveId,
      userId,
      type,
      content: finalContent,
      timestamp: new Date(timestamp),
    });

    // 如果缓冲区达到阈值，立即写入
    if (this.msgBuffer.length >= Collector.BUFFER_THRESHOLD) {
      this.flushBuffer();
    }
  }

  /**
   * 从消息元素中提取并汇总类型。
   * @example
   * // returns "[text][img]"
   * summarizeElementTypes([{type: 'text'}, {type: 'img'}])
   */
  private summarizeElementTypes(elements: Element[]): string {
    return [...new Set(elements.map(e => `[${e.type}]`))].join('');
  }

  /**
   * 从消息元素中提取文本化、安全的内容。
   */
  private sanitizeContent(elements: Element[]): string {
    return elements.map(element => {
      switch (element.type) {
        case 'text': return element.attrs.content;
        case 'img': return element.attrs.summary === '[动画表情]' ? '[gif]' : `[img]`;
        case 'at': return `[at:${element.attrs.id}]`;
        default: return `[${element.type}]`;
      }
    }).join('');
  }

  /**
   * 将内存缓冲区的消息数据批量写入数据库。
   */
  private async flushBuffer() {
    if (this.msgBuffer.length === 0) return;

    const bufferToFlush = this.msgBuffer;
    this.msgBuffer = []; // 清空原缓冲区以便接收新消息

    try {
      await this.ctx.database.create('analyse_msg', bufferToFlush as any);
    } catch (error) {
      this.ctx.logger.error('数据库写入失败:', error);
      // 将失败的数据重新推回缓冲区
      this.msgBuffer.unshift(...bufferToFlush);
    }
  }

  /**
   * 检查并更新用户和群组的名称信息。
   * 如果名称不在缓存或缓存已过期 (超过24小时)，则从 API 获取并更新到数据库。
   */
  private async updateNameIfNeeded(session: Session, effectiveId: string) {
    const { userId, guildId, bot } = session;
    const cacheKey = `${effectiveId}:${userId}`;
    const cached = this.nameCache.get(cacheKey);
    const
     CACHE_EXPIRATION = 24 * 60 * 60 * 1000; // 24 hours

    // 如果缓存有效，则直接返回
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRATION)) return;

    try {
      const [guild, member] = await Promise.all([
        bot.getGuild(guildId),
        bot.getGuildMember(guildId, userId),
      ]);

      const channelName = guild?.name;
      const userName = member?.nick || member?.name;

      if (!channelName || !userName) return;

      // 使用 upsert 直接写入或更新
      await this.ctx.database.upsert('analyse_name', [{
        channelId: effectiveId,
        channelName,
        userId,
        userName,
      }]);

      // 更新内存缓存
      this.nameCache.set(cacheKey, { name: userName, timestamp: Date.now() });
    } catch (error) {
        this.ctx.logger.warn('更新用户/群组名称失败:', error)
    }
  }
}
