import { Context, Command, $, h, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config, parseQueryScope, generateTitle } from './index';

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
        const scope = await parseQueryScope(this.ctx, session, options);
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
        .usage('查询命令统计，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('separate', '-h 分离展示')
        .option('all', '-a 全局')
        .action(createHandler(async (scope, options) => {
          const stats = await this.ctx.database.select('analyse_cmd').where({ uid: { $in: scope.uids } }).groupBy('command', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).orderBy('count', 'desc').execute();
          if (stats.length === 0) return '暂无统计数据';

          let processedStats;

          if (options.separate) {
            processedStats = stats;
          } else {
            const mergedStatsMap = new Map<string, { count: number; lastUsed: Date }>();
            for (const stat of stats) {
              const mainCommand = stat.command.split('.')[0];
              const existing = mergedStatsMap.get(mainCommand) || { count: 0, lastUsed: new Date(0) };
              existing.count += stat.count;
              if (stat.lastUsed > existing.lastUsed) existing.lastUsed = stat.lastUsed;
              mergedStatsMap.set(mainCommand, existing);
            }

            processedStats = Array.from(mergedStatsMap.entries()).map(([command, data]) => ({
              command,
              count: data.count,
              lastUsed: data.lastUsed,
            })).sort((a, b) => b.count - a.count);
          }

          const total = processedStats.reduce((sum, record) => sum + record.count, 0);
          const list = processedStats.map(item => [item.command, item.count, item.lastUsed]);
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '命令' });
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['命令', '次数', '最后使用']);
        }));
    }

    if (this.config.enableMsgStat) {
      cmd.subcommand('msgstat', '发言统计')
        .usage('查询发言统计，可指定查询范围，默认当前群组。')
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
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '发言', subtype: type });
          const headers = type ? ['用户', '条数', '最后发言'] : ['用户', '总计发言', '最后发言'];
          return this.renderer.renderList({ title, time: new Date(), total, list }, headers);
        }));
    }

    if (this.config.enableRankStat) {
      cmd.subcommand('rankstat', '发言排行')
        .usage('查询发言排行，可指定查询范围，默认当前群组。')
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
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '发言排行', timeRange: hours, subtype: type });
          return this.renderer.renderList({ title, time: new Date(), total, list: listWithPercentage }, ['用户', '总计发言', '占比']);
        }));
    }

    if (this.config.enableActivity) {
      cmd.subcommand('activity', '活跃统计')
        .usage('查询活跃统计，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('hours', '-h <hours:number> 指定偏移时长')
        .option('all', '-a 全局')
        .option('days', '-d 切换至天数')
        .action(createHandler(async (scope, options) => {
          const { days, hours } = options;

          if (days) {
            const timeRangeInDays = 24;
            const since = new Date(Date.now() - timeRangeInDays * Time.day);
            const stats = await this.ctx.database.select('analyse_rank')
              .where({ uid: { $in: scope.uids }, timestamp: { $gte: since } })
              .project(['timestamp', 'count'])
              .execute();

            if (stats.length === 0) return '暂无统计数据';

            const startOfToday = new Date();
            startOfToday.setHours(0, 0, 0, 0);
            const dailyCounts = Array(timeRangeInDays).fill(0);
            const dayLabels = Array(timeRangeInDays).fill('');

            for (let i = 0; i < timeRangeInDays; i++) {
              const d = new Date(startOfToday.getTime() - i * Time.day);
              dayLabels[timeRangeInDays - 1 - i] = String(d.getDate());
            }

            stats.forEach(stat => {
              const statDayStart = new Date(stat.timestamp);
              statDayStart.setHours(0, 0, 0, 0);
              const daysAgo = Math.round((startOfToday.getTime() - statDayStart.getTime()) / Time.day);

              if (daysAgo >= 0 && daysAgo < timeRangeInDays) {
                const index = timeRangeInDays - 1 - daysAgo;
                dailyCounts[index] += stat.count;
              }
            });
            const totalMessages = dailyCounts.reduce((a, b) => a + b, 0);

            const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '活跃', timeRange: timeRangeInDays, timeUnit: '天' });
            return this.renderer.renderCircadianChart({ title, time: new Date(), total: totalMessages, data: dailyCounts, labels: dayLabels });

          } else {
            const timeWindowHours = 24;
            const offsetHours = typeof hours === 'number' ? hours : 0;

            const now = new Date();
            const until = new Date(now.getTime() - offsetHours * Time.hour);
            const since = new Date(until.getTime() - timeWindowHours * Time.hour);

            const hourlyStats = await this.ctx.database.select('analyse_rank')
              .where({ uid: { $in: scope.uids }, timestamp: { $gte: since, $lt: until } })
              .groupBy('timestamp', { count: row => $.sum(row.count) })
              .execute();

            if (hourlyStats.length === 0) return '暂无统计数据';

            const processedCounts = Array(timeWindowHours).fill(0);
            const hourLabels = Array(timeWindowHours).fill('');

            for (let i = 0; i < timeWindowHours; i++) {
              const d = new Date(until.getTime() - (i + 1) * Time.hour);
              hourLabels[timeWindowHours - 1 - i] = String(d.getHours());
            }

            hourlyStats.forEach(stat => {
              const hoursBeforeUntil = Math.floor((until.getTime() - stat.timestamp.getTime()) / Time.hour);
              if (hoursBeforeUntil >= 0 && hoursBeforeUntil < timeWindowHours) {
                const index = timeWindowHours - 1 - hoursBeforeUntil;
                processedCounts[index] += stat.count;
              }
            });
            const totalMessages = processedCounts.reduce((a, b) => a + b, 0);

            const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '活跃', timeRange: timeWindowHours, timeUnit: '小时' });
            return this.renderer.renderCircadianChart({ title, time: new Date(), total: totalMessages, data: processedCounts, labels: hourLabels });
          }
        }));
    }
  }
}
