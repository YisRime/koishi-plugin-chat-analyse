import { Context, Schema } from 'koishi';
import { Collector } from './Collector';
import { Stat } from './Stat';
import { WhoAt } from './WhoAt';
import { Data } from './Data';

/**
 * @name 插件使用说明
 * @description 在 Koishi 控制台中显示的插件介绍和帮助信息。
 */
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
  enableOriRecord: boolean;
  enableWhoAt: boolean;
  enableData: boolean;
  atRetentionDays: number;
  rankRetentionDays: number;
}

/**
 * @const {Schema<Config>} Config
 * @description 使用 Koishi 的 `Schema` 来定义配置项的类型、默认值和在控制台中的交互界面。
 */
export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    enableListener: Schema.boolean().default(true).description('启用消息监听'),
    enableData: Schema.boolean().default(false).description('启用数据管理'),
  }).description('监听配置'),
  Schema.object({
    enableCmdStat: Schema.boolean().default(true).description('启用命令统计'),
    enableMsgStat: Schema.boolean().default(true).description('启用消息统计'),
    enableOriRecord: Schema.boolean().default(true).description('启用原始记录'),
  }).description('功能配置'),
  Schema.object({
    enableRankStat: Schema.boolean().default(true).description('启用发言排行'),
    rankRetentionDays: Schema.number().min(0).default(31).description('记录保留天数'),
  }).description('发言排行配置'),
  Schema.object({
    enableWhoAt: Schema.boolean().default(true).description('启用 @ 记录'),
    atRetentionDays: Schema.number().min(0).default(7).description('记录保留天数'),
  }).description('@ 记录配置'),
]);

/**
 * @function apply
 * @description Koishi 插件的主入口函数。
 * @param {Context} ctx - Koishi 的插件上下文，提供了访问核心 API 的能力。
 * @param {Config} config - 用户在 `koishi.config.js` 或控制台中配置的对象。
 */
export function apply(ctx: Context, config: Config) {
  if (config.enableListener) new Collector(ctx, config);
  // 注册主命令
  const analyse = ctx.command('analyse', '聊天记录分析');
  // 注册统计查询子命令
  new Stat(ctx, config).registerCommands(analyse);
  // 注册 @ 记录子命令
  if (config.enableWhoAt) new WhoAt(ctx, config).registerCommand(analyse);
  // 注册数据管理子命令
  if (config.enableData) new Data(ctx).registerCommands(analyse);
}
