import { Context, Session, Element, Tables, $ } from 'koishi';
import { Config } from './index';

// 扩展数据表类型
declare module 'koishi' {
  interface Tables {
    analyse_user: {
      uid: number;
      channelId: string;
      userId: string;
      channelName: string;
      userName: string;
    };
    analyse_cmd: {
      uid: number;
      command: string;
      count: number;
      timestamp: Date;
    };
    analyse_msg: {
      uid: number;
      type: string;
      count: number;
      timestamp: Date;
    };
    analyse_cache: {
      id: number;
      channelId: string;
      userId: string;
      content: string;
      timestamp: Date;
    };
  }
}

/**
 * @class Collector
 * @description 核心数据收集器。根据插件配置，高效地监听、收集、缓冲并持久化聊天数据。
 */
export class Collector {
  /** @const {number} FLUSH_INTERVAL - 内存缓存区自动刷新到数据库的时间间隔。 */
  private static readonly FLUSH_INTERVAL = 60 * 1000;
  /** @const {number} BUFFER_THRESHOLD - 内存缓存区触发自动刷新的消息数量阈值。 */
  private static readonly BUFFER_THRESHOLD = 100;

  /** @member {Omit<Tables['analyse_cache'], 'id'>[]} cacheBuffer - 用于暂存原始消息的内存缓冲区，以减少数据库写入频率。 */
  private cacheBuffer: Omit<Tables['analyse_cache'], 'id'>[] = [];
  /** @member {Map<string, number>} uidCache - 用户 uid 的内存缓存，避免重复查询数据库。*/
  private uidCache = new Map<string, number>();

