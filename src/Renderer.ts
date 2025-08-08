import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';

/**
 * 定义渲染列表中的单行数据格式。
 * @example ['ping', 150, new Date()]
 */
export type RenderListItem = (string | number | Date)[];

/**
 * 定义渲染图片所需的数据结构。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: RenderListItem[];
}

/**
 * @class Renderer
 * @description 通用列表渲染器，通过 Puppeteer 将数据渲染为包含精美表格的图片。
 */
export class Renderer {
  /**
   * @constructor
   * @param ctx {Context} Koishi 上下文，用于访问 puppeteer 服务。
   */
  constructor(private ctx: Context) {}

  /**
   * 将列表数据渲染为图片。
   * @param data {ListRenderData} 待渲染的列表数据。
   * @param headers {string[]} (可选) 表头文案数组，若不提供则不渲染表头。
   * @returns {Promise<string | Buffer>} 成功时返回图片 Buffer，无数据时返回提示文本。
   */
  public async renderList(data: ListRenderData, headers?: string[]): Promise<string | Buffer> {
    const htmlContent = this.generateListHtml(data, headers);
    if (!htmlContent) return '暂无数据可供渲染';
    return this.ctx.puppeteer.render(htmlContent);
  }

  /**
   * 智能格式化日期，提供相对时间（如“刚刚”，“x分钟前”）和绝对日期。
   * @param date {Date} 待格式化的日期对象。
   * @returns {string} 格式化后的日期字符串。
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';
    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';
    if (diff < Time.hour) return `${Math.floor(diff / Time.minute)} 分钟前`;
    if (diff < Time.day) return `${Math.floor(diff / Time.hour)} 小时前`;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  /**
   * 根据数据动态生成渲染图片所需的完整 HTML 字符串。
   * @param data {ListRenderData} 列表数据。
   * @param headers {string[]} (可选) 表头数组。
   * @returns {string | null} 生成的 HTML 字符串，若无数据则返回 null。
   */
  private generateListHtml(data: ListRenderData, headers?: string[]): string | null {
    const { title, time, total, list } = data;
    if (!list?.length) return null;
    const tableHeadHtml = (headers?.length > 0)
      ? `<thead><tr><th class="rank-cell">排名</th>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>`
      : '';
    const tableRowsHtml = list.map((row, index) => {
      const rank = index + 1;
      const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
      const rankCell = `<td class="rank-cell"><span class="rank-badge ${rankClass}">${rank}</span></td>`;
      const dataCells = row.map(cell => {
        if (cell instanceof Date) return `<td class="data-cell date-cell">${this.formatDate(cell)}</td>`;
        if (typeof cell === 'number') return `<td class="data-cell count-cell">${cell}</td>`;
        return `<td class="data-cell name-cell">${String(cell)}</td>`;
      }).join('');
      return `<tr>${rankCell}${dataCells}</tr>`;
    }).join('');
    const metaInfoHtml = `
      <div class="meta-group">
        ${total !== undefined ? `<div class="total-count">总计: ${total}</div>` : ''}
        <div class="time-label">生成于 ${time.toLocaleString('zh-CN', { hour12: false })}</div>
      </div>
    `;
    const styles = `
      :root {
        --bg-color: #f7f8fa; --card-bg: #ffffff; --text-color: #333; --header-color: #1f2329;
        --sub-text-color: #646a73; --border-color: #e4e6eb; --accent-color: #4a6ee0;
        --gold: #ffc327; --silver: #a8b5c1; --bronze: #d69864;
      }
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background: var(--bg-color); margin: 0; padding: 20px; width: 700px; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
      .container { background: var(--card-bg); border-radius: 12px; box-shadow: 0 6px 16px rgba(0,0,0,0.08); padding: 24px; }
      .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid var(--border-color); padding-bottom: 16px; margin-bottom: 16px; }
      .title-group h1 { font-size: 24px; font-weight: 700; color: var(--header-color); margin: 0; }
      .meta-group { text-align: right; }
      .meta-group .total-count { font-size: 22px; font-weight: 700; color: var(--accent-color); }
      .meta-group .time-label { font-size: 13px; color: var(--sub-text-color); margin-top: 4px; }
      table { width: 100%; border-collapse: collapse; color: var(--text-color); }
      th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid var(--border-color); vertical-align: middle; }
      th { font-size: 13px; font-weight: 600; color: var(--sub-text-color); }
      td { font-size: 15px; }
      tr:last-child td { border-bottom: none; }
      .rank-cell { width: 50px; text-align: center; }
      .rank-badge { display: inline-block; width: 24px; height: 24px; line-height: 24px; border-radius: 50%; font-weight: 600; font-size: 14px; color: var(--header-color); background-color: #eef0f3; }
      .rank-gold, .rank-silver, .rank-bronze { color: #fff; }
      .rank-gold { background-color: var(--gold); } .rank-silver { background-color: var(--silver); } .rank-bronze { background-color: var(--bronze); }
      .data-cell { word-break: break-all; }
      .name-cell { font-weight: 600; color: var(--header-color); }
      .count-cell { text-align: right; font-weight: 600; color: var(--accent-color); }
      .date-cell { text-align: right; font-size: 13px; color: var(--sub-text-color); }
    `;
    return `
      <!DOCTYPE html><html lang="zh-CN">
      <head><meta charset="UTF-8"><title>${title}</title><style>${styles}</style></head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title-group"><h1>${title}</h1></div>
            ${metaInfoHtml}
          </div>
          <table>${tableHeadHtml}<tbody>${tableRowsHtml}</tbody></table>
        </div>
      </body></html>`;
  }
}
