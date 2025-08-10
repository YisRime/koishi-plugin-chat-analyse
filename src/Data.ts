import { Context, Command, Element, Tables, Time } from 'koishi';
import * as fs from 'fs/promises';
import * as path from 'path';

// 定义插件管理的所有数据表的表名
const ALL_TABLES: (keyof Tables)[] = [
  'analyse_user', 'analyse_cmd', 'analyse_msg',
  'analyse_rank', 'analyse_at', 'analyse_cache'
];

/**
 * @class Data
 * @description
 * 提供数据备份、恢复和清理的管理功能，恢复逻辑采用分批处理以优化性能。
 * 清理功能支持按表、时间范围和用户范围进行精确操作。
 */
export class Data {
  private dataDir: string;

  constructor(private ctx: Context) {
    this.dataDir = path.join(this.ctx.baseDir, 'data', 'chat-analyse');
  }

  /**
   * @public
   * @method registerCommands
   * @description 在 'analyse.admin' 命令下注册所有数据管理相关的子命令。
   * @param {Command} analyse - '.admin' 命令实例。
   */
  public registerCommands(analyse: Command) {
    analyse.subcommand('.backup', '备份统计数据', { authority: 4 })
      .action(async () => {
        try {
          await fs.mkdir(this.dataDir, { recursive: true });

          const allUsers = await this.ctx.database.get('analyse_user', {});
          const uidToUserInfoMap = new Map(allUsers.map(u => [u.uid, u]));

          for (const tableName of ALL_TABLES) {
            const filepath = path.join(this.dataDir, `${tableName}.json`);
            let dataToExport;

            if (tableName === 'analyse_user') {
              dataToExport = allUsers.map(({ uid, ...rest }) => rest);
            } else {
              const records = await this.ctx.database.get(tableName, {}) as { uid: number }[];
              dataToExport = records.map(record => {
                const userInfo = uidToUserInfoMap.get(record.uid);
                if (!userInfo) return null;
                const { uid, ...restOfRecord } = record;
                return {
                  userId: userInfo.userId,
                  channelId: userInfo.channelId,
                  ...restOfRecord
                };
              }).filter(Boolean);
            }

            await fs.writeFile(filepath, JSON.stringify(dataToExport, null, 2));
          }

          return `数据备份成功`;
        } catch (error) {
          this.ctx.logger.error('数据备份失败:', error);
          return '数据备份失败';
        }
      });

    analyse.subcommand('.restore', '恢复统计数据', { authority: 4 })
      .action(async () => {
        const BATCH_SIZE = 100;

        try {
          const userTablePath = path.join(this.dataDir, 'analyse_user.json');
          try {
            const usersToImport = JSON.parse(await fs.readFile(userTablePath, 'utf-8'));
            if (Array.isArray(usersToImport) && usersToImport.length > 0) {
              for (let i = 0; i < usersToImport.length; i += BATCH_SIZE) {
                const batch = usersToImport.slice(i, i + BATCH_SIZE);
                await this.ctx.database.upsert('analyse_user', batch);
              }
            }
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            this.ctx.logger.warn('无用户数据可恢复');
          }

          const allUsers = await this.ctx.database.get('analyse_user', {});
          const userToUidMap = new Map(allUsers.map(u => [`${u.channelId}:${u.userId}`, u.uid]));

          for (const tableName of ALL_TABLES.filter(t => t !== 'analyse_user')) {
            const filepath = path.join(this.dataDir, `${tableName}.json`);
            try {
              const recordsToImport = JSON.parse(await fs.readFile(filepath, 'utf-8'));
              if (Array.isArray(recordsToImport) && recordsToImport.length > 0) {
                const recordsWithUid = recordsToImport.map(r => {
                  const uid = userToUidMap.get(`${r.channelId}:${r.userId}`);
                  if (!uid) return null;
                  const { userId, channelId, ...rest } = r;
                  return { uid, ...rest };
                }).filter(Boolean);

                if (recordsWithUid.length > 0) {
                  for (let i = 0; i < recordsWithUid.length; i += BATCH_SIZE) {
                    const batch = recordsWithUid.slice(i, i + BATCH_SIZE);
                    await this.ctx.database.upsert(tableName, batch);
                  }
                }
              }
            } catch (e) {
              if (e.code !== 'ENOENT') throw e;
            }
          }

          return `数据恢复成功`;
        } catch (error) {
          this.ctx.logger.error('数据恢复失败:', error);
          return '数据恢复失败';
        }
      });

    analyse.subcommand('.clear', '清理统计数据', { authority: 4 })
      .option('table', '-t <table:string> 指定表')
      .option('guild', '-g <guildId:string> 指定群组')
      .option('user', '-u <user:string> 指定用户')
      .option('days', '-d <days:number> 指定天数')
      .option('all', '-a 清理全部数据')
      .action(async ({ options }) => {
        if (!options.table && !options.guild && !options.user && !options.all && !options.days) return '请提供清理条件';

        try {
          if (options.all) {
            for (const tableName of ALL_TABLES) await this.ctx.database.remove(tableName, {});
            return '已清除所有聊天分析数据';
          }

          let tablesToClear: (keyof Tables)[];
          if (options.table) {
            if (!ALL_TABLES.includes(options.table as keyof Tables)) return `无效表名: ${options.table}`;
            tablesToClear = [options.table as keyof Tables];
          } else {
            tablesToClear = ALL_TABLES.filter(t => t !== 'analyse_user');
          }

          const queryParts: { query: any, desc: string } = { query: {}, desc: '' };
          const descParts: string[] = [];

          if (options.guild || options.user) {
            const uidsToClear: number[] = [];
            const scopeDesc: string[] = [];
            if (options.guild) {
              uidsToClear.push(...(await this.ctx.database.get('analyse_user', { channelId: options.guild })).map(u => u.uid));
              scopeDesc.push(`群组 ${options.guild} `);
            }
            if (options.user) {
              const userId = Element.select(options.user, 'at')[0]?.attrs.id || options.user;
              uidsToClear.push(...(await this.ctx.database.get('analyse_user', { userId })).map(u => u.uid));
              scopeDesc.push(`用户 ${userId} `);
            }
            const uniqueUids = [...new Set(uidsToClear)];
            if (uniqueUids.length === 0) return '未找到该用户';
            queryParts.query.uid = { $in: uniqueUids };
            descParts.push(scopeDesc.join('、'));
          }

          if (options.days && options.days > 0) {
            queryParts.query.timestamp = { $lt: new Date(Date.now() - options.days * Time.day) };
            descParts.push(`超过 ${options.days} 天`);
          }

          for (const tableName of tablesToClear) {
            const finalQuery = { ...queryParts.query };
            if (tableName === 'analyse_user' && finalQuery.timestamp) delete finalQuery.timestamp;
            await this.ctx.database.remove(tableName as any, finalQuery);
          }

          const targetStr = options.table ? `表 ${options.table} ` : '所有表';
          const conditionStr = descParts.join(' 且 ');
          const finalDescription = conditionStr ? `${targetStr} 中${conditionStr}的数据` : `${targetStr}的全部统计数据`;

          return `已成功清理${finalDescription}`;

        } catch (error) {
          this.ctx.logger.error('数据清理失败:', error);
          return '数据清理失败';
        }
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
