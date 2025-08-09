import { Context, Command, $, h, Element } from 'koishi';
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
   * @description 根据插件配置，动态地将 `.cmd`, `.msg`, `.rank` 子命令注册到主 `analyse` 命令下。
   * @param {Command} analyse - 主 `analyse` 命令实例。
   */
  public registerCommands(analyse: Command) {
    if (this.config.enableCmdStat) {
      analyse.subcommand('.cmd', '命令使用统计')
        .option('user', '-u [user:user] 指定用户')
        .option('guild', '-g [guildId:string] 指定群组')
        .usage('查询用户或群组的命令使用统计，默认展示全局统计。')
        .action(async ({ session, options }) => {
          const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
          let guildId = options.guild;

          if (!userId && !guildId && session.guildId) {
            guildId = session.guildId;
          } else if (!userId && !guildId && !session.guildId) {
            return '请指定查询范围';
          }

          try {
            const stats = await this.getCommandStats(guildId, userId);
            if (typeof stats === 'string') return stats;

            const title = await this.generateTitle(guildId, userId, { main: '命令' });
            const renderData: ListRenderData = {
              title, time: new Date(),
              total: stats.total,
              list: stats.list,
            };
            const headers = ['命令', '次数', '最后使用'];
            const result = await this.renderer.renderList(renderData, headers);
            return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
          } catch (error) {
            this.ctx.logger.error('渲染命令统计图片失败:', error);
            return '渲染命令统计图片失败';
          }
        });
    }

    if (this.config.enableMsgStat) {
      analyse.subcommand('.msg', '消息发送统计')
        .option('user', '-u [user:user] 指定用户')
        .option('guild', '-g [guildId:string] 指定群组')
        .option('type', '-t <type:string> 指定类型')
        .usage('查询用户或群组的消息发送统计，默认展示全局统计。')
        .action(async ({ session, options }) => {
          const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
          let guildId = options.guild;

          if (!userId && !guildId && !options.type && session.guildId) {
            guildId = session.guildId;
          } else if (!userId && !guildId && !session.guildId) {
            return '请指定查询范围';
          }

          try {
            if (options.type) {
              const stats = await this.getMessageStatsByType(options.type, guildId, userId);
              if (typeof stats === 'string') return stats;

              const title = await this.generateTitle(guildId, undefined, { main: '消息', subtype: options.type });
              const renderData: ListRenderData = {
                title, time: new Date(), total: stats.total, list: stats.list,
              };
              const headers = ['用户', '条数', '最后发言'];
              const result = await this.renderer.renderList(renderData, headers);
              return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;

            } else {
              const stats = await this.getMessageStats(guildId, userId);
              if (typeof stats === 'string') return stats;

              const title = await this.generateTitle(guildId, userId, { main: '消息' });
              const renderData: ListRenderData = {
                title, time: new Date(), total: stats.total, list: stats.list,
              };
              const headers = ['类型', '条数', '最后发言'];
              const result = await this.renderer.renderList(renderData, headers);
              return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
            }
          } catch (error) {
            this.ctx.logger.error('渲染消息统计图片失败:', error);
            return '渲染消息统计图片失败';
          }
        });
    }

    if (this.config.enableRankStat) {
      analyse.subcommand('.rank', '用户发言排行')
        .option('guild', '-g [guildId:string] 指定群组')
        .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
        .usage('查询用户或群组的用户发言排行，默认展示全局统计。')
        .action(async ({ session, options }) => {
          let guildId = options.guild;
          if (!guildId && session.guildId) guildId = session.guildId;
          if (!guildId) return '请指定查询范围';

          try {
            const stats = await this.getActiveUserStats(guildId, options.hours);
            if (typeof stats === 'string') return stats;

            const listWithPercentage: RenderListItem[] = stats.list.map(row => {
              const count = row[1] as number;
              const percentage = (stats.total > 0) ? `${(count / stats.total * 100).toFixed(2)}%` : '0.00%';
              return [...row, percentage];
            });

            const title = await this.generateTitle(guildId, undefined, { main: '排行', timeRange: options.hours });
            const renderData: ListRenderData = {
              title, time: new Date(), total: stats.total, list: listWithPercentage,
            };
            const headers = ['用户', '总计发言', '占比'];
            const result = await this.renderer.renderList(renderData, headers);
            return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
          } catch (error) {
            this.ctx.logger.error('渲染发言排行图片失败:', error);
            return '渲染发言排行图片失败';
          }
        });
    }
  }

  /**
   * @private
   * @async
   * @method generateTitle
   * @description 通用的标题生成器。根据查询参数和类型选项动态生成易于理解的图片标题。
   * @param {string} [guildId] - (可选) 查询的群组 ID。
   * @param {string} [userId] - (可选) 查询的用户 ID。
   * @param {object} options - 标题的配置选项。
   * @param {'命令' | '消息' | '排行'} options.main - 标题主类型。
   * @param {string} [options.subtype] - (可选) 消息类型的子类型。
   * @param {number} [options.timeRange] - (可选) 排行的时间范围（小时）。
   * @returns {Promise<string>} 生成的标题字符串。
   */
  private async generateTitle(guildId: string | undefined, userId: string | undefined, options: { main: '命令' | '消息' | '排行'; subtype?: string; timeRange?: number; }): Promise<string> {
    let scopeText: string;
    if (userId && guildId) {
      const user = await this.ctx.database.get('analyse_user', { channelId: guildId, userId }, ['userName']);
      const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
      const userName = user[0]?.userName || userId;
      const guildName = guild[0]?.channelName || guildId;
      scopeText = `${userName} 在 ${guildName}`;
    } else if (userId) {
      const user = await this.ctx.database.get('analyse_user', { userId }, ['userName']);
      const userName = user[0]?.userName || userId;
      scopeText = `${userName}的全局`;
    } else if (guildId) {
      const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
      scopeText = guild[0]?.channelName || guildId;
    } else {
      scopeText = '全局';
    }

    switch (options.main) {
      case '命令':
        return `${scopeText}的命令统计`;
      case '消息':
        if (options.subtype) return `${scopeText}的"${options.subtype}"消息统计`;
        return `${scopeText}的消息统计`;
      case '排行':
        return `${scopeText}的${options.timeRange}小时消息排行`;
      default:
        return scopeText;
    }
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
    if (users.length === 0) return '暂无目标用户统计数据';

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
   * @description 从数据库中获取并聚合所有消息类型的统计数据。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getMessageStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const userQuery: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) userQuery.channelId = guildId;
    if (userId) userQuery.userId = userId;

    const users = await this.ctx.database.get('analyse_user', userQuery, ['uid']);
    if (users.length === 0) return '暂无目标用户统计数据';

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

  /**
   * @private
   * @async
   * @method getMessageStatsByType
   * @description 按指定消息类型，从数据库中获取并聚合用户排行数据。
   * @param {string} type - 要查询的消息类型。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>}
   */
  private async getMessageStatsByType(type: string, guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const userQuery: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) userQuery.channelId = guildId;
    if (userId) userQuery.userId = userId;

    const users = await this.ctx.database.get('analyse_user', userQuery, ['uid', 'userName']);
    if (users.length === 0) return '暂无目标用户统计数据';

    const uids = users.map(u => u.uid);
    const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

    const aggregatedStats = await this.ctx.database.select('analyse_msg')
      .where({
        uid: { $in: uids },
        type: type,
      })
      .groupBy(['uid'], {
        count: (row) => $.sum(row.count),
        lastUsed: (row) => $.max(row.timestamp),
      })
      .orderBy('count', 'desc')
      .execute();

    if (aggregatedStats.length === 0) return `暂无统计数据`;

    const totalCount = aggregatedStats.reduce((sum, record) => sum + record.count, 0);
    const list: RenderListItem[] = aggregatedStats.map(item => [
      userNameMap.get(item.uid) || `UID ${item.uid}`,
      item.count,
      item.lastUsed,
    ]);

    return { list, total: totalCount };
  }

  /**
   * @private
   * @async
   * @method getActiveUserStats
   * @description 从数据库中获取并聚合活跃用户排行数据。
   * @param {string} guildId - 要查询的群组 ID。
   * @param {number} hours - 查询过去的小时数。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>}
   */
  private async getActiveUserStats(guildId: string, hours: number): Promise<{ list: RenderListItem[], total: number } | string> {
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const usersInGuild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['uid', 'userId', 'userName']);
    if (usersInGuild.length === 0) return '暂无用户统计数据';

    const uids = usersInGuild.map(u => u.uid);
    const userNameMap = new Map(usersInGuild.map(u => [u.uid, u.userName]));

    const aggregatedStats = await this.ctx.database.select('analyse_msg')
      .where({
        uid: { $in: uids },
        hour: { $gte: since }
      })
      .groupBy(['uid'], {
        count: (row) => $.sum(row.count),
      })
      .orderBy('count', 'desc')
      .limit(100)
      .execute();

    if (aggregatedStats.length === 0) return '暂无统计数据';

    const totalCount = aggregatedStats.reduce((sum, record) => sum + record.count, 0);
    const list: RenderListItem[] = aggregatedStats.map(item => [
      userNameMap.get(item.uid) || `UID ${item.uid}`,
      item.count,
    ]);

    return { list, total: totalCount };
  }
}
