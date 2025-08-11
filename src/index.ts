import { Context, Schema } from 'koishi';
import { Collector } from './Collector';
import { Stat } from './Stat';
import { WhoAt } from './WhoAt';
import { Data } from './Data';

/** @name 插件使用说明 */
export const usage = `
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #4a6ee0;">📌 插件说明</h2>
  <p>📖 <strong>使用文档</strong>：请点击左上角的 <strong>插件主页</strong> 查看插件使用文档</p>
  <p>🔍 <strong>更多插件</strong>：可访问 <a href="https://github.com/YisRime" style="color:#4a6ee0;text-decoration:none;">苡淞的 GitHub</a> 查看本人的所有插件</p>
</div>
<div style="border-radius: 10px; border: 1px solid #ddd; padding: 16px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
  <h2 style="margin-top: 0; color: #e0574a;">❤️ 支持与反馈</h2>
  <p>🌟 喜欢这个插件？请在 <a href="https://github.com/YisRime" style="color:#e0574a;text-decoration:none;">GitHub</a> 上给我一个 Star！</p>
  <p>🐛 遇到问题？请通过 <strong>Issues</strong> 提交反馈，或加入 QQ 群 <a href="https://qm.qq.com/q/PdLMx9Jowq" style="color:#e0574a;text-decoration:none;"><strong>855571375</strong></a> 进行交流</p>
</div>
`;

export const name = 'chat-analyse';
export const using = ['database', 'puppeteer', 'cron'];

/**
 * @interface Config
 * @description 定义插件的配置项结构。
 */
export interface Config {
  enableListener: boolean;
  enableCmdStat: boolean;
  enableMsgStat: boolean;
  enableRankStat: boolean;
  enableActivity: boolean;
  enableOriRecord: boolean;
  enableWhoAt: boolean;
  enableDataIO: boolean;
  atRetentionDays: number;
  rankRetentionDays: number;
}

/** @description 插件的配置项定义 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableListener: Schema.boolean().default(true).description('启用消息监听'),
    enableDataIO: Schema.boolean().default(true).description('启用数据管理'),
  }).description('杂项配置'),
  Schema.object({
    enableCmdStat: Schema.boolean().default(true).description('启用命令统计'),
    enableMsgStat: Schema.boolean().default(true).description('启用消息统计'),
    enableActivity: Schema.boolean().default(true).description('启用活跃统计'),
    enableRankStat: Schema.boolean().default(true).description('启用发言排行'),
    rankRetentionDays: Schema.number().min(0).default(31).description('排行保留天数'),
    enableWhoAt: Schema.boolean().default(true).description('启用提及记录'),
    atRetentionDays: Schema.number().min(0).default(7).description('提及保留天数'),
  }).description('基础分析配置'),
  Schema.object({
    enableOriRecord: Schema.boolean().default(true).description('启用原始记录'),
  }).description('高级分析配置'),
]);

/**
 * @function apply
 * @description Koishi 插件的主入口函数，负责初始化和注册所有功能模块。
 * @param ctx - Koishi 的插件上下文。
 * @param config - 用户配置对象。
 */
export function apply(ctx: Context, config: Config) {
  if (config.enableListener) new Collector(ctx, config);

  const analyse = ctx.command('analyse', '数据分析');

  // 动态注册功能模块
  new Stat(ctx, config).registerCommands(analyse);
  if (config.enableWhoAt) new WhoAt(ctx, config).registerCommand(analyse);
  if (config.enableDataIO) new Data(ctx).registerCommands(analyse);
}
