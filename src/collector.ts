import { Context, Session, Element, Tables } from 'koishi';

// 接口定义
declare module 'koishi' {
  interface Tables {
    analyse_msg: {
      id: number;
      channelId: string;
      userId: string;
      type: string;
      content: string;
      timestamp: Date;
    };
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
  private static readonly FLUSH_INTERVAL = 60 * 1000;
  private static readonly BUFFER_THRESHOLD = 100;

  private msgBuffer: Omit<Tables['analyse_msg'], 'id'>[] = [];
  private flushInterval: NodeJS.Timeout;
  private nameCache = new Map<string, { name: string, timestamp: number }>();
  private pendingNameRequests = new Map<string, Promise<void>>();

  /**
   * @constructor
   * @param ctx {Context} Koishi 的上下文对象
   */
  constructor(private ctx: Context) {
    // 初始化 `analyse_msg` 表
    this.ctx.model.extend('analyse_msg', {
      id: 'unsigned', channelId: 'string', userId: 'string', type: 'string', content: 'text', timestamp: 'timestamp',
    }, {
      primary: 'id',
      autoInc: true,
      indexes: ['timestamp', 'channelId', 'userId', 'type']
    });

    // 初始化 `analyse_name` 表
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
    if (!effectiveId || !userId || !timestamp) return;
    await this.updateNameIfNeeded(session, effectiveId);
    const isCommand = !!argv?.command;
    const type = isCommand ? argv.command.name : this.summarizeElementTypes(elements);
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
    this.msgBuffer = [];
    try {
      await this.ctx.database.upsert('analyse_msg', bufferToFlush as any);
    } catch (error) {
      this.ctx.logger.error('数据写入失败:', error);
      this.msgBuffer.unshift(...bufferToFlush);
    }
  }

  /**
   * 检查并更新用户和群组的名称信息。
   */
  private async updateNameIfNeeded(session: Session, effectiveId: string): Promise<void> {
    const { userId } = session;
    if (!userId) return;
    const cacheKey = `${effectiveId}:${userId}`;

    if (this.pendingNameRequests.has(cacheKey)) return this.pendingNameRequests.get(cacheKey);

    const cached = this.nameCache.get(cacheKey);
    const CACHE_EXPIRATION = 24 * 60 * 60 * 1000;
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRATION)) return;

    const promise = this.fetchAndUpdateNames(session, effectiveId, cacheKey);
    this.pendingNameRequests.set(cacheKey, promise);

    try {
      await promise;
    } finally {
      this.pendingNameRequests.delete(cacheKey);
    }
  }

  /**
   * @private
   * 封装了实际获取和更新名称的异步逻辑。
   */
  private async fetchAndUpdateNames(session: Session, effectiveId: string, cacheKey: string): Promise<void> {
    try {
      const { userId, guildId, bot } = session;

      const [guild, member] = await Promise.all([
        guildId ? bot.getGuild(guildId).catch(() => null) : Promise.resolve(null),
        guildId && userId ? bot.getGuildMember(guildId, userId).catch(() => null) : Promise.resolve(null),
      ]);

      const channelName = guild?.name;
      const userName = member?.nick || member?.name;

      // 如果无法获取到任何一个名称，直接将失败结果缓存24小时并返回
      if (!channelName || !userName) {
        this.nameCache.set(cacheKey, { name: null, timestamp: Date.now() });
        return;
      }

      await this.ctx.database.upsert('analyse_name', [{
        channelId: effectiveId,
        userId: userId,
        channelName: channelName,
        userName: userName,
      }]);

      // 成功后，更新内存缓存
      this.nameCache.set(cacheKey, { name: userName, timestamp: Date.now() });
    } catch (error) {
      this.nameCache.set(cacheKey, { name: null, timestamp: Date.now() });
    }
  }
}
