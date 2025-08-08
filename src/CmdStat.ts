import { Context, Element, Command, $, h } from 'koishi';
import { Renderer, ListRenderData, RenderListItem } from './Renderer';

// 在文件内声明模块扩展，确保类型安全
declare module 'koishi' {
  interface Tables {
    analyse_cmd: {
      channelId: string;
      userId: string;
      command: string;
      count: number;
      timestamp: Date;
    }
  }
}

/**
 * @class CmdStat
 * @description 负责提供命令执行所需的服务，并管理插件的核心逻辑。
 */
export class CmdStat {
  public renderer: Renderer;
  public ctx: Context;

  constructor(context: Context) {
    this.ctx = context;
    this.renderer = new Renderer(this.ctx);

    this.ctx.model.extend('analyse_cmd', {
      channelId: 'string', userId: 'string', command: 'string',
      count: 'unsigned', timestamp: 'timestamp',
    }, { primary: ['channelId', 'userId', 'command'] });

    this.ctx.on('command/before-execute', async ({ command, session }) => {
      const { userId, guildId } = session;
      if (!guildId || !userId) return;

      const commandName = command.name;
      const query = { channelId: guildId, userId, command: commandName };

      await this.ctx.database.upsert('analyse_cmd', (row) => [{
        ...query,
        count: $.add($.ifNull(row.count, 0), 1),
        timestamp: new Date(),
      }]);
    });
  }

  /**
   * @method registerCommands
   * @description 注册命令，并通过选项支持不同维度的查询。
   */
  public registerCommands(analyse: Command) {
    analyse.subcommand('.command', '命令使用统计')
      .option('user', '-u [user:user] 指定用户')
      .option('guild', '-g [guildId:string] 指定群组')
      .usage(`查询命令使用统计。默认查询全局统计，可通过选项指定用户和群组。`)
      .action(async ({ session, options }) => {
        const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
        let guildId = options.guild;

        if (options.guild === '' && !options.user) {
          if(!session.guildId) return '请指定群组 ID';
          guildId = session.guildId;
        }

        try {
          const stats = await this.getCommandStats(guildId, userId);
          if (typeof stats === 'string') return stats;

          let title: string;
          const titleParts: string[] = [];

          if (userId) {
            const user = await session.bot.getUser(userId).catch(() => null);
            titleParts.push(`用户 ${user?.name || userId}`);
          }

          if (guildId) {
            const guild = await session.bot.getGuild(guildId).catch(() => null);
            titleParts.push(`群组 ${guild?.name || guildId}`);
          }

          if (userId && !guildId) {
            title = `${titleParts[0]}的全局命令统计`;
          } else if (titleParts.length > 0) {
            title = `${titleParts.join('、')}的命令统计`;
          } else {
            title = '全局命令统计';
          }

          const renderData: ListRenderData = {
            title,
            time: new Date(),
            total: stats.total,
            list: stats.list,
          };

          const headers = ['命令', '次数', '上次使用'];

          const result = await this.renderer.renderList(renderData, headers);
          return Buffer.isBuffer(result) ? Element.image(result, 'image/png') : result;

        } catch (error) {
          this.ctx.logger.error('渲染统计图片失败:', error);
          return '渲染统计图片失败';
        }
      });
  }

  /**
   * @private
   * @method getCommandStats
   * @description 从数据库获取并处理命令统计数据，兼容全局、群组和个人查询。
   * @returns 返回一个包含二维数组列表和总数的对象，或错误字符串。
   */
  private async getCommandStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const query: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) query.channelId = guildId;
    if (userId) query.userId = userId;

    if (userId) {
      const records = await this.ctx.database.get('analyse_cmd', query);
      if (records.length === 0) return '暂无统计数据';

      const totalCount = records.reduce((sum, record) => sum + record.count, 0);
      const sortedList = records
        .map(r => ({ name: r.command, count: r.count, lastUsed: r.timestamp }))
        .sort((a, b) => b.count - a.count);

      const list: RenderListItem[] = sortedList.map(item => [item.name, item.count, item.lastUsed]);
      return { list, total: totalCount };
    }

    const aggregatedStats = await this.ctx.database.select('analyse_cmd', query)
      .groupBy(
        ['command'],
        {
          count: (row) => $.sum(row.count),
          lastUsed: (row) => $.max(row.timestamp),
        }
      )
      .execute();

    if (aggregatedStats.length === 0) return '暂无统计数据';

    const totalCount = aggregatedStats.reduce((sum, record) => sum + record.count, 0);

    // 直接对聚合结果进行排序
    const sortedList = aggregatedStats.sort((a, b) => b.count - a.count);

    // 将对象数组转换为渲染器所需的二维数组格式
    const list: RenderListItem[] = sortedList.map(item => [item.command, item.count, item.lastUsed]);

    return { list, total: totalCount };
  }
}
