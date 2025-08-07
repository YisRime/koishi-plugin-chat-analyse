import { Context, Session, Argv, Element } from 'koishi';

/**
 * @file collector.ts
 * @description 通过独立的事件监听器，分别持久化存储收到的普通消息和已确认的命令。
 */

// 扩展 Koishi 的 Tables 接口
declare module 'koishi' {
  interface Tables {
    analyse_origin_msg: {
      id: number;
      channelId: string;
      userId: string;
      content: string;
      timestamp: Date;
    };
    analyse_origin_cmd: {
      id: number;
      channelId: string;
      userId: string;
      command: string;
      content: string;
      timestamp: Date;
    };
  }
}

/**
 * @class Collector
 * @description 使用双监听器，精确捕获并存储消息和命令。
 */
export class Collector {
  constructor(private ctx: Context) {
    // 为 'analyse_origin_msg' 表定义模型
    ctx.model.extend('analyse_origin_msg', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, { autoInc: true });

    // 为 'analyse_origin_cmd' 表定义模型
    ctx.model.extend('analyse_origin_cmd', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      command: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, { autoInc: true });

    ctx.on('command/before-execute', async (argv: Argv) => {
      await ctx.database.create('analyse_origin_cmd', {
        channelId: argv.session.channelId,
        userId: argv.session.userId,
        command: argv.command.name,
        content: argv.session.content,
        timestamp: new Date(argv.session.timestamp),
      });
    });

    ctx.on('message', async (session: Session) => {
      if (session.argv?.command) return;

      const content = session.elements.map((element: Element) => {
        switch (element.type) {
          case 'text': return element.attrs.content;
          case 'img': return element.attrs.summary === '[动画表情]' ? '[gif]' : `[${element.type}]`;
          case 'at': return `[at:${element.attrs.id}]`;
          default: return `[${element.type}]`;
        }
      }).join('');

      const sanitizedContent = content.trim();
      if (!sanitizedContent) return;

      await ctx.database.create('analyse_origin_msg', {
        channelId: session.channelId,
        userId: session.userId,
        content: sanitizedContent,
        timestamp: new Date(session.timestamp),
      });
    });
  }
}
