import { Context, Command } from 'koishi';

/**
 * @class Debug
 * @description
 * 提供一系列调试工具，用于数据维护和状态检查。
 * 包括手动补全用户信息、列出数据库中的频道和命令等功能。
 */
export class Debug {
  /**
   * @constructor
   * @param {Context} ctx - Koishi 的插件上下文。
   */
  constructor(private ctx: Context) {}

  /**
   * @public
   * @method registerCommands
   * @description 在 'analyse' 命令下注册所有调试相关的子命令。
   * @param {Command} analyse - 主 'analyse' 命令实例。
   */
  public registerCommands(analyse: Command) {
    analyse.subcommand('.fill', '手动补全用户信息', { authority: 4 })
      .action(async ({ session }) => {
        const bots = this.ctx.bots;
        if (bots.length === 0) return '暂无可用机器人';

        const usersToUpdate = await this.ctx.database.get('analyse_user', {
          $or: [{ userName: '' }, { channelName: '' }],
        });
        if (usersToUpdate.length === 0) return '暂无用户信息需要补全';

        const usersByChannel = usersToUpdate.reduce((acc, user) => {
          (acc[user.channelId] = acc[user.channelId] || []).push(user);
          return acc;
        }, {} as Record<string, typeof usersToUpdate>);

        let updatedCount = 0;
        const bot = bots.find(b => b.platform === session.platform) || bots[0];

        for (const channelId in usersByChannel) {
          const usersInChannel = usersByChannel[channelId];
          let channelName = usersInChannel.find(u => u.channelName)?.channelName || '';

          if (!channelName && channelId) {
            try {
              channelName = (await bot.getGuild(channelId))?.name || '';
            } catch (e) {
              this.ctx.logger.warn(`获取频道 ${channelId} 信息失败:`, e);
            }
          }

          for (const user of usersInChannel) {
            if (user.userName && user.channelName) continue;

            let userName = user.userName;
            if (!userName && user.userId && channelId) {
              try {
                const member = await bot.getGuildMember(channelId, user.userId);
                userName = member?.nick || member?.name || '';
                if (!userName) userName = (await bot.getUser(user.userId))?.name || '';
              } catch (e) {
                this.ctx.logger.warn(`获取频道 ${channelId} 的用户 ${user.userId} 信息失败:`, e);
              }
            }

            await this.ctx.database.set('analyse_user', { uid: user.uid }, {
              userName: userName || user.userName,
              channelName: channelName || user.channelName,
            });
            updatedCount++;
          }
        }
        return `已补全 ${updatedCount} 条用户信息`;
      });

    analyse.subcommand('.list', '列出频道及命令', { authority: 4 })
      .action(async () => {
        const allChannelInfo = await this.ctx.database.get('analyse_user', {}, ['channelId', 'channelName']);
        const uniqueChannels = [...new Map(allChannelInfo.map(item => [item.channelId, item])).values()];
        const channelOutput = uniqueChannels.length > 0
          ? '频道列表:\n' + uniqueChannels.map(c => `[${c.channelId}] ${c.channelName}`).join('\n')
          : '暂无频道记录';

        const commands = await (this.ctx.database.select('analyse_cmd') as any).distinct('command').execute();
        const commandOutput = commands.length > 0
          ? '命令列表:\n' + commands.map(c => c.command).join(', ')
          : '暂无命令记录';

        return `${channelOutput}\n${commandOutput}`;
      });
  }
}
