import { Context, Command, $, h, Session, Time } from 'koishi';
import { Renderer } from './Renderer';
import { Config, parseQueryScope, generateTitle } from './index';
import { Nlp } from '@nlpjs/basic';
import { LangZh } from '@nlpjs/lang-zh';

export interface WordCloudData {
  title: string;
  time: Date;
  words: [string, number][];
}

export class Analyse {
  private renderer: Renderer;
  private nlp: Nlp;
  private isNlpReady: boolean = false;

  constructor(private ctx: Context, private config: Config) {
    this.renderer = new Renderer(ctx);

    this.nlp = new Nlp({ languages: ['zh'], nlu: { log: false } });
    this.nlp.settings.autoSave = false;
    this.nlp.container.register('extract-lang-zh', new LangZh());

    this.initializeNlp().catch(err => {
        this.ctx.logger.error('NLP 语言模型加载失败:', err);
    });
  }

  /**
   * @private
   * @method initializeNlp
   * @description 异步加载并训练 NLP 模型。
   */
  private async initializeNlp() {
      await this.nlp.train();
      this.isNlpReady = true;
  }

  public registerCommands(cmd: Command) {
    if (this.config.enableWordCloud) {
      cmd.subcommand('.wordcloud', '生成词云')
        .usage('基于指定范围内的聊天记录生成词云图。')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('user', '-u <user:string> 指定用户')
        .option('all', '-a 全局')
        .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
        .action(async ({ session, options }) => {
          if (!this.isNlpReady) return '文本分析尚未就绪，请稍后再试';

          const scope = await parseQueryScope(this.ctx, session, options);
          if (scope.error) return scope.error;

          const since = new Date(Date.now() - options.hours * Time.hour);
          const records = await this.ctx.database.select('analyse_cache').where({ uid: { $in: scope.uids }, timestamp: { $gte: since } }).project(['content']).execute();
          if (records.length === 0) return '暂无统计数据';

          const allText = records.map(r => r.content).join(' ');
          const result = await this.nlp.process('zh', allText);
          // FIX: Provide a fallback empty array in case result.stems is undefined
          const words = (result.stems || []).filter(stem => stem.length > 1);

          const wordCounts = words.reduce((map, word) => {
            map.set(word, (map.get(word) || 0) + 1);
            return map;
          }, new Map<string, number>());

          if (wordCounts.size === 0) return '暂无有效词语';

          const wordList: [string, number][] = (Array.from(wordCounts.entries()) as [string, number][])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 150);

          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '词云' });
          const renderResult = await this.renderer.renderWordCloud({ title, time: new Date(), words: wordList });

          if (typeof renderResult === 'string') return renderResult;
          if (Array.isArray(renderResult) && renderResult.length > 0) {
              for (const buffer of renderResult) await session.sendQueued(h.image(buffer, 'image/png'));
          }
        });
    }

    if (this.config.enableVocabulary) {
      cmd.subcommand('.vocabulary', '词汇排行')
        .usage('根据不重复词汇量占总词汇量的比例进行排行。')
        .option('guild', '-g <guildId:string> 指定群组')
        .option('all', '-a 全局')
        .option('hours', '-h <hours:number> 指定时长', { fallback: 24 })
        .action(async ({ session, options }) => {
          if (!this.isNlpReady) return '文本分析尚未就绪，请稍后再试';

          const scope = await parseQueryScope(this.ctx, session, options);
          if (scope.error) return scope.error;

          const users = await this.ctx.database.get('analyse_user', { uid: { $in: scope.uids } }, ['uid', 'userName']);
          const userNameMap = new Map(users.map(u => [u.uid, u.userName]));

          const since = new Date(Date.now() - options.hours * Time.hour);
          const allRecords = await this.ctx.database.get('analyse_cache', { uid: { $in: scope.uids }, timestamp: { $gte: since } }, ['uid', 'content']);
          if (allRecords.length === 0) return '暂无统计数据';

          const messagesByUid = new Map<number, string[]>();
          for (const record of allRecords) {
            if (!messagesByUid.has(record.uid)) messagesByUid.set(record.uid, []);
            messagesByUid.get(record.uid).push(record.content);
          }

          const richnessData = [];
          for (const [uid, messages] of messagesByUid.entries()) {
            const allText = messages.join(' ');
            const result = await this.nlp.process('zh', allText);
            // FIX: Provide a fallback empty array in case result.stems is undefined
            const words = (result.stems || []).filter(stem => stem.length > 1);

            if (words.length < 50) continue;

            const uniqueWords = new Set(words);
            const richness = uniqueWords.size / words.length;

            richnessData.push({
              name: userNameMap.get(uid) || `UID ${uid}`,
              total: words.length,
              unique: uniqueWords.size,
              richness: richness
            });
          }

          if (richnessData.length === 0) return '暂无有效词语';

          richnessData.sort((a, b) => b.richness - a.richness);

          const list = richnessData.map(item => [
            item.name, item.unique, item.total, `${(item.richness * 100).toFixed(2)}%`
          ]);

          const title = await generateTitle(this.ctx, scope.scopeDesc, { main: '词汇排行' });

          const renderResult = await this.renderer.renderList(
            { title, time: new Date(), total: richnessData.length, list },
            ['用户', '不重复词数', '总词数', '丰富度']
          );

          if (typeof renderResult === 'string') return renderResult;
          if (Array.isArray(renderResult) && renderResult.length > 0) {
              for (const buffer of renderResult) await session.sendQueued(h.image(buffer, 'image/png'));
          }
        });
    }
  }
}
