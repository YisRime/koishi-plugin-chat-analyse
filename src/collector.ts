import { Context, Session, Element, Tables, $, h, Time } from 'koishi';
import { Config } from './index';

// 扩展 Koishi 的数据表接口
declare module 'koishi' {
  interface Tables {
    analyse_user: { uid: number; channelId: string; userId: string; channelName: string; userName: string };
    analyse_cmd: { uid: number; command: string; count: number; timestamp: Date };
    analyse_msg: { uid: number; type: string; count: number; timestamp: Date };
    analyse_rank: { uid: number; type: string; count: number; timestamp: Date };
    analyse_cache: { id: number; uid: number; content: string; timestamp: Date };
    analyse_at: { id: number; uid: number; target: string; content: string; timestamp: Date };
  }
}

/** @interface UserCache - 定义用户缓存对象的结构。 */
interface UserCache { uid: number; userName: string; channelName: string; }

/**
 * @class Collector
 * @description 核心数据收集器。根据配置，高效地监听、收集、缓冲并持久化聊天数据。
 */
export class Collector {
  /** @property FLUSH_INTERVAL - 内存缓存区定时刷入数据库的间隔（毫秒）。 */
  private static readonly FLUSH_INTERVAL = Time.minute;
  /** @property BUFFER_THRESHOLD - 内存缓存区触发刷新的消息数量阈值。 */
  private static readonly BUFFER_THRESHOLD = 100;

  // 统一的数据缓冲区
  private msgStatBuffer = new Map<string, { uid: number; type: string; count: number; timestamp: Date }>();
  private rankStatBuffer = new Map<string, { uid: number; timestamp: Date; type: string; count: number }>();
  private cmdStatBuffer = new Map<string, { uid: number; command: string; count: number; timestamp: Date }>();
  private oriCacheBuffer: Omit<Tables['analyse_cache'], 'id'>[] = [];
  private whoAtBuffer: Omit<Tables['analyse_at'], 'id'>[] = [];

  private userCache = new Map<string, UserCache>();
  private pendingUserRequests = new Map<string, Promise<UserCache | null>>();
  private flushInterval: NodeJS.Timeout;

