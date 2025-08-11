import { Context, Command, $, h, Session, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config } from './index';

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
    if (this.config.enableRankStat && this.config.rankRetentionDays > 0) {
      this.ctx.cron('0 0 * * *', async () => {
        const cutoffDate = new Date(Date.now() - this.config.rankRetentionDays * Time.day);
        await this.ctx.database.remove('analyse_rank', { timestamp: { $lt: cutoffDate } })
          .catch(e => this.ctx.logger.error('清理发言排行记录失败:', e));
      });
    }
  }

  /**
   * @public @method registerCommands
   * @description 根据配置，动态地将子命令注册到主命令下。
   * @param cmd - 主命令实例。
   */
  public registerCommands(cmd: Command) {
    const createHandler = (handler: (scope: { uids?: number[]; error?: string; scopeDesc: { guildId?: string; userId?: string } }, options: any) => Promise<string | Buffer[]>) => {
      return async ({ session, options }) => {
        const scope = await this.parseQueryScope(session, options);
        if (scope.error) return scope.error;
        try {
          const result = await handler(scope, options);
          if (typeof result === 'string') return result;
          if (Array.isArray(result) && result.length > 0) {
            for (const buffer of result) await session.sendQueued(h.image(buffer, 'image/png'));
            return;
          }
        } catch (error) {
          this.ctx.logger.error('渲染统计图片失败:', error);
          return '图片渲染失败';
        }
      };
    };

    if (this.config.enableCmdStat) {
      cmd.subcommand('cmdstat', '命令统计')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('all', '-a 全局')
        .action(createHandler(async (scope) => {
          const stats = await this.ctx.database.select('analyse_cmd').where({ uid: { $in: scope.uids } }).groupBy('command', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();
          if (stats.length === 0) return '暂无统计数据';
          const total = stats.reduce((sum, record) => sum + record.count, 0);
          const list = stats.map(item => [item.command, item.count, item.lastUsed]);
          const title = await this.generateTitle(scope.scopeDesc, { main: '命令' });
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['命令', '次数', '最后使用']);
        }));
    }

    if (this.config.enableMsgStat) {
      cmd.subcommand('msgstat', '发言统计')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('type', '-t <type:string> 指定类型')
        .option('all', '-a 全局')
        .action(createHandler(async (scope, options) => {
          const { type } = options;
          const query: any = { uid: { $in: scope.uids } };
          if (type) query.type = type;

          const users = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));
          const stats = await this.ctx.database.select('analyse_msg').where(query).groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();

          if (stats.length === 0) return '暂无统计数据';
          const total = stats.reduce((sum, r) => sum + r.count, 0);
          const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);
          const title = await this.generateTitle(scope.scopeDesc, { main: '发言', subtype: type });
          const headers = type ? ['用户', '条数', '最后发言'] : ['用户', '总计发言', '最后发言'];
          return this.renderer.renderList({ title, time: new Date(), total, list }, headers);
        }));
    }

    if (this.config.enableRankStat) {
      cmd.subcommand('rankstat', '发言排行')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('type', '-t <type:string> 指定类型')
        .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
        .option('all', '-a 全局')
        .action(createHandler(async (scope, options) => {
          const { hours, type } = options;
          const since = new Date(Date.now() - hours * Time.hour);
          const query: any = { uid: { $in: scope.uids }, timestamp: { $gte: since } };
          if (type) query.type = type;

          const rankStats = await this.ctx.database.select('analyse_rank').where(query).groupBy('uid', { count: row => $.sum(row.count) }).orderBy('count', 'desc').execute();
          if (rankStats.length === 0) return '暂无统计数据';

          const users = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

          const total = rankStats.reduce((sum, record) => sum + record.count, 0);
          const list = rankStats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count]);
          const listWithPercentage = list.map(row => [...row, total > 0 ? `${((row[1] as number) / total * 100).toFixed(2)}%` : '0.00%']);
          const title = await this.generateTitle(scope.scopeDesc, { main: '发言排行', timeRange: hours, subtype: type });
          return this.renderer.renderList({ title, time: new Date(), total, list: listWithPercentage }, ['用户', '总计发言', '占比']);
        }));
    }

    if (this.config.enableActivity) {
      cmd.subcommand('activity', '活跃统计')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('all', '-a 全局')
        .action(createHandler(async (scope) => {
          const hourlyStats = await this.ctx.database.select('analyse_rank').where({ uid: { $in: scope.uids } }).groupBy(['timestamp'], { count: row => $.sum(row.count) }).execute();
          if (hourlyStats.length === 0) return '暂无统计数据';

          const hourlyCounts = Array(24).fill(0);
          let totalMessages = 0;
          hourlyStats.forEach(stat => {
            hourlyCounts[stat.timestamp.getHours()] += stat.count;
            totalMessages += stat.count;
          });

          const title = await this.generateTitle(scope.scopeDesc, { main: '活跃' });
          return this.renderer.renderCircadianChart({ title, time: new Date(), total: totalMessages, data: hourlyCounts });
        }));
    }
  }

  /**
   * @private @method parseQueryScope
   * @description 解析命令选项，转换为包含 UIDs 和描述性信息的统一查询范围对象。
   * @param session - 当前会话对象。
   * @param options - 命令选项。
   * @returns 包含 uids、错误或范围描述的查询范围对象。
   */
  private async parseQueryScope(session: Session, options: { user?: string; guild?: string; all?: boolean }): Promise<{ uids?: number[]; error?: string; scopeDesc: { guildId?: string; userId?: string } }> {
    const scopeDesc = { guildId: options.guild, userId: undefined };
    if (options.user) scopeDesc.userId = h.select(options.user, 'at')[0]?.attrs.id ?? options.user.trim();
    if (!options.all && !scopeDesc.guildId && !scopeDesc.userId) scopeDesc.guildId = session.guildId;
    if (!options.all && !scopeDesc.guildId && !scopeDesc.userId) return { error: '请指定查询范围', scopeDesc };

    const query: any = {};
    if (scopeDesc.guildId) query.channelId = scopeDesc.guildId;
    if (scopeDesc.userId) query.userId = scopeDesc.userId;
    if (Object.keys(query).length === 0) return { uids: undefined, scopeDesc };

    const users = await this.ctx.database.get('analyse_user', query, ['uid']);
    if (users.length === 0) return { error: '暂无统计数据', scopeDesc };

    return { uids: users.map(u => u.uid), scopeDesc };
  }

  /**
   * @private @method generateTitle
   * @description 根据查询范围和类型动态生成易于理解的图片标题。
   * @returns 生成的标题字符串。
   */
  private async generateTitle(scopeDesc: { guildId?: string, userId?: string }, options: { main: string; subtype?: string; timeRange?: number; }): Promise<string> {
    let guildName = '', userName = '', scopeText = '全局';

    if (scopeDesc.guildId) {
      const [guild] = await this.ctx.database.get('analyse_user', { channelId: scopeDesc.guildId }, ['channelName']);
      guildName = guild?.channelName || scopeDesc.guildId;
    }
    if (scopeDesc.userId) {
      const [user] = await this.ctx.database.get('analyse_user', { userId: scopeDesc.userId }, ['userName']);
      userName = user?.userName || scopeDesc.userId;
    }

    const typeText = options.subtype ? `“${options.subtype}”` : '';
    const mainText = options.main;

    if (mainText.includes('排行')) {
      scopeText = guildName || '全局';
      return `${options.timeRange}小时${scopeText}${typeText}${mainText}`;
    }

    if (userName && guildName) scopeText = `${guildName} ${userName}`;
    else if (userName) scopeText = userName;
    else if (guildName) scopeText = guildName;

    return `${scopeText}${typeText}${mainText}统计`;
  }
}
