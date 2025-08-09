import { Context, Session, Command, $, h, Element } from 'koishi';
import { Renderer, ListRenderData, RenderListItem } from './Renderer';
import { Config } from './index';

/**
 * @class Stat
 * @description 提供统一的统计查询服务。它负责注册查询命令，根据用户输入从数据库中获取数据，并调用渲染器生成统计图表。
 */
export class Stat {
  public renderer: Renderer;

  /**
   * @constructor
   * @param {Context} ctx - Koishi 的插件上下文。
   * @param {Config} config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    this.renderer = new Renderer(ctx);
  }

  /**
   * @method registerCommands
   * @description 根据插件配置，动态地将 `.command` 和 `.message` 子命令注册到主 `analyse` 命令下。
   * @param {Command} analyse - 主 `analyse` 命令实例。
   */
  public registerCommands(analyse: Command) {
    if (this.config.enableCmdStat) {
      analyse.subcommand('.command', '命令使用统计')
        .option('user', '-u [user:user] 查看指定用户的统计')
        .option('guild', '-g [guildId:string] 查看指定群组的统计 (默认当前群)')
        .usage('查询命令使用统计。支持按用户、按群组或组合查询。')
        .action(async ({ session, options }) => {
          const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
          let guildId = options.guild;

          if (options.guild === '' && !options.user) {
            if (!session.guildId) return '私聊中请使用 -g <群组ID> 指定群组。';
            guildId = session.guildId;
          }

          try {
            const stats = await this.getCommandStats(guildId, userId);
            if (typeof stats === 'string') return stats;

            const title = await this._generateTitle(session, guildId, userId, '命令');
            const renderData: ListRenderData = {
              title, time: new Date(),
              total: stats.total,
              list: stats.list,
            };
            const headers = ['命令', '次数', '上次使用'];
            const result = await this.renderer.renderList(renderData, headers);
            return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
          } catch (error) {
            this.ctx.logger.error('渲染命令统计图片失败:', error);
            return '渲染命令统计图片失败';
          }
        });
    }

    if (this.config.enableMsgStat) {
        analyse.subcommand('.message', '消息类型统计')
          .option('user', '-u [user:user] 查看指定用户的统计')
          .option('guild', '-g [guildId:string] 查看指定群组的统计 (默认当前群)')
          .usage('查询消息类型统计。支持按用户、按群组或组合查询。')
          .action(async ({ session, options }) => {
            const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
            let guildId = options.guild;

            if (options.guild === '' && !options.user) {
              if (!session.guildId) return '私聊中请使用 -g <群组ID> 指定群组。';
              guildId = session.guildId;
            }

            try {
              const stats = await this.getMessageStats(guildId, userId);
              if (typeof stats === 'string') return stats;

              const title = await this._generateTitle(session, guildId, userId, '消息');
              const renderData: ListRenderData = {
                title,
                time: new Date(),
                total: stats.total,
                list: stats.list,
              };
              const headers = ['消息类型', '条数', '上次发送'];
              const result = await this.renderer.renderList(renderData, headers);
              return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
            } catch (error) {
              this.ctx.logger.error('渲染消息统计图片失败:', error);
              return '渲染消息统计图片失败';
            }
          });
    }
  }

  /**
   * @private
   * @async
   * @method _generateTitle
   * @description 通用的标题生成器。根据查询参数 (guildId, userId) 和统计类型动态生成易于理解的图片标题。
   * @param {Session} session - 当前会话，备用。
   * @param {string} [guildId] - (可选) 查询的群组 ID。
   * @param {string} [userId] - (可选) 查询的用户 ID。
   * @param {'命令' | '消息'} type - 统计类型，用于嵌入标题文本中。
   * @returns {Promise<string>} 生成的标题字符串。
   */
  private async _generateTitle(session: Session, guildId: string | undefined, userId: string | undefined, type: '命令' | '消息'): Promise<string> {
    if (userId && guildId) {
        const user = await this.ctx.database.get('analyse_user', { channelId: guildId, userId }, ['userName']);
        const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
        const userName = user[0]?.userName || userId;
        const guildName = guild[0]?.channelName || guildId;
        return `${userName} 在 ${guildName} 的${type}统计`;
    }
    if (userId) {
        const user = await this.ctx.database.get('analyse_user', { userId }, ['userName']);
        const userName = user[0]?.userName || userId;
        return `${userName} 的全局${type}统计`;
    }
    if (guildId) {
        const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
        const guildName = guild[0]?.channelName || guildId;
        return `${guildName} 的${type}统计`;
    }
    return `全局${type}统计`;
  }

  /**
   * @private
   * @async
   * @method getCommandStats
   * @description 从数据库中获取并聚合命令使用统计数据。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getCommandStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const userQuery: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) userQuery.channelId = guildId;
    if (userId) userQuery.userId = userId;

    const users = await this.ctx.database.get('analyse_user', userQuery, ['uid']);
    if (users.length === 0) return '暂无目标用户的统计数据';

    const uids = users.map(u => u.uid);

    const aggregatedStats = await this.ctx.database.select('analyse_cmd')
      .where({ uid: { $in: uids } })
      .groupBy(['command'], {
        count: (row) => $.sum(row.count),
        lastUsed: (row) => $.max(row.timestamp),
      })
      .orderBy('count', 'desc')
      .execute();

    if (aggregatedStats.length === 0) return '暂无统计数据';

    const totalCount = aggregatedStats.reduce((sum, record) => sum + record.count, 0);
    const list: RenderListItem[] = aggregatedStats.map(item => [item.command, item.count, item.lastUsed]);

    return { list, total: totalCount };
  }

  /**
   * @private
   * @async
   * @method getMessageStats
   * @description 从数据库中获取并聚合消息类型统计数据。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getMessageStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const userQuery: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) userQuery.channelId = guildId;
    if (userId) userQuery.userId = userId;

    const users = await this.ctx.database.get('analyse_user', userQuery, ['uid']);
    if (users.length === 0) return '暂无目标用户的统计数据';

    const uids = users.map(u => u.uid);

    const aggregatedStats = await this.ctx.database.select('analyse_msg')
      .where({ uid: { $in: uids } })
      .groupBy(['type'], {
        count: (row) => $.sum(row.count),
        lastUsed: (row) => $.max(row.timestamp),
      })
      .orderBy('count', 'desc')
      .execute();

    if (aggregatedStats.length === 0) return '暂无统计数据';

    const totalCount = aggregatedStats.reduce((sum, record) => sum + record.count, 0);
    const list: RenderListItem[] = aggregatedStats.map(item => [item.type, item.count, item.lastUsed]);

    return { list, total: totalCount };
  }
}
