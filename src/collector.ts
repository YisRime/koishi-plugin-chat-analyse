import { Context, Session, Element } from 'koishi';

/**
 * @file collector.ts
 * @description 通过统一的事件监听器，持久化存储所有收到的消息和命令，并高效地维护用户/群组ID与名称的映射。
 */

// 扩展 Koishi 的 Tables 接口
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
      id: number;
      channelId: string;
      channelName: string;
      userId: string;
      userName: string;
    }
  }
}

/**
 * @class Collector
 * @description 核心收集器类。负责初始化数据库、监听消息、分类处理并持久化数据。
 */
export class Collector {
  /**
   * @property {Map<string, { name: string, timestamp: number }>} nameCache
   * @description 用户名缓存，键为“频道ID:用户ID”，值为名称和时间戳。
   */
  private nameCache = new Map<string, { name: string, timestamp: number }>();

  /**
   * @constructor
   * @param {Context} ctx Koishi 的上下文对象
   */
  constructor(private ctx: Context) {
    this.defineModels();

    ctx.on('message', async (session: Session) => {
      const { userId, channelId, guildId, content, timestamp, argv, elements } = session;
      const effectiveId = channelId || guildId;

      if (!effectiveId || !userId) return;

      this.updateNameIfNeeded(session, effectiveId);

      const isCommand = !!argv?.command;
      const type = isCommand
        ? argv.command.name
        : [...new Set(elements.map(e => `[${e.type}]`))].join('');

      const finalContent = isCommand ? content : this.sanitizeContent(elements);

      if (!finalContent?.trim()) return;

      await ctx.database.create('analyse_msg', {
        channelId: effectiveId,
        userId,
        type,
        content: finalContent,
        timestamp: new Date(timestamp),
      });
    });
  }

  /**
   * @private
   * @method defineModels
   * @description 初始化插件所需的两个数据表模型。
   */
  private defineModels() {
    this.ctx.model.extend('analyse_msg', {
      id: 'unsigned', channelId: 'string', userId: 'string', type: 'string', content: 'text', timestamp: 'timestamp',
    }, { autoInc: true, indexes: ['channelId', 'userId', 'type', 'timestamp'] });

    this.ctx.model.extend('analyse_name', {
      id: 'unsigned', channelId: 'string', channelName: 'string', userId: 'string', userName: 'string',
    }, { autoInc: true, unique: [['channelId', 'userId']] });
  }

  /**
   * @private
   * @method sanitizeContent
   * @description 将消息元素数组转换并清理为用于存储的字符串。
   * @param {Element[]} elements 消息元素数组
   * @returns {string} 清理后的消息内容
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
   * @private
   * @method updateNameIfNeeded
   * @description 检查并按需更新用户和频道的名称。
   * @param {Session} session 当前会话对象
   * @param {string} effectiveId 当前生效的频道/群组ID
   */
  private async updateNameIfNeeded(session: Session, effectiveId: string) {
    const { userId, guildId, bot } = session;
    const cacheKey = `${effectiveId}:${userId}`;
    const cached = this.nameCache.get(cacheKey);

    if (cached && (Date.now() - cached.timestamp < 86400000)) return;

    const [guild, member] = await Promise.all([
      bot.getGuild(guildId),
      bot.getGuildMember(guildId, userId),
    ]);

    const channelName = guild?.name;
    const userName = member?.nick || member?.name;

    if (!channelName || !userName) return;

    const [record] = await this.ctx.database.get('analyse_name', { channelId: effectiveId, userId });

    if (record?.userName === userName && record?.channelName === channelName) {
      this.nameCache.set(cacheKey, { name: userName, timestamp: Date.now() });
      return;
    }

    await this.ctx.database.upsert('analyse_name', [{
      channelId: effectiveId, channelName, userId, userName,
    }]);
    this.nameCache.set(cacheKey, { name: userName, timestamp: Date.now() });
  }
}
