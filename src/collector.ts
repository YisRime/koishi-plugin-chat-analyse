import { Context, Session, Element, Tables } from 'koishi';

// 扩展 Koishi 的 Tables 接口，定义插件所需的数据表结构
declare module 'koishi' {
  interface Tables {
    analyse_ori_msg: {
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
 * @description 负责收集、缓冲并持久化消息数据，同时高效缓存用户与群组的名称信息。
 */
export class Collector {
  // 数据刷新配置
  private static readonly FLUSH_INTERVAL = 60 * 1000; // 每分钟刷新一次
  private static readonly BUFFER_THRESHOLD = 100;    // 缓冲区达到100条消息时刷新
  // 消息和名称缓存
  private msgBuffer: Omit<Tables['analyse_ori_msg'], 'id'>[] = [];
  private nameCache = new Map<string, { name: string, timestamp: number }>();
  private pendingNameRequests = new Map<string, Promise<void>>();
  private flushInterval: NodeJS.Timeout;

  /**
   * @constructor
   * @param ctx {Context} Koishi 上下文，用于访问框架核心功能。
   */
  constructor(private ctx: Context) {
    // 初始化 `analyse_ori_msg` 数据表
    ctx.model.extend('analyse_ori_msg', {
      id: 'unsigned', channelId: 'string', userId: 'string',
      type: 'string', content: 'text', timestamp: 'timestamp',
    }, { primary: 'id', autoInc: true, indexes: ['timestamp', 'channelId', 'userId', 'type'] });
    // 初始化 `analyse_name` 数据表
    ctx.model.extend('analyse_name', {
      channelId: 'string', channelName: 'string',
      userId: 'string', userName: 'string',
    }, { primary: ['channelId', 'userId'] });
    // 监听消息事件
    ctx.on('message', (session) => this.handleMessage(session));
    // 定时将缓冲区数据写入数据库
    this.flushInterval = setInterval(() => this.flushBuffer(), Collector.FLUSH_INTERVAL);
    // 插件停用时，确保所有剩余数据都被写入
    ctx.on('dispose', () => {
      clearInterval(this.flushInterval);
      this.flushBuffer();
    });
  }

  /**
   * 核心消息处理器，对消息进行格式化并存入缓冲区。
   * @param session {Session} 消息会话对象。
   */
  private async handleMessage(session: Session) {
    const { userId, channelId, guildId, content, timestamp, argv, elements } = session;
    const effectiveId = channelId || guildId;
    if (!effectiveId || !userId || !timestamp || !content?.trim()) return;
    // 异步更新名称，不阻塞主流程
    this.updateNameIfNeeded(session, effectiveId);
    const isCommand = !!argv?.command;
    const type = isCommand ? argv.command.name : this.summarizeElementTypes(elements);
    const finalContent = isCommand ? content : this.sanitizeContent(elements);
    this.msgBuffer.push({
      channelId: effectiveId,
      userId, type,
      content: finalContent,
      timestamp: new Date(timestamp),
    });
    if (this.msgBuffer.length >= Collector.BUFFER_THRESHOLD) await this.flushBuffer();
  }

  /**
   * 汇总消息元素的类型，生成紧凑的类型字符串。
   * @param elements {Element[]} 消息元素数组。
   * @returns {string} 类型汇总字符串，如 `[text][img]`。
   */
  private summarizeElementTypes(elements: Element[]): string {
    const types = new Set(elements.map(e => `[${e.type}]`));
    return Array.from(types).join('');
  }

  /**
   * 清理并格式化消息内容，提取关键信息。
   * @param elements {Element[]} 消息元素数组。
   * @returns {string} 处理后的内容字符串。
   */
  private sanitizeContent(elements: Element[]): string {
    return elements.map(e => {
      switch (e.type) {
        case 'text': return e.attrs.content;
        case 'img': return e.attrs.summary === '[动画表情]' ? '[gif]' : '[img]';
        case 'at': return `[at:${e.attrs.id}]`;
        default: return `[${e.type}]`;
      }
    }).join('');
  }

  /**
   * 将内存缓冲区的消息批量写入数据库，并处理写入失败的情况。
   */
  private async flushBuffer() {
    if (this.msgBuffer.length === 0) return;
    const bufferToFlush = this.msgBuffer;
    this.msgBuffer = [];
    try {
      await this.ctx.database.upsert('analyse_ori_msg', bufferToFlush as any);
    } catch (error) {
      this.ctx.logger.error('数据写入失败:', error);
      this.msgBuffer.unshift(...bufferToFlush);
    }
  }

  /**
   * 检查用户和群组名称是否需要更新，利用缓存和请求锁机制避免重复调用。
   * @param session {Session} 消息会话对象。
   * @param effectiveId {string} 有效的频道/群组ID。
   */
  private async updateNameIfNeeded(session: Session, effectiveId: string): Promise<void> {
    const { userId } = session;
    if (!userId) return;
    const cacheKey = `${effectiveId}:${userId}`;
    const CACHE_EXPIRATION = 24 * 60 * 60 * 1000;
    // 如果有正在进行的请求，则等待其完成
    if (this.pendingNameRequests.has(cacheKey)) return this.pendingNameRequests.get(cacheKey);
    // 检查缓存是否有效
    const cached = this.nameCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < CACHE_EXPIRATION)) return;
    // 执行获取和更新操作
    const promise = this.fetchAndUpdateNames(session, effectiveId, cacheKey);
    this.pendingNameRequests.set(cacheKey, promise);
    promise.finally(() => this.pendingNameRequests.delete(cacheKey));
  }

  /**
   * 异步获取用户和群组的最新名称，并更新到数据库和内存缓存。
   * @param session {Session} 消息会话对象。
   * @param effectiveId {string} 频道/群组ID。
   * @param cacheKey {string} 用于缓存的键。
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
      // 只要有一个名称获取失败，就缓存失败结果并提前返回
      if (!channelName || !userName) {
        this.nameCache.set(cacheKey, { name: null, timestamp: Date.now() });
        return;
      }
      await this.ctx.database.upsert('analyse_name', [{
        channelId: effectiveId, userId, channelName, userName,
      }]);
      // 成功后更新缓存
      this.nameCache.set(cacheKey, { name: userName, timestamp: Date.now() });
    } catch (error) {
      // 发生异常时同样缓存失败结果，防止短时间内频繁重试
      this.nameCache.set(cacheKey, { name: null, timestamp: Date.now() });
    }
  }
}
