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
 * 计算两个向量的余弦相似度
 * @param vecA 向量A
 * @param vecB 向量B
 * @returns 相似度得分 (0-1)
 */
function cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += (vecA[i] || 0) * (vecB[i] || 0);
        magA += (vecA[i] || 0) * (vecA[i] || 0);
        magB += (vecB[i] || 0) * (vecB[i] || 0);
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (magA === 0 || magB === 0) return 0;
    return dotProduct / (magA * magB);
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

            const excludeWords = new Set(this.config.excludeWords.split(',').map(w => w.trim().toLowerCase()).filter(Boolean));
            const exclusionRegex = /\[(face|file|forward|img|gif|audio|video|json|rps|markdown|dice|at:.*?)\]/g;
            const allText = records.map(r => r.content.replace(exclusionRegex, '')).join(' ');

            const words = this.jieba.cut(allText).filter(w => {
              const trimmedWord = w.trim();
              if (trimmedWord.length <= 1) return false;
              if (/^\d+$/.test(trimmedWord)) return false;
              if (excludeWords.has(trimmedWord.toLowerCase())) return false;
              return true;
            });

            if (!words.length) return '暂无有效词语';

            const wordCounts = words.reduce((map, word) => map.set(word, (map.get(word) || 0) + 1), new Map<string, number>());
            const wordList = Array.from(wordCounts.entries()).sort((a, b) => b[1] - a[1]);
            const limitedWordList = this.config.maxWords > 0 ? wordList.slice(0, this.config.maxWords) : wordList;

            const topWordsPreview = limitedWordList.slice(0, 10).map(item => item[0]).join(', ');
            session.send(`正在基于 ${wordList.length} 个词生成词云：${topWordsPreview}...`);

            const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '词云', timeRange: options.hours });
            const imageGenerator = this.renderer.renderWordCloud({ title, time: new Date(), words: limitedWordList }, this.config);
            for await (const buffer of imageGenerator) await session.send(h.image(buffer, 'image/png'));

          } catch (error) {
            this.ctx.logger.error('生成词云图片失败:', error);
            return '图片渲染失败';
          }
        });
    }

    if (this.config.enableSimilarActivity) {
      cmd.subcommand('simiactive', '相似活跃分析')
        .usage('分析你和群友的活跃规律，找出谁和你的作息最相似。')
        .option('hours', '-n <hours:number> 指定时长', { fallback: 24 })
        .option('separate', '-p 分时分析')
        .action(async ({ session, options }) => {
          const effectiveChannelId = session.guildId || session.channelId;
          if (!effectiveChannelId) return '请在群组中使用此命令';

          try {
            const guildUsers = await this.ctx.database.get('analyse_user', { channelId: effectiveChannelId });
            if (guildUsers.length < 2) return '暂无用户数据';
            const selfUser = guildUsers.find(u => u.userId === session.userId);
            if (!selfUser) return '暂无用户数据';
            const guildUserUids = guildUsers.map(u => u.uid);
            const uidToNameMap = new Map(guildUsers.map(u => [u.uid, u.userName]));
            const scopeDesc = { guildId: effectiveChannelId };
            const until = new Date();
            let analysisConfig: {
              title: string;
              since: Date;
              points: number;
              labels: string[];
              getIndex: (timestamp: Date) => number;
              reorderVector: (vec: number[]) => number[];
            };

            if (options.separate) {
              const { hours } = options;
              const title = await generateTitle(this.ctx, scopeDesc, { main: '相似活跃', timeRange: hours, timeUnit: '小时' });
              analysisConfig = {
                points: hours,
                since: new Date(until.getTime() - hours * Time.hour),
                title,
                labels: Array.from({ length: hours }, (_, i) => String(new Date(until.getTime() - (hours - 1 - i) * Time.hour).getHours())),
                getIndex: (timestamp) => {
                  const diff = until.getTime() - timestamp.getTime();
                  const index = hours - 1 - Math.floor(diff / Time.hour);
                  return (index >= 0 && index < hours) ? index : -1;
                },
                reorderVector: (vec) => vec,
              };
            } else {
              const daysToAnalyse = Math.floor(options.hours / 24);
              if (daysToAnalyse < 1) return '分析时长请指定至少 1 天';

              const hoursToAnalyse = daysToAnalyse * 24;
              const currentHour = until.getHours();
              const labels = Array.from({ length: 24 }, (_, i) => String((currentHour - (23 - i) + 24) % 24));
              const title = await generateTitle(this.ctx, scopeDesc, { main: '相似活跃', timeRange: daysToAnalyse, timeUnit: '天' });

              analysisConfig = {
                points: 24,
                since: new Date(until.getTime() - hoursToAnalyse * Time.hour),
                title,
                labels: labels,
                getIndex: (timestamp) => timestamp.getHours(),
                reorderVector: (vector) => labels.map(label => vector[parseInt(label)]),
              };
            }

            const records = await this.ctx.database.get('analyse_rank', { uid: { $in: guildUserUids }, timestamp: { $gte: analysisConfig.since } });
            if (!records.length) return '暂无统计数据';

            const activityVectors = new Map<number, number[]>(guildUserUids.map(uid => [uid, Array(analysisConfig.points).fill(0)]));
            for (const record of records) {
              const index = analysisConfig.getIndex(record.timestamp);
              if (index !== -1) activityVectors.get(record.uid)[index] += record.count;
            }

            const selfVector = activityVectors.get(selfUser.uid);
            const similarities = guildUserUids
              .filter(uid => uid !== selfUser.uid && activityVectors.get(uid).some(v => v !== 0))
              .map(uid => ({
                uid,
                score: cosineSimilarity(selfVector, activityVectors.get(uid))
              }))
              .sort((a, b) => b.score - a.score);

            if (!similarities.length) return '暂无相似用户';

            const top5 = similarities.slice(0, 5);
            const series = [{ name: uidToNameMap.get(selfUser.uid) || '您', data: analysisConfig.reorderVector(selfVector) }];

            for (const sim of top5) {
              const name = uidToNameMap.get(sim.uid) || `UID ${sim.uid}`;
              const data = analysisConfig.reorderVector(activityVectors.get(sim.uid));
              series.push({ name: `${name} (${(sim.score * 100).toFixed(1)}%)`, data });
            }

            const imageGenerator = this.renderer.renderLineChart({ title: analysisConfig.title, time: new Date(), series, labels: analysisConfig.labels });
            for await (const buffer of imageGenerator) await session.send(h.image(buffer, 'image/png'));
          } catch (error) {
            this.ctx.logger.error('生成作息分析图片失败:', error);
            return '图片渲染失败';
          }
        });
    }
  }
}
