import { Context, Command, h, Time } from 'koishi';
import {} from 'koishi-plugin-cron';
import { Config } from './index';

/**
 * @class WhoAt
 * @description
 * 负责处理与“谁@我”相关的功能。
 * 该类会注册一个 'whoatme' 子命令，允许用户查询在何时被谁提及。
 * 查询结果将以合并转发的形式发送给用户。
 * 此外，该类还包含一个定时任务，用于定期清理数据库中旧的@记录。
 */
export class WhoAt {
  /**
   * WhoAt 类的构造函数。
   * @param {Context} ctx - Koishi 的插件上下文，用于访问框架核心功能和数据库等服务。
   * @param {Config} config - 插件的配置对象，包含如记录保留天数等设置。
   */
  constructor(private ctx: Context, private config: Config) {
    this.setupCleanupTask();
  }

  /**
   * @private
   * @method setupCleanupTask
   * @description 设置一个定时清理任务。
   * 此任务会根据配置中的 `atRetentionDays` 定期删除过期的@记录，以防止数据库膨胀。
   */
  private setupCleanupTask() {
    if (this.config.atRetentionDays > 0) {
      this.ctx.cron('0 0 * * *', async () => {
        try {
          const cutoffDate = new Date(Date.now() - this.config.atRetentionDays * Time.day);
          await this.ctx.database.remove('analyse_at', { timestamp: { $lt: cutoffDate } });
        } catch (error) {
          this.ctx.logger.error('清理 @ 历史记录出错:', error);
        }
      });
    }
  }

  /**
   * @public
   * @method registerCommand
   * @description 在主 `analyse` 命令下注册 `whoatme` 子命令。
   * @param {Command} analyse - 用户传入的主 `analyse` 命令实例，`whoatme` 将作为其子命令。
   */
  public registerCommand(analyse: Command) {
    analyse.subcommand('whoatme', '谁 @ 我')
      .action(async ({ session }) => {
        if (!session.userId) return '无法获取用户信息';

        try {
          const records = await this.ctx.database.select('analyse_at')
            .where({ target: session.userId })
            .orderBy('timestamp', 'asc')
            .limit(100)
            .execute();

          if (records.length === 0) return '暂无 @ 记录';

          const uids = [...new Set(records.map(r => r.uid))];
          const users = await this.ctx.database.select('analyse_user', { uid: { $in: uids } }).project(['uid', 'userName', 'userId']).execute();
          const userInfoMap = new Map(users.map(u => [u.uid, { name: u.userName, id: u.userId }]));

          const messageElements = records.map(record => {
            const senderInfo = userInfoMap.get(record.uid);
            const userId = senderInfo.id;
            const userName = senderInfo.name || userId;
            const authorElement = h('author', { userId, name: userName });
            const contentElement = h.text(record.content);
            return h('message', {}, [authorElement, contentElement]);
          });

          if (messageElements.length === 0) return '暂无有效 @ 记录';

          const forwardMessage = h('message', { forward: true }, messageElements);
          await session.send(forwardMessage);

        } catch (error) {
          this.ctx.logger.error('查询 @ 记录时失败:', error);
          return '查询失败，请稍后再试';
        }
      });
  }
}
