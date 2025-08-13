import { Context, Command, h, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config, parseQueryScope, generateTitle } from './index';
import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict';

export interface WordCloudData {
  title: string;
  time: Date;
  words: [string, number][];
}

/**
 * @class Analyse
 * @description 提供文本分析功能，如生成词云。
 */
export class Analyse {
  private renderer: Renderer;
  private readonly jieba: Jieba | null = null;

  constructor(private ctx: Context, private config: Config) {
    this.renderer = new Renderer(ctx);
    if (config.enableWordCloud) this.jieba = Jieba.withDict(dict);

    if (this.config.enableOriRecord && this.config.cacheRetentionDays > 0) {
      this.ctx.cron('0 0 * * *', async () => {
        const cutoffDate = new Date(Date.now() - this.config.cacheRetentionDays * Time.day);
        await this.ctx.database.remove('analyse_cache', { timestamp: { $lt: cutoffDate } })
          .catch(e => this.ctx.logger.error('清理原始记录缓存失败:', e));
      });
    }
  }

  /**
   * @public @method registerCommands
   * @description 在主命令下注册子命令。
   * @param cmd - 主命令实例。
   */
  public registerCommands(cmd: Command) {
    if (this.config.enableWordCloud) {
      cmd.subcommand('wordcloud', '生成词云')
        .usage('基于聊天记录生成词云图，可指定范围，默认当前群组。')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('user', '-u <user:string> 指定用户')
        .option('hours', '-t <hours:number> 指定时长', { fallback: 24 })
        .option('all', '-a 全局')
        .action(async ({ session, options }) => {
          try {
            if (!this.jieba) return 'Jieba 分词服务未就绪';

            const scope = await parseQueryScope(this.ctx, session, options);
            if (scope.error) return scope.error;

            scope.uids ??= (await this.ctx.database.get('analyse_user', {}, ['uid'])).map(u => u.uid);
            if (!scope.uids?.length) return '暂无用户数据';

            const since = new Date(Date.now() - options.hours * Time.hour);
            const records = await this.ctx.database.get('analyse_cache', { uid: { $in: scope.uids }, timestamp: { $gte: since } }, ['content']);

            if (!records.length) return '暂无统计数据';

            const exclusionRegex = /\[(face|file|forward|img|gif|audio|video|json|rps|markdown|dice|at:.*?)\]/g;
            const allText = records.map(r => r.content.replace(exclusionRegex, '')).join(' ');

            const words = this.jieba.cut(allText).filter(w => {
              if (w.trim().length <= 1) return false; // 过滤掉单个字
              if (/^\d+$/.test(w)) return false;      // 过滤掉纯数字
              return true;
            });

            if (!words.length) return '暂无有效词语';

            const wordCounts = words.reduce((map, word) => map.set(word, (map.get(word) || 0) + 1), new Map<string, number>());
            const wordList = Array.from(wordCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 512);

            const topWordsPreview = wordList.slice(0, 10).map(item => item[0]).join(', ');
            session.send(`正在生成词云，热门词汇：${topWordsPreview}...`);

            const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '词云' });
            const imageGenerator = this.renderer.renderWordCloud({ title, time: new Date(), words: wordList });
            for await (const buffer of imageGenerator) await session.send(h.image(buffer, 'image/png'));

          } catch (error) {
            this.ctx.logger.error('生成词云图片失败:', error);
            return '图片渲染失败';
          }
        });
    }
  }
}
