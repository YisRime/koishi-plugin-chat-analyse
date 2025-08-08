import { Context, Session, Command, $, h, Element } from 'koishi';
import { Renderer, ListRenderData, RenderListItem } from './Renderer';

// 模块内扩展 Tables 接口，用于类型安全
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
 * @description 提供命令统计服务，处理用户查询并渲染结果。
 */
export class CmdStat {
  public renderer: Renderer;

  constructor(private ctx: Context) {
    this.renderer = new Renderer(ctx);
    // 初始化 `analyse_cmd` 数据表
    this.ctx.model.extend('analyse_cmd', {
      channelId: 'string', userId: 'string', command: 'string',
      count: 'unsigned', timestamp: 'timestamp',
    }, { primary: ['channelId', 'userId', 'command'] });
    // 监听命令执行前事件，原子化地更新使用次数
    this.ctx.on('command/before-execute', async ({ command, session }) => {
      const { userId, guildId } = session;
      if (!guildId || !userId) return;
      const query = { channelId: guildId, userId, command: command.name };
      await this.ctx.database.upsert('analyse_cmd', (row) => [{
        ...query, count: $.add($.ifNull(row.count, 0), 1), timestamp: new Date(),
      }]);
    });
  }

  /**
   * 注册所有相关的子命令到主 `analyse` 命令下。
   * @param analyse {Command} 主 `analyse` 命令实例。
   */
  public registerCommands(analyse: Command) {
    analyse.subcommand('.command', '命令使用统计')
      .option('user', '-u [user:user] 查看指定用户的统计')
      .option('guild', '-g [guildId:string] 查看指定群组的统计 (默认当前群)')
      .usage('查询命令使用统计。支持按用户、按群组或组合查询。')
      .action(async ({ session, options }) => {
        const userId = options.user ? h.select(options.user, 'user')[0]?.attrs.id : undefined;
        let guildId = options.guild;
        if (options.guild === '' && !options.user) {
          if (!session.guildId) return '私聊中请使用 -g <群组ID> 指定群组。';
          guildId = session.guildId;
        }
        try {
          const stats = await this.getCommandStats(guildId, userId);
          if (typeof stats === 'string') return stats;
          const title = await this.generateTitle(session, guildId, userId);
          const renderData: ListRenderData = {
            title, time: new Date(),
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
   * 根据查询参数动态生成图片标题。
   */
  private async generateTitle(session: Session, guildId?: string, userId?: string): Promise<string> {
    if (userId && guildId) {
        const userName = (await session.bot.getUser(userId).catch(() => null))?.name || userId;
        const guildName = (await session.bot.getGuild(guildId).catch(() => null))?.name || guildId;
        return `${userName} 在 ${guildName} 的命令统计`;
    }
    if (userId) {
        const userName = (await session.bot.getUser(userId).catch(() => null))?.name || userId;
        return `${userName} 的全局命令统计`;
    }
    if (guildId) {
        const guildName = (await session.bot.getGuild(guildId).catch(() => null))?.name || guildId;
        return `${guildName} 的命令统计`;
    }
    return '全局命令统计';
  }

  /**
   * 从数据库获取并聚合命令统计数据。
   * @param guildId {string} (可选) 群组ID。
   * @param userId {string} (可选) 用户ID。
   * @returns {Promise<{ list: RenderListItem[], total: number } | string>} 包含结果列表和总数的对象，或错误/提示信息。
   */
  private async getCommandStats(guildId?: string, userId?: string): Promise<{ list: RenderListItem[], total: number } | string> {
    const query: Partial<{ channelId: string, userId: string }> = {};
    if (guildId) query.channelId = guildId;
    if (userId) query.userId = userId;
    // 统一使用数据库聚合查询，高效且简洁
    const aggregatedStats = await this.ctx.database.select('analyse_cmd', query)
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
}
