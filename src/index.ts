import { Context, Schema } from 'koishi'
import { Collector } from './Collector'
import { CmdStat } from './CmdStat'

// 插件使用说明
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
`

export const name = 'chat-analyse'
// 插件依赖的服务
export const using = ['database', 'puppeteer']
// 插件配置项接口
export interface Config {}
// 插件配置项的 Schema 定义
export const Config: Schema<Config> = Schema.object({})

/**
 * Koishi 插件主入口函数。
 * @param ctx {Context} Koishi 上下文，用于访问和扩展框架功能。
 */
export function apply(ctx: Context) {
  // 实例化数据收集器
  new Collector(ctx)
  // 实例化命令统计与服务提供者
  const cmd = new CmdStat(ctx)
  // 注册主命令 `analyse`
  const analyse = ctx.command('analyse', '聊天记录分析')
  // 注册所有子命令
  cmd.registerCommands(analyse);
}
