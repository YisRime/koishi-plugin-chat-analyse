import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';

/**
 * 渲染列表中的一行数据。每个元素代表一列。
 * 这是一个灵活的元组类型，可以包含字符串、数字或日期。
 * @example ['ping', 150, new Date()]
 */
export type RenderListItem = (string | number | Date)[];

/**
 * 渲染列表图片所需的数据结构。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: RenderListItem[];
}

/**
 * @class Renderer
 * @description 使用 Puppeteer 服务将格式化的数据渲染成图片。
 * 这是一个通用的列表渲染器，能够处理任意列数的数据，并根据数据类型智能应用样式。
 */
export class Renderer {
  /**
   * @constructor
   * @param ctx {Context} Koishi 的上下文对象
   */
  constructor(private ctx: Context) {}

  /**
   * 将列表数据渲染为图片。
   * @param data {ListRenderData} 待渲染的列表数据。
   * @param headers {string[]} (可选) 表头数组。如果不提供或为空，则不渲染表头部分。
   * @returns {Promise<string | Buffer>} 成功时返回图片 Buffer，失败或无数据时返回提示文本。
   */
  public async renderList(data: ListRenderData, headers?: string[]): Promise<string | Buffer> {
    const htmlContent = this.generateListHtml(data, headers);
    return this.ctx.puppeteer.render(htmlContent);
  }

  /**
   * 格式化日期，提供相对时间和绝对时间显示。
   * @param date {Date} 日期对象
   * @returns {string} 格式化后的日期字符串
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';
    const now = Date.now();
    const diff = now - date.getTime();

    if (diff < Time.minute) return '刚刚';
    if (diff < Time.hour) return `${Math.floor(diff / Time.minute)} 分钟前`;
    if (diff < Time.day) return `${Math.floor(diff / Time.hour)} 小时前`;

    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /**
   * 根据列表数据动态生成 HTML 字符串。
   * @param data {ListRenderData} 列表数据
   * @param headers {string[]} (可选) 表头数组
   * @returns {string | null} 生成的 HTML 字符串，如果无数据则返回 null。
   */
  private generateListHtml(data: ListRenderData, headers?: string[]): string | null {
    const { title, time, total, list } = data;

    if (!list || list.length === 0) return null;

    // 根据是否提供了 headers 来决定是否生成表头
    let tableHeadHtml = '';
    if (headers && headers.length > 0) {
      const numDataColumns = list[0].length;
      const headerCells = [];

      for (let i = 0; i < numDataColumns; i++) {
        const headerText = headers[i] || '';
        headerCells.push(`<th>${headerText}</th>`);
      }

      const allHeaders = `<th class="rank-cell">排名</th>${headerCells.join('')}`;
      tableHeadHtml = `<thead><tr>${allHeaders}</tr></thead>`;
    }

    // 表格行的生成逻辑，它总是基于数据本身
    const tableRows = list.map((rowItems, index) => {
      const rank = index + 1;
      let rankClass = '';
      if (rank === 1) rankClass = 'rank-gold';
      if (rank === 2) rankClass = 'rank-silver';
      if (rank === 3) rankClass = 'rank-bronze';

      const rankCell = `<td class="rank-cell"><span class="rank-badge ${rankClass}">${rank}</span></td>`;

      const dataCells = rowItems.map((cellData) => {
        let cellClass = 'data-cell';
        let content: string | number;

        // 根据数据类型决定样式和内容格式
        if (cellData instanceof Date) {
          cellClass += ' date-cell';
          content = this.formatDate(cellData);
        } else if (typeof cellData === 'number') {
          cellClass += ' count-cell';
          content = cellData;
        } else {
          cellClass += ' name-cell';
          content = String(cellData);
        }

        return `<td class="${cellClass}">${content}</td>`;
      }).join('');

      return `<tr>${rankCell}${dataCells}</tr>`;
    }).join('');

    // 右上角元信息的生成
    const metaInfo = (total !== undefined)
      ? `<div class="total-count">总计: ${total}</div>`
      : '';

    const timeLabel = `生成于 ${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')} ${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

    // 完整的 CSS 样式
    const styles = `
      :root {
        --bg-color: #f7f8fa; --card-bg: #ffffff; --text-color: #333;
        --header-color: #1f2329; --sub-text-color: #646a73;
        --border-color: #e4e6eb; --accent-color: #4a6ee0;
        --gold: #ffc327; --silver: #a8b5c1; --bronze: #d69864;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        background: var(--bg-color); margin: 0; padding: 20px;
        width: 700px; box-sizing: border-box;
        -webkit-font-smoothing: antialiased;
      }
      .container { background: var(--card-bg); border-radius: 12px; box-shadow: 0 6px 16px rgba(0,0,0,0.08); padding: 24px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 16px; }
      .title-group h1 { font-size: 24px; font-weight: 700; color: var(--header-color); margin: 0; }
      .meta-group { text-align: right; }
      .meta-group .total-count { font-size: 22px; font-weight: 700; color: var(--accent-color); }
      .meta-group .time-label { font-size: 13px; color: var(--sub-text-color); margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; color: var(--text-color); }
      th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid var(--border-color); }
      th { font-size: 13px; font-weight: 600; color: var(--sub-text-color); }
      td { font-size: 15px; vertical-align: middle; }
      tr:last-child td { border-bottom: none; }
      .rank-cell { width: 50px; text-align: center; }
      .rank-badge { display: inline-block; width: 24px; height: 24px; line-height: 24px; border-radius: 50%; font-weight: 600; font-size: 14px; color: var(--header-color); background-color: #eef0f3; }
      .rank-gold { background-color: var(--gold); color: #fff; }
      .rank-silver { background-color: var(--silver); color: #fff; }
      .rank-bronze { background-color: var(--bronze); color: #fff; }
      .data-cell { word-break: break-all; }
      .name-cell { font-weight: 600; color: var(--header-color); }
      .count-cell { text-align: right; font-weight: 600; color: var(--accent-color); }
      .date-cell { text-align: right; font-size: 13px; color: var(--sub-text-color); }
    `;

    // 拼接成最终的 HTML
    return `
      <!DOCTYPE html><html lang="zh-CN">
      <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title><style>${styles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title-group"><h1>${title}</h1></div>
            <div class="meta-group">${metaInfo}<div class="time-label">${timeLabel}</div></div>
          </div>
          <table>
            ${tableHeadHtml}
            <tbody>${tableRows}</tbody>
          </table>
        </div>
      </body></html>
    `;
  }
}
