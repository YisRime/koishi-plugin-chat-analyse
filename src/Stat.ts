import { Context, Command, $, h, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config, generateTitle } from './index';

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
   * @private @method parseScope
   * @description 根据选项解析查询范围，返回 uids 和范围描述
   */
  private async parseScope(session: any, options: any): Promise<{ uids?: number[]; error?: string; scopeDesc: { guildId?: string; userId?: string } }> {
    const scopeDesc = { guildId: undefined, userId: undefined };
    const query: any = {};
    if (options.all) return { uids: undefined, scopeDesc };
    if (options.user) scopeDesc.userId = h.select(options.user, 'at')[0]?.attrs.id ?? options.user.trim();
    if (options.guild) scopeDesc.guildId = options.guild;
    if (!scopeDesc.guildId && !scopeDesc.userId) scopeDesc.guildId = session.guildId;
    if (!scopeDesc.guildId && !scopeDesc.userId) return { error: '请指定查询范围', scopeDesc };
    if (scopeDesc.guildId) query.channelId = scopeDesc.guildId;
    if (scopeDesc.userId) query.userId = scopeDesc.userId;
    const users = await this.ctx.database.get('analyse_user', query, ['uid']);
    if (users.length === 0) return { error: '暂无统计数据', scopeDesc };
    return { uids: users.map(u => u.uid), scopeDesc };
  }


  /**
   * @public @method registerCommands
   * @description 根据配置，动态地将子命令注册到主命令下。
   * @param cmd - 主命令实例。
   */
  public registerCommands(cmd: Command) {
    const handleAction = async (session: any, promise: Promise<string | AsyncGenerator<Buffer>>) => {
      try {
        const result = await promise;
        if (typeof result === 'string') return result;
        for await (const buffer of result) await session.send(h.image(buffer, 'image/png'));
      } catch (error) {
        this.ctx.logger.error('图片渲染失败:', error);
        return '图片渲染失败';
      }
    };

    if (this.config.enableCmdStat) {
      cmd.subcommand('cmdstat', '命令统计')
        .usage('查询命令统计，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('separate', '-p 分离子命令')
        .option('sortByTime', '-s 以时间排序')
        .option('all', '-a 全局统计')
        .action(({ session, options }) => handleAction(session, (async () => {
          const scope = await this.parseScope(session, options);
          if (scope.error) return scope.error;
          const query: any = scope.uids ? { uid: { $in: scope.uids } } : {};
          const stats = await this.ctx.database.select('analyse_cmd').where(query).groupBy('command', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).execute();
          if (stats.length === 0) return '暂无统计数据';
          let processedStats;
          if (options.separate) {
            processedStats = stats;
          } else {
            const merged = new Map<string, { count: number; lastUsed: Date }>();
            for (const stat of stats) {
              const mainCmd = stat.command.split('.')[0];
              const existing = merged.get(mainCmd) || { count: 0, lastUsed: new Date(0) };
              existing.count += stat.count;
              if (stat.lastUsed > existing.lastUsed) existing.lastUsed = stat.lastUsed;
              merged.set(mainCmd, existing);
            }
            processedStats = Array.from(merged.entries()).map(([command, data]) => ({ ...data, command }));
          }
          if (options.sortByTime) {
            processedStats.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
          } else {
            processedStats.sort((a, b) => b.count - a.count);
          }
          const total = processedStats.reduce((sum, r) => sum + r.count, 0);
          const list = processedStats.map(item => [item.command, item.count, item.lastUsed]);
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '命令' });
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['命令', '次数', '最后使用']);
        })()));
    }

    if (this.config.enableMsgStat) {
      cmd.subcommand('msgstat', '发言统计')
        .usage('查询发言统计，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('type', '-t <type:string> 指定类型')
        .option('sortByTime', '-s 以时间排序')
        .option('all', '-a 全局统计')
        .action(({ session, options }) => handleAction(session, (async () => {
          const scope = await this.parseScope(session, options);
          if (scope.error) return scope.error;
          const query: any = scope.uids ? { uid: { $in: scope.uids } } : {};
          if (options.type) query.type = options.type;
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '发言', subtype: options.type });
          const applySort = (stats: any[]) => {
            if (options.sortByTime) {
              stats.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
            } else {
              stats.sort((a, b) => b.count - a.count);
            }
          };
          if (options.user && options.guild) {
            const stats = await this.ctx.database.select('analyse_msg').where(query).groupBy('type', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).execute();
            if (stats.length === 0) return '暂无统计数据';
            applySort(stats);
            const total = stats.reduce((sum, r) => sum + r.count, 0);
            const list = stats.map(item => [item.type, item.count, item.lastUsed]);
            return this.renderer.renderList({ title, time: new Date(), total, list }, ['类型', '条数', '最后发言']);
          }
          if (options.user) {
            const userRecords = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } });
            const uidToChannelMap = new Map(userRecords.map(u => [u.uid, u.channelName || u.channelId]));
            const stats = await this.ctx.database.select('analyse_msg').where(query).groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).execute();
            if (stats.length === 0) return '暂无统计数据';
            applySort(stats);
            const total = stats.reduce((sum, r) => sum + r.count, 0);
            const list = stats.map(item => [uidToChannelMap.get(item.uid) || `未知群组`, item.count, item.lastUsed]);
            return this.renderer.renderList({ title, time: new Date(), total, list }, ['群组', '条数', '最后发言']);
          }
          const stats = await this.ctx.database.select('analyse_msg').where(query).groupBy('uid', { count: row => $.sum(row.count), lastUsed: row => $.max(row.timestamp) }).execute();
          if (stats.length === 0) return '暂无统计数据';
          applySort(stats);
          const allUids = stats.map(s => s.uid);
          const userNameMap = new Map<number, string>();
          const BATCH_SIZE = 4096;
          for (let i = 0; i < allUids.length; i += BATCH_SIZE) {
            const batchUids = allUids.slice(i, i + BATCH_SIZE);
            const users = await this.ctx.database.get('analyse_user', { uid: { $in: batchUids } }, ['uid', 'userName']);
            for (const user of users) {
              userNameMap.set(user.uid, user.userName);
            }
          }
          const total = stats.reduce((sum, r) => sum + r.count, 0);
          const list = stats.map(item => [userNameMap.get(item.uid) || `UID ${item.uid}`, item.count, item.lastUsed]);
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['用户', '条数', '最后发言']);
        })()));
    }

    if (this.config.enableRankStat) {
      cmd.subcommand('rankstat', '发言排行')
        .usage('查询发言排行，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('type', '-t <type:string> 指定类型')
        .option('duration', '-n <hours:number> 指定时长', { fallback: 24 })
        .option('offset', '-o <hours:number> 指定偏移', { fallback: 0 })
        .option('all', '-a 全局统计')
        .action(({ session, options }) => handleAction(session, (async () => {
          const scope = await this.parseScope(session, options);
          if (scope.error) return scope.error;
          const until = new Date(Date.now() - options.offset * Time.hour);
          const since = new Date(until.getTime() - options.duration * Time.hour);
          const query: any = { timestamp: { $gte: since, $lt: until } };
          if (scope.uids) query.uid = { $in: scope.uids };
          if (options.type) query.type = options.type;
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '发言排行', timeRange: options.duration, subtype: options.type });
          if (options.user && options.guild) {
            const stats = await this.ctx.database.select('analyse_rank').where(query).groupBy('type', { count: row => $.sum(row.count) }).orderBy('count', 'desc').execute();
            if (stats.length === 0) return '暂无统计数据';
            const total = stats.reduce((sum, r) => sum + r.count, 0);
            const list = stats.map(r => [r.type, r.count, total > 0 ? `${(r.count / total * 100).toFixed(2)}%` : '0.00%']);
            return this.renderer.renderList({ title, time: new Date(), total, list }, ['类型', '条数', '占比']);
          }
          if (options.user) {
            const userRecords = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } });
            const uidToChannelMap = new Map(userRecords.map(u => [u.uid, u.channelName || u.channelId]));
            const stats = await this.ctx.database.select('analyse_rank').where(query).groupBy('uid', { count: row => $.sum(row.count) }).orderBy('count', 'desc').execute();
            if (stats.length === 0) return '暂无统计数据';
            const total = stats.reduce((sum, r) => sum + r.count, 0);
            const list = stats.map(r => [uidToChannelMap.get(r.uid) || '未知群组', r.count, total > 0 ? `${(r.count / total * 100).toFixed(2)}%` : '0.00%']);
            return this.renderer.renderList({ title, time: new Date(), total, list }, ['群组', '条数', '占比']);
          }
          const stats = await this.ctx.database.select('analyse_rank').where(query).groupBy('uid', { count: row => $.sum(row.count) }).orderBy('count', 'desc').execute();
          if (stats.length === 0) return '暂无统计数据';
          const allUids = stats.map(s => s.uid);
          const userNameMap = new Map<number, string>();
          const BATCH_SIZE = 4096;
          for (let i = 0; i < allUids.length; i += BATCH_SIZE) {
            const batchUids = allUids.slice(i, i + BATCH_SIZE);
            const users = await this.ctx.database.get('analyse_user', { uid: { $in: batchUids } }, ['uid', 'userName']);
            for (const user of users) {
              userNameMap.set(user.uid, user.userName);
            }
          }
          const total = stats.reduce((sum, r) => sum + r.count, 0);
          const list = stats.map(r => [userNameMap.get(r.uid) || `UID ${r.uid}`, r.count, total > 0 ? `${(r.count / total * 100).toFixed(2)}%` : '0.00%']);
          return this.renderer.renderList({ title, time: new Date(), total, list }, ['用户', '条数', '占比']);
        })()));
    }

    if (this.config.enableActivity) {
      cmd.subcommand('activity', '活跃统计')
        .usage('查询活跃统计，可指定查询范围，默认当前群组。')
        .option('user', '-u <user:string> 指定用户')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('duration', '-n <units:number> 指定时长', { fallback: 24 })
        .option('offset', '-o <units:number> 指定偏移', { fallback: 0 })
        .option('days', '-d 以天为粒度')
        .option('all', '-a 全局统计')
        .action(({ session, options }) => handleAction(session, (async () => {
          const scope = await this.parseScope(session, options);
          if (scope.error) return scope.error;
          const timeUnit = options.days ? Time.day : Time.hour;
          const timeUnitName = options.days ? '天' : '小时';
          const points = options.days ? 24 : 24;
          const until = new Date(Date.now() - options.offset * timeUnit);
          const since = new Date(until.getTime() - options.duration * timeUnit);
          const query: any = { timestamp: { $gte: since, $lt: until } };
          if (scope.uids) query.uid = { $in: scope.uids };
          const stats = await this.ctx.database.select('analyse_rank').where(query).project(['timestamp', 'count']).execute();
          if (stats.length === 0) return '暂无统计数据';
          const counts = Array(points).fill(0);
          const labels = Array(points).fill('');
          const now = new Date();
          now.setMinutes(0, 0, 0);
          for (let i = 0; i < points; i++) {
              const pointTime = new Date(until.getTime() - (i + 1) * timeUnit);
              labels[points - 1 - i] = options.days
                  ? String(pointTime.getDate())
                  : String(pointTime.getHours());
          }
          stats.forEach(stat => {
            const diff = until.getTime() - stat.timestamp.getTime();
            const index = points - 1 - Math.floor(diff / timeUnit);
            if (index >= 0 && index < points) {
              counts[index] += stat.count;
            }
          });
          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '活跃', timeRange: options.duration, timeUnit: timeUnitName });
          const series = [{ name: '活跃度', data: counts }];
          return this.renderer.renderLineChart({ title, time: new Date(), series, labels });
        })()));
    }
  }
}