  /**
   * @param ctx - Koishi 的插件上下文。
   * @param config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    this.ctx.model.extend('analyse_user', { uid: 'unsigned', channelId: 'string', userId: 'string', channelName: 'string', userName: 'string' }, { primary: 'uid', autoInc: true, indexes: ['channelId', 'userId'] });
    this.ctx.model.extend('analyse_cmd', { uid: 'unsigned', command: 'string', count: 'unsigned', timestamp: 'timestamp' }, { primary: ['uid', 'command'] });
    this.ctx.model.extend('analyse_msg', { uid: 'unsigned', type: 'string', count: 'unsigned', timestamp: 'timestamp' }, { primary: ['uid', 'type'] });
    this.ctx.model.extend('analyse_rank', { uid: 'unsigned', type: 'string', count: 'unsigned', timestamp: 'timestamp' }, { primary: ['uid', 'timestamp', 'type'] });
    if (this.config.enableOriRecord) this.ctx.model.extend('analyse_cache', { id: 'unsigned', uid: 'unsigned', content: 'text', timestamp: 'timestamp' }, { primary: 'id', autoInc: true, indexes: ['uid', 'timestamp'] });
    if (this.config.enableWhoAt) this.ctx.model.extend('analyse_at', { id: 'unsigned', uid: 'unsigned', target: 'string', content: 'text', timestamp: 'timestamp' }, { primary: 'id', autoInc: true, indexes: ['target', 'uid'] });

    ctx.on('message', (session) => this.onMessage(session));
    this.flushInterval = setInterval(() => this.flushBuffers(), Collector.FLUSH_INTERVAL);
    ctx.on('dispose', () => {
      clearInterval(this.flushInterval);
      this.flushBuffers();
    });
  }

  /**
   * @private @method onMessage
   * @description 统一的消息事件处理器，解析消息并更新各类统计数据的缓冲区。
   * @param session - Koishi 的会话对象。
   */
  private async onMessage(session: Session) {
    const { userId, channelId, content, timestamp, argv, elements, bot } = session;
    if (!channelId || !userId || !content?.trim()) return;

    const cacheKey = `${channelId}:${userId}`;
    let user: UserCache | null;

    if (this.userCache.has(cacheKey)) {
      user = this.userCache.get(cacheKey)!;
    } else if (this.pendingUserRequests.has(cacheKey)) {
      user = await this.pendingUserRequests.get(cacheKey)!;
    } else {
      const promise = (async (): Promise<UserCache | null> => {
        try {
          const [dbUser] = await this.ctx.database.get('analyse_user', { channelId, userId });
          const currentUserName = session.username ?? '';
          const guild = await bot.getGuild(channelId).catch(() => null);
          const currentChannelName = guild?.name ?? '';

          if (dbUser) {
            if ((currentUserName && dbUser.userName !== currentUserName) || (currentChannelName && dbUser.channelName !== currentChannelName)) {
              await this.ctx.database.set('analyse_user', { uid: dbUser.uid }, { userName: currentUserName, channelName: currentChannelName });
              dbUser.userName = currentUserName;
              dbUser.channelName = currentChannelName;
            }
            this.userCache.set(cacheKey, dbUser);
            return dbUser;
          }

          const createdUser = await this.ctx.database.create('analyse_user', { channelId, userId, userName: currentUserName, channelName: currentChannelName });
          this.userCache.set(cacheKey, createdUser);
          return createdUser;
        } catch (error) {
          this.ctx.logger.error(`创建或获取用户(${cacheKey})失败:`, error);
          return null;
        } finally {
          this.pendingUserRequests.delete(cacheKey);
        }
      })();
      this.pendingUserRequests.set(cacheKey, promise);
      user = await promise;
    }

    if (!user) return;
    const { uid } = user;
    const messageTime = new Date(timestamp);

    // 更新指令统计
    if (argv?.command) {
      const key = `${uid}:${argv.command.name}`;
      const entry = this.cmdStatBuffer.get(key) ?? { uid, command: argv.command.name, count: 0, timestamp: messageTime };
      entry.count++;
      entry.timestamp = messageTime;
      this.cmdStatBuffer.set(key, entry);
    }

    const hourStart = new Date(messageTime.getFullYear(), messageTime.getMonth(), messageTime.getDate(), messageTime.getHours());

    // 更新消息类型和发言排行统计
    for (const type of new Set(elements.map(e => e.type))) {
      const msgKey = `${uid}:${type}`;
      const msgEntry = this.msgStatBuffer.get(msgKey) ?? { uid, type, count: 0, timestamp: messageTime };
      msgEntry.count++;
      msgEntry.timestamp = messageTime;
      this.msgStatBuffer.set(msgKey, msgEntry);

      const rankKey = `${uid}:${hourStart.toISOString()}:${type}`;
      const rankEntry = this.rankStatBuffer.get(rankKey) ?? { uid, timestamp: hourStart, type, count: 0 };
      rankEntry.count++;
      this.rankStatBuffer.set(rankKey, rankEntry);
    }

    // 更新@记录
    if (this.config.enableWhoAt) {
      const sanitizedContent = this.sanitizeContent(elements.filter(e => e.type !== 'at'));
      for (const atElement of elements.filter(e => e.type === 'at')) {
        const targetId = atElement.attrs.id;
        if (targetId && targetId !== userId) {
          this.whoAtBuffer.push({ uid, target: targetId, content: sanitizedContent, timestamp: messageTime });
        }
      }
    }

    // 缓存原始消息
    if (this.config.enableOriRecord) {
      this.oriCacheBuffer.push({ uid, content: this.sanitizeContent(elements), timestamp: messageTime });
      if (this.oriCacheBuffer.length >= Collector.BUFFER_THRESHOLD) await this.flushBuffers();
    }
  }

  /**
   * @private @method sanitizeContent
   * @description 将 Koishi 消息元素数组净化为纯文本字符串。
   * @param elements - 消息元素数组。
   * @returns 净化后的纯文本。
   */
  private sanitizeContent = (elements: Element[]): string => h.transform(elements, {
    text: (attrs) => attrs.content,
    img: (attrs) => attrs.summary === '[动画表情]' ? '[gif]' : '[img]',
    at: (attrs) => `[at:${attrs.id}]`,
  }, '').join('');

  /**
   * @private @method flushBuffers
   * @description 将所有内存中的数据缓冲区批量写入数据库，并清空缓冲区。
   */
  private async flushBuffers() {
    const buffers = {
      cmd: Array.from(this.cmdStatBuffer.values()),
      msg: Array.from(this.msgStatBuffer.values()),
      rank: Array.from(this.rankStatBuffer.values()),
      at: this.whoAtBuffer,
      cache: this.oriCacheBuffer,
    };

    this.cmdStatBuffer.clear();
    this.msgStatBuffer.clear();
    this.rankStatBuffer.clear();
    this.whoAtBuffer = [];
    this.oriCacheBuffer = [];

    try {
      if (buffers.cmd.length > 0) await this.ctx.database.upsert('analyse_cmd', (row) => buffers.cmd.map(item => ({ ...item, count: $.add($.ifNull(row.count, 0), item.count) })));
      if (buffers.msg.length > 0) await this.ctx.database.upsert('analyse_msg', (row) => buffers.msg.map(item => ({ ...item, count: $.add($.ifNull(row.count, 0), item.count) })));
      if (buffers.rank.length > 0) await this.ctx.database.upsert('analyse_rank', (row) => buffers.rank.map(item => ({ ...item, count: $.add($.ifNull(row.count, 0), item.count) })));
      if (buffers.at.length > 0) await this.ctx.database.upsert('analyse_at', buffers.at);
      if (buffers.cache.length > 0) await this.ctx.database.upsert('analyse_cache', buffers.cache);
    } catch (error) {
      this.ctx.logger.error('数据库刷写失败:', error);
    }
  }
}
