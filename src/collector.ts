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
      hour: Date;
      count: number;
      timestamp: Date;
    };
    analyse_cache: {
      id: number;
      uid: number;
      content: string;
      timestamp: Date;
    };
  }
}

// 定义用户缓存对象接口
interface UserCache {
  uid: number;
  userName: string;
  channelName: string;
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

  // 统一的缓冲区
  private msgStatBuffer = new Map<string, { uid: number; type: string; hour: Date; count: number; timestamp: Date }>();
  private cmdStatBuffer = new Map<string, { uid: number; command: string; count: number; timestamp: Date }>();
  private oriCacheBuffer: Omit<Tables['analyse_cache'], 'id'>[] = [];

  // 用户缓存
  private userCache = new Map<string, UserCache>();
  private pendingUserRequests = new Map<string, Promise<UserCache | null>>();
  private flushInterval: NodeJS.Timeout;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的插件上下文。
   * @param {Config} config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    this.defineModels();
    ctx.on('message', (session) => this.handleMessage(session));
    this.flushInterval = setInterval(() => this.flushBuffers(), Collector.FLUSH_INTERVAL);
    ctx.on('dispose', () => {
      clearInterval(this.flushInterval);
      this.flushBuffers();
    });
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
      uid: 'unsigned', type: 'string', hour: 'timestamp', count: 'unsigned', timestamp: 'timestamp',
    }, { primary: ['uid', 'type', 'hour'] });
    if (this.config.enableOriRecord) {
      this.ctx.model.extend('analyse_cache', {
        id: 'unsigned', uid: 'unsigned', content: 'text', timestamp: 'timestamp',
      }, { primary: 'id', autoInc: true, indexes: ['uid', 'timestamp'] });
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

      const user = await this.getOrCreateCachedUser(session, effectiveId);
      if (!user) return;
      const { uid } = user;

      const messageTime = new Date(timestamp);

      // 聚合命令统计到缓冲区
      if (argv?.command) {
        const key = `${uid}:${argv.command.name}`;
        const existing = this.cmdStatBuffer.get(key);
        if (existing) {
          existing.count++;
          existing.timestamp = messageTime;
        } else {
          this.cmdStatBuffer.set(key, { uid, command: argv.command.name, count: 1, timestamp: messageTime });
        }
      }

      // 聚合消息统计到缓冲区
      const hourStart = new Date(messageTime.getFullYear(), messageTime.getMonth(), messageTime.getDate(), messageTime.getHours());
      const uniqueElementTypes = new Set(elements.map(e => e.type));
      for (const type of uniqueElementTypes) {
        const key = `${uid}:${type}:${hourStart.toISOString()}`;
        const existing = this.msgStatBuffer.get(key);
        if (existing) {
          existing.count++;
          existing.timestamp = messageTime;
        } else {
          this.msgStatBuffer.set(key, { uid, type, hour: hourStart, count: 1, timestamp: messageTime });
        }
      }

      // 聚合原始消息到缓冲区
      if (this.config.enableOriRecord) {
        this.oriCacheBuffer.push({
          uid,
          content: this.sanitizeContent(elements),
          timestamp: messageTime,
        });
        if (this.oriCacheBuffer.length >= Collector.BUFFER_THRESHOLD) await this.flushBuffers();
      }
    } catch (error) {
      this.ctx.logger.warn('消息处理出错:', error);
    }
  }

  /**
   * @private
   * @async
   * @method getOrCreateCachedUser
   * @description 高效地获取或创建用户的中央记录，并全面利用缓存。
   * @param {Session} session - Koishi 会话对象，用于获取用户信息和 Bot 实例。
   * @param {string} channelId - 消息所在的频道或群组 ID。
   * @returns {Promise<UserCache | null>} 返回用户的缓存对象，如果操作失败则返回 `null`。
   */
  private async getOrCreateCachedUser(session: Session, channelId: string): Promise<UserCache | null> {
    const { userId, bot, guildId } = session;
    const cacheKey = `${channelId}:${userId}`;

    if (this.userCache.has(cacheKey)) return this.userCache.get(cacheKey);
    if (this.pendingUserRequests.has(cacheKey)) return this.pendingUserRequests.get(cacheKey);

    const promise = (async (): Promise<UserCache | null> => {
      try {
        const existing = await this.ctx.database.get('analyse_user', { channelId, userId });
        if (existing.length > 0) {
          const { uid, userName, channelName } = existing[0];
          const cachedUser = { uid, userName, channelName };
          this.userCache.set(cacheKey, cachedUser);
          return cachedUser;
        }

        const [guild, member] = await Promise.all([
          guildId ? bot.getGuild(guildId).catch(() => null) : Promise.resolve(null),
          guildId ? bot.getGuildMember(guildId, userId).catch(() => null) : Promise.resolve(null),
        ]);
        const user = !member ? await bot.getUser(userId).catch(() => null) : null;

        const newUserRecord = {
          channelId,
          userId,
          channelName: guild?.name || channelId,
          userName: member?.nick || member?.name || user?.name || userId,
        };

        const createdUser = await this.ctx.database.create('analyse_user', newUserRecord);
        const { uid, userName, channelName } = createdUser;
        const cachedUser: UserCache = { uid, userName, channelName };
        this.userCache.set(cacheKey, cachedUser);
        return cachedUser;
      } catch (error) {
        this.ctx.logger.error(`创建或获取用户(${cacheKey})失败:`, error);
        return null;
      } finally {
        this.pendingUserRequests.delete(cacheKey);
      }
    })();

    this.pendingUserRequests.set(cacheKey, promise);
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
   * @method flushBuffers
   * @description 将所有内存中的缓冲区数据批量写入数据库。
   */
  private async flushBuffers() {
    const cmdBufferToFlush = Array.from(this.cmdStatBuffer.values());
    const msgBufferToFlush = Array.from(this.msgStatBuffer.values());
    const advancedBufferToFlush = this.oriCacheBuffer;
    this.cmdStatBuffer.clear();
    this.msgStatBuffer.clear();
    this.oriCacheBuffer = [];

    try {
      // 写入命令统计
      if (cmdBufferToFlush.length > 0) {
        await this.ctx.database.upsert('analyse_cmd', (row) =>
          cmdBufferToFlush.map(item => ({
            uid: item.uid,
            command: item.command,
            count: $.add($.ifNull(row.count, 0), item.count),
            timestamp: item.timestamp,
          }))
        );
      }

      // 写入消息统计
      if (msgBufferToFlush.length > 0) {
        await this.ctx.database.upsert('analyse_msg', (row) =>
          msgBufferToFlush.map(item => ({
            uid: item.uid,
            type: item.type,
            hour: item.hour,
            count: $.add($.ifNull(row.count, 0), item.count),
            timestamp: item.timestamp,
          }))
        );
      }

      // 写入原始消息记录
      if (advancedBufferToFlush.length > 0) await this.ctx.database.create('analyse_cache', advancedBufferToFlush as any);
    } catch (error) {
      this.ctx.logger.error('写入数据出错:', error);
    }
  }
}
