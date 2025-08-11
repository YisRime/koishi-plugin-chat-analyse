import { Context, Command, Element, Tables, Time } from 'koishi';
import * as fs from 'fs/promises';
import * as path from 'path';

/** 定义插件管理的所有数据表的表名数组。 */
const ALL_TABLES: (keyof Tables)[] = ['analyse_user', 'analyse_cmd', 'analyse_msg', 'analyse_rank', 'analyse_at', 'analyse_cache'];
const BATCH_SIZE = 100;

/**
 * @class Data
 * @description 提供数据备份、恢复和清理等高级管理功能。恢复逻辑采用分批处理以优化性能。
 */
export class Data {
  private dataDir: string;

  constructor(private ctx: Context) {
    this.dataDir = path.join(this.ctx.baseDir, 'data', 'chat-analyse');
  }

  /**
   * @public
   * @method registerCommands
   * @description 在主命令下注册所有数据管理相关的子命令。
   * @param cmd - 主命令实例。
   */
  public registerCommands(cmd: Command) {
    cmd.subcommand('.backup', '备份统计数据', { authority: 4 })
      .action(async () => {
        try {
          await fs.mkdir(this.dataDir, { recursive: true });
          const allUsers = await this.ctx.database.get('analyse_user', {});
          const uidToUserInfoMap = new Map(allUsers.map(u => [u.uid, u]));

          for (const tableName of ALL_TABLES) {
            const filepath = path.join(this.dataDir, `${tableName}.json`);
            let dataToExport: any[];

            if (tableName === 'analyse_user') {
              dataToExport = allUsers.map(({ uid, ...rest }) => rest);
            } else {
              const records = await this.ctx.database.get(tableName, {}) as { uid: number }[];
              dataToExport = records.map(record => {
                const userInfo = uidToUserInfoMap.get(record.uid);
                if (!userInfo) return null;
                const { uid, ...restOfRecord } = record;
                return { userId: userInfo.userId, channelId: userInfo.channelId, ...restOfRecord };
              }).filter(Boolean);
            }
            await fs.writeFile(filepath, JSON.stringify(dataToExport, null, 2));
          }
          return '数据备份成功';
        } catch (error) {
          this.ctx.logger.error('数据备份失败:', error);
          return '数据备份失败';
        }
      });

    cmd.subcommand('.restore', '恢复统计数据', { authority: 4 })
      .action(async () => {
        try {
          const userTablePath = path.join(this.dataDir, 'analyse_user.json');
          const usersToImport = JSON.parse(await fs.readFile(userTablePath, 'utf-8').catch(() => '[]'));
          if (usersToImport.length) for (let i = 0; i < usersToImport.length; i += BATCH_SIZE) await this.ctx.database.upsert('analyse_user', usersToImport.slice(i, i + BATCH_SIZE));

          const allUsers = await this.ctx.database.get('analyse_user', {});
          const userToUidMap = new Map(allUsers.map(u => [`${u.channelId}:${u.userId}`, u.uid]));

          for (const tableName of ALL_TABLES.filter(t => t !== 'analyse_user')) {
            const filepath = path.join(this.dataDir, `${tableName}.json`);
            const recordsToImport = JSON.parse(await fs.readFile(filepath, 'utf-8').catch(() => '[]'));
            if (!recordsToImport.length) continue;

            const recordsWithUid = recordsToImport.map(r => {
              const uid = userToUidMap.get(`${r.channelId}:${r.userId}`);
              if (!uid) return null;
              const { userId, channelId, ...rest } = r;
              return { uid, ...rest };
            }).filter(Boolean);

            if (recordsWithUid.length > 0) for (let i = 0; i < recordsWithUid.length; i += BATCH_SIZE) await this.ctx.database.upsert(tableName, recordsWithUid.slice(i, i + BATCH_SIZE));
          }
          return '数据恢复成功';
        } catch (error) {
          this.ctx.logger.error('数据恢复失败:', error);
          return '数据恢复失败';
        }
      });

    cmd.subcommand('.clear', '清理统计数据', { authority: 4 })
      .option('table', '-t <table:string> 指定表名')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('user', '-u <user:string> 指定用户')
      .option('days', '-d <days:number> 指定天数')
      .option('all', '-a 清理全部数据')
      .action(async ({ options }) => {
        if (Object.keys(options).length === 0) return '请提供清理条件';
        try {
          if (options.all) {
            await Promise.all(ALL_TABLES.map(tableName => this.ctx.database.remove(tableName, {})));
            return '已清除所有聊天分析数据';
          }

          const tablesToClear = options.table ? [options.table] : ALL_TABLES.filter(t => t !== 'analyse_user');
          if (options.table && !ALL_TABLES.includes(options.table as keyof Tables)) return `无效表名: ${options.table}。`;

          const query: any = {};
          const descParts: string[] = [];

          if (options.guild || options.user) {
            const userQuery: any = {};
            if (options.guild) { userQuery.channelId = options.guild; descParts.push(`群组 ${options.guild}`); }
            if (options.user) { userQuery.userId = Element.select(options.user, 'at')[0]?.attrs.id ?? options.user; descParts.push(`用户 ${userQuery.userId}`); }
            const uidsToClear = (await this.ctx.database.get('analyse_user', userQuery)).map(u => u.uid);
            if (uidsToClear.length === 0) return '未找到匹配记录';
            query.uid = { $in: [...new Set(uidsToClear)] };
          }

          if (options.days > 0) {
            query.timestamp = { $lt: new Date(Date.now() - options.days * Time.day) };
            descParts.push(`超过 ${options.days} 天`);
          }

          for (const tableName of tablesToClear) await this.ctx.database.remove(tableName as any, query);

          const targetStr = options.table ? `表 ${options.table}` : '所有相关表';
          return `已成功清理${targetStr}中${descParts.join('且')}的数据`;

        } catch (error) {
          this.ctx.logger.error('数据清理失败:', error);
          return '数据清理失败';
        }
      });

    cmd.subcommand('.list', '列出频道和命令', { authority: 4 })
      .action(async () => {
        const [allChannelInfo, commands] = await Promise.all([
          this.ctx.database.get('analyse_user', {}, ['channelId', 'channelName']),
          (this.ctx.database.select('analyse_cmd') as any).distinct('command').execute()
        ]);

        const uniqueChannels = [...new Map(allChannelInfo.map(item => [item.channelId, item])).values()];
        const channelOutput = uniqueChannels.length ? '已记录频道列表:\n' + uniqueChannels.map(c => `[${c.channelId}] ${c.channelName}`).join('\n') : '暂无频道记录';
        const commandOutput = commands.length ? '已记录命令列表:\n' + commands.join(', ') : '暂无命令记录';

        return `${channelOutput}\n\n${commandOutput}`;
      });
  }
}
