import { Context, Session, Argv, Element } from 'koishi';

/**
 * @file collector.ts
 * @description 通过独立的事件监听器，分别持久化存储收到的普通消息和已确认的命令，并高效地维护ID与名称的映射。
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
    analyse_name_map: {
      id: number;
      channelId: string;
      channelName: string;
      userId: string;
      userName: string;
      timestamp: Date;
    }
  }
}

/**
 * @class Collector
 * @description 使用双监听器，精确捕获并存储消息和命令，并维护一个ID到名称的映射表。
 */
export class Collector {
  private nameCache = new Map<string, string>();

  constructor(private ctx: Context) {
    ctx.model.extend('analyse_origin_msg', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
      indexes: ['channelId', 'userId', 'timestamp'],
    });

    ctx.model.extend('analyse_origin_cmd', {
      id: 'unsigned',
      channelId: 'string',
      userId: 'string',
      command: 'string',
      content: 'text',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
      indexes: ['channelId', 'userId', 'command', 'timestamp'],
    });

    ctx.model.extend('analyse_name_map', {
      id: 'unsigned',
      channelId: 'string',
      channelName: 'string',
      userId: 'string',
      userName: 'string',
      timestamp: 'timestamp',
    }, {
      autoInc: true,
      unique: [['channelId', 'userId']],
    });

    ctx.on('command/before-execute', async (argv: Argv) => {
      const effectiveId = argv.session.channelId || argv.session.guildId;
      if (!effectiveId) return;

      await ctx.database.create('analyse_origin_cmd', {
        channelId: effectiveId,
        userId: argv.session.userId,
        command: argv.command.name,
        content: argv.session.content,
        timestamp: new Date(argv.session.timestamp),
      });
    });

    ctx.on('message', async (session: Session) => {
      const { userId, author } = session;
      const effectiveId = session.channelId || session.guildId;
      const { channelName, guildName } = (session as { channelName?: string; guildName?: string });
      const effectiveName = channelName || guildName;
      const currentName = author?.name || author?.nick;

      if (currentName && effectiveName && effectiveId && userId) {
        const cacheKey = `${effectiveId}:${userId}`;
        const cachedName = this.nameCache.get(cacheKey);

        if (cachedName && currentName !== cachedName) await this.updateName(effectiveId, effectiveName, userId, currentName);
        else if (!cachedName) {
          const dbRecord = await ctx.database.get('analyse_name_map', {
            channelId: effectiveId,
            userId: userId,
          });

          const dbName = dbRecord[0]?.userName;

          if (!dbName || currentName !== dbName) await this.updateName(effectiveId, effectiveName, userId, currentName);
          else this.nameCache.set(cacheKey, currentName);
        }
      }

      if (session.argv?.command) return;
      if (!effectiveId) return;

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
        channelId: effectiveId,
        userId: session.userId,
        content: sanitizedContent,
        timestamp: new Date(session.timestamp),
      });
    });
  }

  private async updateName(channelId: string, channelName: string, userId: string, userName: string) {
    await this.ctx.database.upsert('analyse_name_map', [{
      channelId: channelId,
      channelName: channelName,
      userId: userId,
      userName: userName,
      timestamp: new Date(),
    }]);
    this.nameCache.set(`${channelId}:${userId}`, userName);
  }
}
