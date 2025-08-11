import { Context, Command, $, h, Session, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config } from './index';

/** @interface QueryScopeOptions - 定义了查询命令的通用范围选项。 */
type QueryScopeOptions = { user?: string; guild?: string; all?: boolean };
/** @interface QueryScopeResult - 定义了解析范围选项后的结果。 */
type QueryScopeResult = { uids?: number[]; error?: string; scopeDesc: { guildId?: string; userId?: string } };

/**
 * @class Stat
 * @description 提供统一的统计查询服务。负责注册查询命令，从数据库获取数据，并调用渲染器生成图表。
 */
export class Stat {
  public renderer: Renderer;

  /**
   * @param ctx - Koishi 的插件上下文。
   * @param config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    this.renderer = new Renderer(ctx);
    // 仅在启用发言排行且设置了保留天数时，才设置定时清理任务
    if (this.config.enableRankStat && this.config.rankRetentionDays > 0) {
      this.ctx.cron('0 0 * * *', async () => {
        const cutoffDate = new Date(Date.now() - this.config.rankRetentionDays * Time.day);
        await this.ctx.database.remove('analyse_rank', { timestamp: { $lt: cutoffDate } })
          .catch(e => this.ctx.logger.error('清理发言排行历史记录失败:', e));
      });
    }
  }

  /**
   * @public @method registerCommands
   * @description 根据配置，动态地将子命令注册到主命令下。
   * @param cmd - 主命令实例。
   */
  public registerCommands(cmd: Command) {
    const createHandler = (handler: (scope: QueryScopeResult, options: any) => Promise<string | Buffer[]>) => {
      return async ({ session, options }) => {
        const scope = await this.parseQueryScope(session, options);
        if (scope.error) return scope.error;
        try {
          const result = await handler(scope, options);
          if (typeof result === 'string') return result;
          if (Array.isArray(result)) {
            if (result.length === 0) return '图片渲染失败';
            for (const buffer of result) await session.sendQueued(h.image(buffer, 'image/png'));
            return;
          }
          if (Buffer.isBuffer(result)) return h.image(result, 'image/png');
        } catch (error) {
          this.ctx.logger.error('渲染统计图片失败:', error);
          return '渲染统计图片失败';
        }
      };
    };

    if (this.config.enableCmdStat) cmd.subcommand('.cmd', '命令使用统计')
      .option('user', '-u <user:string> 指定用户')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('all', '-a 全局')
      .action(createHandler(async (scope) => {
        const stats = await this.ctx.database.select('analyse_cmd').where({ uid: { $in: scope.uids } }).groupBy('command', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();
        if (stats.length === 0) return '暂无匹配指令统计数据';
        const total = stats.reduce((sum, record) => sum + record.count, 0);
        const list = stats.map(item => [item.command, item.count, item.lastUsed]);
        const title = await this.generateTitle(scope.scopeDesc, { main: '命令使用' });
        return this.renderer.renderList({ title, time: new Date(), total, list }, ['命令', '次数', '最后使用']);
      }));

    if (this.config.enableMsgStat) cmd.subcommand('.msg', '消息发送统计')
      .option('user', '-u <user:string> 指定用户')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('type', '-t <type:string> 指定类型')
      .option('all', '-a 全局')
      .action(createHandler(async (scope, options) => {
        const type = options.type;
        if (type) {
          const users = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));
          const stats = await this.ctx.database.select('analyse_msg').where({ uid: { $in: scope.uids }, type }).groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();
          if (stats.length === 0) return `暂无“${type}”类型消息数据`;
          const total = stats.reduce((sum, r) => sum + r.count, 0);
          const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);

          const title = await this.generateTitle(scope.scopeDesc, { main: '消息', subtype: type });
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['用户', '条数', '最后发言']);
        } else {
          const users = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));
          const stats = await this.ctx.database.select('analyse_msg').where({ uid: { $in: scope.uids } }).groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();
          if (stats.length === 0) return '暂无消息数据';
          const total = stats.reduce((sum, r) => sum + r.count, 0);
          const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);

          const title = await this.generateTitle(scope.scopeDesc, { main: '消息发送' });
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['用户', '总计发言', '最后发言']);
        }
      }));

    if (this.config.enableRankStat) cmd.subcommand('.rank', '用户发言排行')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('type', '-t <type:string> 指定类型')
      .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
      .option('all', '-a 全局')
      .action(async ({ session, options }) => {
        const guildId = options.all ? undefined : (options.guild || session.guildId);
        if (!guildId && !options.all) return '请指定群组或查询全局';
        try {
          const { hours, type } = options;
          const since = new Date(Date.now() - hours * Time.hour);
          const baseQuery: any = { timestamp: { $gte: since } };
          if (type) baseQuery.type = type;

          const uidsInScope = guildId ? (await this.ctx.database.get('analyse_user', { channelId: guildId }, ['uid'])).map(u => u.uid) : undefined;
          if (guildId && uidsInScope.length === 0) return '暂无指定时段内发言记录';
          if (uidsInScope) baseQuery.uid = { $in: uidsInScope };

          const rankStats = await this.ctx.database.select('analyse_rank').where(baseQuery).groupBy('uid', { count: row => $.sum(row.count) }).orderBy('count', 'desc').execute();
          if (rankStats.length === 0) return '暂无指定时段内发言记录';

          const uids = rankStats.map(s => s.uid);
          const users = await this.ctx.database.get('analyse_user', { uid: { $in: uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

          const total = rankStats.reduce((sum, record) => sum + record.count, 0);
          const list = rankStats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count]);

          const listWithPercentage = list.map(row => [...row, total > 0 ? `${((row[1] as number) / total * 100).toFixed(2)}%` : '0.00%']);
          const title = await this.generateTitle({ guildId }, { main: '发言排行', timeRange: hours, subtype: type });
          const result = await this.renderer.renderList({ title, time: new Date(), total, list: listWithPercentage }, ['用户', '总计发言', '占比']);

          if (typeof result === 'string') return result;
          if (Array.isArray(result)) {
            if (result.length === 0) return '图片渲染失败';
            for (const buffer of result) await session.sendQueued(h.image(buffer, 'image/png'));
            return;
          }
        } catch (error) {
          this.ctx.logger.error('渲染发言排行图片失败:', error);
          return '渲染发言排行图片失败';
        }
      });

    if (this.config.enableActivityStat) cmd.subcommand('.activity', '用户活跃分析')
      .option('user', '-u <user:string> 指定用户')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('all', '-a 全局')
      .action(createHandler(async (scope) => {
        const hourlyStats = await this.ctx.database.select('analyse_rank')
            .where({ uid: { $in: scope.uids } })
            .groupBy(
                ['timestamp'],
                { count: row => $.sum(row.count) }
            )
            .execute();

        if (hourlyStats.length === 0) return '暂无消息数据';

        const hourlyCounts = Array(24).fill(0);
        let totalMessages = 0;

        hourlyStats.forEach(stat => {
            const hour = stat.timestamp.getHours();

            hourlyCounts[hour] = stat.count;
            totalMessages += stat.count;
        });

        const title = await this.generateTitle(scope.scopeDesc, { main: '活跃分析' });
        const result = await this.renderer.renderCircadianChart({
            title,
            time: new Date(),
            total: totalMessages,
            data: hourlyCounts,
        });

        return result;
      }));
  }

  /**
   * @private @method parseQueryScope
   * @description 解析命令选项，转换为包含 UIDs 和描述性信息的统一查询范围对象。
   * @param session - 当前会话对象。
   * @param options - 命令选项。
   * @returns 包含 uids、错误或范围描述的查询范围对象。
   */
  private async parseQueryScope(session: Session, options: QueryScopeOptions): Promise<QueryScopeResult> {
    const scopeDesc = { guildId: options.guild, userId: undefined };
    if (options.user) scopeDesc.userId = h.select(options.user, 'at')[0]?.attrs.id ?? options.user.trim();
    if (!options.all && !scopeDesc.guildId && !scopeDesc.userId) scopeDesc.guildId = session.guildId;
    if (!options.all && !scopeDesc.guildId) return { error: '请指定群组或查询全局', scopeDesc };

    const query: any = {};
    if (scopeDesc.guildId) query.channelId = scopeDesc.guildId;
    if (scopeDesc.userId) query.userId = scopeDesc.userId;

    const users = await this.ctx.database.get('analyse_user', query, ['uid']);
    if (users.length === 0) return { error: '在指定范围内未找到任何记录', scopeDesc };
    return { uids: users.map(u => u.uid), scopeDesc };
  }

  /**
   * @private @method generateTitle
   * @description 根据查询范围和类型动态生成易于理解的图片标题。
   * @returns 生成的标题字符串。
   */
  private async generateTitle(scopeDesc: { guildId?: string, userId?: string }, options: { main: string; subtype?: string; timeRange?: number; }): Promise<string> {
    let scopeText = '全局';
    if (scopeDesc.guildId) {
      const [guild] = await this.ctx.database.get('analyse_user', { channelId: scopeDesc.guildId }, ['channelName']);
      scopeText = guild?.channelName || scopeDesc.guildId;
    }
    if (scopeDesc.userId) {
      const [user] = await this.ctx.database.get('analyse_user', { userId: scopeDesc.userId }, ['userName']);
      const userName = user?.userName || scopeDesc.userId;
      scopeText = scopeDesc.guildId ? `${userName} 在 ${scopeText}` : `${userName} 的全局`;
    }

    const typeText = options.subtype ? `“${options.subtype}”` : '';
    if (options.main.includes('排行')) return `${scopeText}${options.timeRange}小时${typeText}消息排行`;
    return `${scopeText}${typeText}${options.main}统计`;
  }
}
