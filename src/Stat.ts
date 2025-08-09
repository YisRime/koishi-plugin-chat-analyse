import { Context, Command, $, h, Element, Session } from 'koishi';
import { Renderer, RenderListItem } from './Renderer';
import { Config } from './index';

// 定义内部类型，用于统一处理命令选项
type QueryScopeOptions = { user?: boolean | string; guild?: boolean | string; all?: boolean };
type QueryScopeResult = { userId?: string; guildId?: string; error?: string };

/**
 * @class Stat
 * @description 提供统一的统计查询服务。负责注册查询命令，从数据库获取数据，并调用渲染器生成图表。
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
   * @public
   * @method registerCommands
   * @description 根据插件配置，动态地将 `.cmd`, `.msg`, `.rank` 子命令注册到主 `analyse` 命令下。
   * @param {Command} analyse - 主 `analyse` 命令实例。
   */
  public registerCommands(analyse: Command) {
    if (this.config.enableCmdStat) {
      analyse.subcommand('.cmd', '命令使用统计')
        .option('user', '-u [user:user] 指定用户')
        .option('guild', '-g [guildId:string] 指定群组')
        .option('all', '-a 展示全局统计')
        .action(async ({ session, options }) => {
          const scope = this.parseQueryScope(session, options);
          if (scope.error) return scope.error;

          try {
            const stats = await this.getCommandStats(scope.guildId, scope.userId);
            if (typeof stats === 'string') return stats;

            const title = await this.generateTitle(scope.guildId, scope.userId, { main: '命令' });
            const renderData = { title, time: new Date(), total: stats.total, list: stats.list };
            const result = await this.renderer.renderList(renderData, ['命令', '次数', '最后使用']);
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
        .option('all', '-a 展示全局统计')
        .action(async ({ session, options }) => {
          const scope = this.parseQueryScope(session, options);
          if (scope.error) return scope.error;
          try {
            if (options.type) {
              const stats = await this.getMessageStatsByType(options.type, scope.guildId, scope.userId);
              if (typeof stats === 'string') return stats;
              const title = await this.generateTitle(scope.guildId, scope.userId, { main: '消息', subtype: options.type });
              const renderData = { title, time: new Date(), total: stats.total, list: stats.list };
              const result = await this.renderer.renderList(renderData, ['用户', '条数', '最后发言']);
              return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;
            } else {
              const stats = await this.getUserMessageStats(scope.guildId, scope.userId);
              if (typeof stats === 'string') return stats;
              const title = await this.generateTitle(scope.guildId, scope.userId, { main: '消息' });
              const renderData = { title, time: new Date(), total: stats.total, list: stats.list };
              const result = await this.renderer.renderList(renderData, ['用户', '总计发言', '最后发言']);
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
        .option('all', '-a 展示全局统计')
        .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
        .action(async ({ session, options }) => {
          let guildId = options.all ? undefined : (typeof options.guild === 'string' ? options.guild : session.guildId);
          if (!session.guildId) return '请指定群组 ID';
          if (!guildId && !options.all) return '请提供查询范围';

          try {
            const stats = await this.getActiveUserStats(options.hours, guildId);
            if (typeof stats === 'string') return stats;

            const listWithPercentage = stats.list.map(row => [
              ...row,
              stats.total > 0 ? `${((row[1] as number) / stats.total * 100).toFixed(2)}%` : '0.00%',
            ]);
            const title = await this.generateTitle(guildId, undefined, { main: '排行', timeRange: options.hours });
            const renderData = { title, time: new Date(), total: stats.total, list: listWithPercentage };
            const result = await this.renderer.renderList(renderData, ['用户', '总计发言', '占比']);
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
   * @method parseQueryScope
   * @description 解析命令的选项，将其转换为统一的查询范围对象（userId 和 guildId）。
   * @param {Session} session - 当前会话对象。
   * @param {QueryScopeOptions} options - 命令传入的选项。
   * @returns {QueryScopeResult} 包含 userId、guildId 或 error 信息的查询范围对象。
   */
  private parseQueryScope(session: Session, options: QueryScopeOptions): QueryScopeResult {
    let userId: string, guildId: string;
    if (typeof options.user === 'string') userId = h.select(options.user, 'user')[0]?.attrs.id;
    else if (options.user) userId = session.userId;

    if (typeof options.guild === 'string') guildId = options.guild;
    else if (options.guild) {
      if (!session.guildId) return { error: '请指定群组 ID' };
      guildId = session.guildId;
    }

    if (options.all) return { userId, guildId: undefined };
    if (!guildId && !userId) return session.guildId ? { guildId: session.guildId } : { error: '请提供查询范围' };
    return { userId, guildId };
  }

  /**
   * @private
   * @async
   * @method getUidsInScope
   * @description 根据查询范围（guildId, userId）获取匹配用户的 UID 列表。
   * @param {string} [guildId] - (可选) 群组 ID。
   * @param {string} [userId] - (可选) 用户 ID。
   * @returns {Promise<{ uids?: number[], error?: string }>} 包含 UID 数组或错误信息的对象。
   */
  private async getUidsInScope(guildId?: string, userId?: string): Promise<{ uids?: number[], error?: string }> {
    const query: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) query.channelId = guildId;
    if (userId) query.userId = userId;

    const users = await this.ctx.database.get('analyse_user', query, ['uid']);
    if (users.length === 0) return { error: '暂无统计数据' };
    return { uids: users.map(u => u.uid) };
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
  private async generateTitle(guildId: string, userId: string, options: { main: '命令' | '消息' | '排行'; subtype?: string; timeRange?: number; }): Promise<string> {
    let scopeText = '全局';
    if (userId && guildId) {
      const user = await this.ctx.database.get('analyse_user', { channelId: guildId, userId }, ['userName']);
      const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
      scopeText = `${user[0]?.userName || userId} 在 ${guild[0]?.channelName || guildId}`;
    } else if (userId) {
      const user = await this.ctx.database.get('analyse_user', { userId }, ['userName']);
      scopeText = `${user[0]?.userName || userId}的全局`;
    } else if (guildId) {
      const guild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['channelName']);
      scopeText = guild[0]?.channelName || guildId;
    }

    if (options.main === '排行') return `${scopeText}的${options.timeRange}小时消息排行`;
    if (options.main === '消息' && options.subtype) return `${scopeText}的"${options.subtype}"消息统计`;
    return `${scopeText}的${options.main}统计`;
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
    const { uids, error } = await this.getUidsInScope(guildId, userId);
    if (error) return error;

    const stats = await this.ctx.database.select('analyse_cmd').where({ uid: { $in: uids } })
      .groupBy('command', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) })
      .orderBy('count', 'desc').execute();
    if (stats.length === 0) return '暂无统计数据';

    const total = stats.reduce((sum, record) => sum + record.count, 0);
    const list = stats.map(item => [item.command, item.count, item.lastUsed]);
    return { list, total };
  }

  /**
   * @private
   * @async
   * @method getUserMessageStats
   * @description 从数据库中获取并聚合每个用户的消息统计数据。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getUserMessageStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const query: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) query.channelId = guildId;
    if (userId) query.userId = userId;
    const users = await this.ctx.database.get('analyse_user', query, ['uid', 'userName']);
    if (users.length === 0) return '暂无统计数据';

    const uids = users.map(u => u.uid);
    const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

    const stats = await this.ctx.database.select('analyse_msg').where({ uid: { $in: uids } })
      .groupBy('uid', {
        count: row => $.sum(row.count),
        lastUsed: row => $.max(row.timestamp)
      })
      .orderBy('count', 'desc').execute();
    if (stats.length === 0) return '暂无统计数据';

    const total = stats.reduce((sum, record) => sum + record.count, 0);
    const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);
    return { list, total };
  }

  /**
   * @private
   * @async
   * @method getMessageStatsByType
   * @description 按指定消息类型，从数据库中获取并聚合用户排行数据。
   * @param {string} type - 要查询的消息类型。
   * @param {string} [guildId] - (可选) 若提供，则将范围限制在此群组。
   * @param {string} [userId] - (可选) 若提供，则将范围限制在此用户。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getMessageStatsByType(type: string, guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const query: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) query.channelId = guildId;
    if (userId) query.userId = userId;
    const users = await this.ctx.database.get('analyse_user', query, ['uid', 'userName']);
    if (users.length === 0) return '暂无统计数据';

    const uids = users.map(u => u.uid);
    const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

    const stats = await this.ctx.database.select('analyse_msg').where({ uid: { $in: uids }, type })
      .groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) })
      .orderBy('count', 'desc').execute();
    if (stats.length === 0) return `暂无统计数据`;

    const total = stats.reduce((sum, record) => sum + record.count, 0);
    const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);
    return { list, total };
  }

  /**
   * @private
   * @async
   * @method getActiveUserStats
   * @description 从数据库中获取并聚合指定时间范围内的活跃用户排行数据。
   * @param {number} hours - 查询过去的小时数。
   * @param {string} [guildId] - (可选) 要查询的群组 ID。若不提供，则进行全局排行。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 返回一个包含列表和总数的对象，或在无数据时返回提示字符串。
   */
  private async getActiveUserStats(hours: number, guildId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const since = new Date(Date.now() - hours * 3600 * 1000);

    if (guildId) {
      const usersInGuild = await this.ctx.database.get('analyse_user', { channelId: guildId }, ['uid', 'userName']);
      if (usersInGuild.length === 0) return '暂无统计数据';
      const uids = usersInGuild.map(u => u.uid);
      const userNameMap = new Map(usersInGuild.map(u => [u.uid, u.userName]));

      const stats = await this.ctx.database.select('analyse_msg').where({ uid: { $in: uids }, hour: { $gte: since } })
        .groupBy('uid', { count: row => $.sum(row.count) }).orderBy('count', 'desc').limit(100).execute();
      if (stats.length === 0) return '暂无统计数据';

      const total = stats.reduce((sum, record) => sum + record.count, 0);
      const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count]);
      return { list, total };
    } else {
      const msgStats = await this.ctx.database.select('analyse_msg').where({ hour: { $gte: since } }).project(['uid', 'count']).execute();
      if (msgStats.length === 0) return '暂无统计数据';
      const allUsers = await this.ctx.database.get('analyse_user', {}, ['uid', 'userId', 'userName']);
      const uidToUserMap = new Map(allUsers.map(u => [u.uid, { userId: u.userId, userName: u.userName }]));

      const userCounts = new Map<string, { count: number, name: string }>();
      for (const msg of msgStats) {
        const userInfo = uidToUserMap.get(msg.uid);
        if (userInfo) {
          const existing = userCounts.get(userInfo.userId);
          userCounts.set(userInfo.userId, { count: (existing?.count || 0) + msg.count, name: userInfo.userName });
        }
      }
      if (userCounts.size === 0) return '暂无统计数据';

      const grandTotal = Array.from(userCounts.values()).reduce((sum, data) => sum + data.count, 0);
      const sortedUsers = Array.from(userCounts.entries()).sort(([, a], [, b]) => b.count - a.count).slice(0, 100);
      const list = sortedUsers.map(([userId, data]) => [data.name || userId, data.count]);
      return { list, total: grandTotal };
    }
  }
}
