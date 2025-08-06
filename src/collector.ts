import { Context, Session, Argv } from 'koishi';

/**
 * @file collector.ts
 * @description 用于将收到的消息和命令分别持久化存储到数据库中。
 */

// 扩展 Koishi 的 Tables 接口，为数据库添加类型定义
declare module 'koishi' {
  interface Tables {
    analyse_origin_msg: {
      id: number;
      channelId: string;
      userId: string;
      content: string;
      timestamp: Date;
    }
    analyse_origin_cmd: {
      id: number;
      channelId: string;
      userId: string;
      command: string;
      content: string;
      timestamp: Date;
    }
  }
}

/**
 * @class Collector
 * @description 监听所有消息和命令，将消息内容存入 'analyse_origin_msg' 表，将命令存入 'analyse_origin_cmd' 表。
 */
export class Collector {
  /**
   * @param ctx Koishi 的上下文对象，用于访问模型和事件系统
   */
  constructor(private ctx: Context) {
    // 为 'analyse_origin_msg' 表定义模型和字段类型
    ctx.model.extend('analyse_origin_msg', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
    });
    // 为 'analyse_origin_cmd' 表定义模型和字段类型
    ctx.model.extend('analyse_origin_cmd', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      command: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
    });

    // 监听 'command/before-execute' 事件，当任何命令被执行前触发
    ctx.on('command/before-execute', async (argv: Argv) => {
      if (!argv.command) return;
      // 在数据库的 'analyse_origin_cmd' 表中创建一条新记录
      await ctx.database.create('analyse_origin_cmd', {
        channelId: argv.session.channelId,
        userId: argv.session.userId,
        command: argv.command.name,
        content: argv.session.content,
        timestamp: new Date(argv.session.timestamp),
      });
    });
    // 监听 'message' 事件，当机器人收到任何消息时触发
    ctx.on('message', (session: Session) => {
      setTimeout(async () => {
        if (session.argv) return;
        // 将消息元素（elements）数组转换为自定义的字符串格式
        const messageParts = session.elements.map(element => {
          // 根据元素类型进行处理
          switch (element.type) {
            case 'text':
              return element.attrs.content;
            case 'at':
              return `[at=${element.attrs.id}]`;
            default:
              return '';
          }
        });
        // 将所有消息部分连接成一个字符串，并去除多余空格
        const sanitizedContent = messageParts.join('').trim();
        if (!sanitizedContent) return;
        // 在数据库的 'analyse_origin_msg' 表中创建一条新记录
        await ctx.database.create('analyse_origin_msg', {
          channelId: session.channelId,
          userId: session.userId,
          content: sanitizedContent,
          timestamp: new Date(session.timestamp),
        });
      }, 0);
    });
  }
}
