import { Context, Session } from 'koishi';

/**
 * @file collector.ts
 * @description 用于将收到的消息持久化存储到数据库中。
 */

// 扩展 Koishi 的 Tables 接口，为数据库添加类型定义
declare module 'koishi' {
  interface Tables {
    chat_origin: {
      id: number;
      channelId: string;
      userId: string;
      content: string;
      timestamp: Date;
    }
  }
}

/**
 * @class Collector
 * @description 监听所有消息，将其内容序列化后存入名为 'chat_origin' 的数据库表中。
 */
export class Collector {
  /**
   * @param ctx Koishi 的上下文对象，用于访问模型和事件系统
   */
  constructor(private ctx: Context) {
    // 为 'chat_origin' 表定义模型和字段类型
    ctx.model.extend('chat_origin', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
    });

    // 监听 'message' 事件，当机器人收到任何消息时触发
    ctx.on('message', async (session: Session) => {
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
      // 在数据库的 'chat_origin' 表中创建一条新记录
      await ctx.database.create('chat_origin', {
        channelId: session.channelId,
        userId: session.userId,
        content: sanitizedContent,
        timestamp: new Date(session.timestamp),
      });
    });
  }
}
