import { Context, Schema } from 'koishi'
import { Collector } from './collector'

export const name = 'chat-analyse'

export interface Config {}

export const Config: Schema<Config> = Schema.object({})

export const using = ['database']

export function apply(ctx: Context) {
  new Collector(ctx)
}
