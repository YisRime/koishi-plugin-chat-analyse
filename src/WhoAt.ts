import { Context, Command, h, Time } from 'koishi';
import {} from 'koishi-plugin-cron';
import { Config } from './index';

/**
 * @class WhoAt
 * @description 负责处理谁提及我相关功能，包括查询和定时清理。
 */
export class WhoAt {
  /**
   * @param ctx - Koishi 的插件上下文。
   * @param config - 插件的配置对象。
   */
  constructor(private ctx: Context, private config: Config) {
    if (this.config.enableWhoAt && this.config.atRetentionDays > 0) {
      this.ctx.cron('0 0 * * *', async () => {
        const cutoffDate = new Date(Date.now() - this.config.atRetentionDays * Time.day);
        await this.ctx.database.remove('analyse_at', { timestamp: { $lt: cutoffDate } })
          .catch(e => this.ctx.logger.error('清理提及历史记录失败:', e));
      });
    }
  }

  /**
   * @public @method registerCommand
   * @description 在主命令下注册子命令。
   * @param cmd - 主命令实例。
   */
  public registerCommand(cmd: Command) {
    cmd.subcommand('whoatme', '谁提及我')
      .action(async ({ session }) => {
        if (!session.userId) return '无法获取用户信息';
        try {
          const records = await this.ctx.database.get('analyse_at', { target: session.userId }, {
            sort: { timestamp: 'asc' }, limit: 100
          });
          if (records.length === 0) return '最近没有人提及您';
          const uids = [...new Set(records.map(r => r.uid))];
          const users = await this.ctx.database.get('analyse_user', { uid: { $in: uids } }, ['uid', 'userName', 'userId']);
          const userInfoMap = new Map(users.map(u => [u.uid, { name: u.userName, id: u.userId }]));
          const messageElements = records.map(record => {
            const senderInfo = userInfoMap.get(record.uid) ?? { name: '未知用户', id: '0' };
            return h('message', {}, [
              h('author', { userId: senderInfo.id, nickname: senderInfo.name }),
              h.text(record.content)
            ]);
          });
          return h('message', { forward: true }, messageElements);
        } catch (error) {
          this.ctx.logger.error('查询提及记录失败:', error);
          return '查询失败，请稍后重试';
        }
      });
  }
}