  /** @member {Map<string, Promise<number>>} pendingUidRequests - 用于处理并发获取 uid 的请求锁。*/
  private pendingUidRequests = new Map<string, Promise<number>>();
  private flushInterval: NodeJS.Timeout;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的插件上下文。
   * @param {Config} config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    this.defineModels();
    ctx.on('message', (session) => this.handleMessage(session));
    if (this.config.enableAdvanced) {
      this.flushInterval = setInterval(() => this.flushCacheBuffer(), Collector.FLUSH_INTERVAL);
      ctx.on('dispose', () => {
        clearInterval(this.flushInterval);
        this.flushCacheBuffer();
      });
    }
  }

  /**
   * @private
   * @method defineModels
   * @description 定义插件所需的所有数据表模型。
   */
  private defineModels() {
    this.ctx.model.extend('analyse_user', {
      uid: 'unsigned', channelId: 'string', userId: 'string', channelName: 'string', userName: 'string',
    }, { primary: 'uid', autoInc: true, indexes: ['channelId', 'userId'] });
    this.ctx.model.extend('analyse_cmd', {
      uid: 'unsigned', command: 'string', count: 'unsigned', timestamp: 'timestamp',
    }, { primary: ['uid', 'command'] });
    this.ctx.model.extend('analyse_msg', {
      uid: 'unsigned', type: 'string', count: 'unsigned', timestamp: 'timestamp',
    }, { primary: ['uid', 'type'] });
    if (this.config.enableAdvanced) {
      this.ctx.model.extend('analyse_cache', {
        id: 'unsigned', channelId: 'string', userId: 'string',
        content: 'text', timestamp: 'timestamp',
      }, { primary: 'id', autoInc: true });
    }
  }

  /**
   * @private
   * @async
   * @method handleMessage
   * @description 统一的消息和命令处理器。它会解析收到的消息，提取关键信息并更新相应的统计数据。
   * @param {Session} session - Koishi 的会话对象，包含消息的全部信息。
   */
  private async handleMessage(session: Session) {
    try {
      const { userId, channelId, guildId, content, timestamp, argv, elements } = session;
      const effectiveId = channelId || guildId;
      if (!effectiveId || !userId || !timestamp || !content?.trim()) return;

      const uid = await this.getOrCreateUser(session, effectiveId);
      if (!uid) return;
      const now = new Date();

      if (argv?.command) {
        await this.ctx.database.upsert('analyse_cmd', (row) => [{
          uid,
          command: argv.command.name,
          count: $.add($.ifNull(row.count, $.literal(0)), 1),
          timestamp: now,
        }]);
      }

      const uniqueElementTypes = new Set(elements.map(e => e.type));
      for (const type of uniqueElementTypes) {
        await this.ctx.database.upsert('analyse_msg', (row) => [{
          uid, type,
          count: $.add($.ifNull(row.count, $.literal(0)), 1),
          timestamp: now,
        }]);
      }

      if (this.config.enableAdvanced) {
        this.cacheBuffer.push({
          channelId: effectiveId, userId,
          content: this.sanitizeContent(elements),
          timestamp: new Date(timestamp),
        });
        if (this.cacheBuffer.length >= Collector.BUFFER_THRESHOLD) await this.flushCacheBuffer();
      }
    } catch (error) {
      this.ctx.logger.warn('消息处理出错:', error);
    }
  }

  /**
   * @private
   * @async
   * @method getOrCreateUser
   * @description 高效地获取或创建用户的中央记录 (`analyse_user`)。
   * @param {Session} session - Koishi 会话对象，用于获取用户信息和 Bot 实例。
   * @param {string} channelId - 消息所在的频道或群组 ID。
   * @returns {Promise<number | null>} 返回用户的唯一 `uid`，如果操作失败则返回 `null`。
   */
  private async getOrCreateUser(session: Session, channelId: string): Promise<number | null> {
    const { userId, bot, guildId } = session;
    const cacheKey = `${channelId}:${userId}`;

    if (this.uidCache.has(cacheKey)) return this.uidCache.get(cacheKey);
    if (this.pendingUidRequests.has(cacheKey)) return this.pendingUidRequests.get(cacheKey);

    const promise = (async (): Promise<number | null> => {
      try {
        const existing = await this.ctx.database.get('analyse_user', { channelId, userId }, ['uid']);
        if (existing.length > 0) {
          this.uidCache.set(cacheKey, existing[0].uid);
          return existing[0].uid;
        }

        const [guild, member] = await Promise.all([
          guildId ? bot.getGuild(guildId).catch(() => null) : Promise.resolve(null),
          guildId ? bot.getGuildMember(guildId, userId).catch(() => null) : Promise.resolve(null),
        ]);

        const user = !member ? await bot.getUser(userId).catch(() => null) : null;

        const newUser = await this.ctx.database.create('analyse_user', {
          channelId, userId,
          channelName: guild?.name || channelId,
          userName: member?.nick || member?.name || user?.name || userId,
        });

        this.uidCache.set(cacheKey, newUser.uid);
        return newUser.uid;
      } catch (error) {
        this.ctx.logger.error(`创建或获取用户(${cacheKey}) UID 失败:`, error);
        return null;
      } finally {
        this.pendingUidRequests.delete(cacheKey);
      }
    })();

    this.pendingUidRequests.set(cacheKey, promise);
    return promise;
  }

  /**
   * @private
   * @method sanitizeContent
   * @description 将 Koishi 的消息元素 (Element) 数组净化为纯文本字符串，以便存储和分析。
   * @param {Element[]} elements - 消息元素的数组。
   * @returns {string} 净化后的纯文本字符串。
   */
  private sanitizeContent = (elements: Element[]): string =>
    elements.map(e => {
      switch (e.type) {
        case 'text': return e.attrs.content;
        case 'img': return e.attrs.summary === '[动画表情]' ? '[gif]' : '[img]';
        case 'at': return `[at:${e.attrs.id}]`;
        default: return `[${e.type}]`;
      }
    }).join('');

  /**
   * @private
   * @async
   * @method flushCacheBuffer
   * @description 将内存中的消息缓存 (`cacheBuffer`) 批量写入数据库。
   */
  private async flushCacheBuffer() {
    if (this.cacheBuffer.length === 0) return;

    const bufferToFlush = this.cacheBuffer;
    this.cacheBuffer = [];

    try {
      await this.ctx.database.upsert('analyse_cache', bufferToFlush as any);
    } catch (error) {
      this.ctx.logger.error('写入缓存出错:', error);
    }
  }
}
