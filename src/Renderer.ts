import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';

export type RenderListItem = (string | number | Date)[];

export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: RenderListItem[];
}

/**
 * @class Renderer
 * @description 通用列表渲染器，使用 Puppeteer 将结构化数据渲染为精美的、类似卡片的表格图片。
 */
export class Renderer {
  constructor(private ctx: Context) {}

  /**
   * @public
   * @async
   * @method renderList
   * @description 将列表数据渲染为图片。
   * @param {ListRenderData} data - 待渲染的完整列表数据。
   * @param {string[]} [headers] - (可选) 表头文案数组。如果提供，将会在表格顶部渲染表头。
   * @returns {Promise<string | Buffer>} 渲染成功时返回图片的 Buffer 数据；如果输入数据为空，则返回提示文本。
   */
  public async renderList(data: ListRenderData, headers?: string[]): Promise<string | Buffer> {
    const htmlContent = this.generateListHtml(data, headers);
    if (!htmlContent) return '暂无数据可供渲染';
    return this.ctx.puppeteer.render(htmlContent);
  }

  /**
   * @private
   * @method formatDate
   * @description 将日期格式化为包含两个单位的相对时间字符串（如“21天14时前”），如果超过一年则显示绝对日期。
   * @param {Date} date - 待格式化的 Date 对象。
   * @returns {string} 格式化后的日期字符串。
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';

    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';

    // 当时间超过一年，显示具体日期更为清晰
    if (diff > 365 * Time.day) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    const timeUnits: { unit: string; ms: number }[] = [
        { unit: '月', ms: 30 * Time.day },
        { unit: '天', ms: Time.day },
        { unit: '时', ms: Time.hour },
        { unit: '分', ms: Time.minute },
    ];

    let remainingDiff = diff;
    const parts: string[] = [];

    // 从大到小提取时间单位
    for (const { unit, ms } of timeUnits) {
        if (remainingDiff >= ms) {
            const value = Math.floor(remainingDiff / ms);
            parts.push(`${value}${unit}`);
            remainingDiff %= ms;
        }
    }

    // 截取前两个最大的单位进行组合
    const result = parts.slice(0, 2).join('');

    return result ? `${result}前` : '刚刚';
  }

  /**
   * @private
   * @method generateListHtml
   * @description 根据传入的结构化数据和表头，动态生成用于 Puppeteer 渲染的完整 HTML 字符串。
   * @param {ListRenderData} data - 列表数据对象。
   * @param {string[]} [headers] - (可选) 表头数组。
   * @returns {string | null} 返回生成的 HTML 字符串。如果列表数据为空，则返回 `null`。
   */
  private generateListHtml(data: ListRenderData, headers?: string[]): string | null {
    const { title, time, total, list } = data;
    if (!list?.length) return null;

    const tableHeadHtml = (headers?.length > 0)
      ? `<thead><tr><th class="rank-cell">排名</th>${headers.map((h, i) => {
          const firstCell = list[0]?.[i];
          let headerClass = '';
          if (i === 0) headerClass = 'column-main-label';
          if (typeof firstCell === 'number' || firstCell instanceof Date) {
            headerClass += ' header-right-align';
          }
          return `<th class="${headerClass.trim()}">${h}</th>`;
        }).join('')}</tr></thead>`
      : '';

    const tableRowsHtml = list.map((row, index) => {
      const rank = index + 1;
      const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
      const rankCell = `<td class="rank-cell ${rankClass}">${rank}</td>`;
      const dataCells = row.map((cell, cellIndex) => {
        let className = 'data-cell';
        let content: string;
        if (cell instanceof Date) {
          className += ' date-cell';
          content = this.formatDate(cell);
        } else if (typeof cell === 'number') {
          className += ' count-cell';
          content = cell.toLocaleString();
        } else {
          className += ' name-cell';
          content = String(cell);
        }
        if (cellIndex === 0) className += ' column-main-label';
        return `<td class="${className}">${content}</td>`;
      }).join('');
      return `<tr>${rankCell}${dataCells}</tr>`;
    }).join('');

    const metaInfoHtml = `
      <div class="meta-group">
        ${total !== undefined ? `<div class="total-count">总计: ${typeof total === 'number' ? total.toLocaleString() : total}</div>` : ''}
        <div class="time-label">生成于 ${time.toLocaleString('zh-CN', { hour12: false })}</div>
      </div>
    `;

    const styles = `:root{--bg-color:#f7f8fa;--card-bg:#fff;--text-color:#333;--header-color:#1f2329;--sub-text-color:#646a73;--border-color:#f0f0f0;--accent-color:#4a6ee0;--gold:#ffac33;--silver:#a8b5c1;--bronze:#d69864}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:var(--bg-color);margin:0;padding:20px;width:800px;box-sizing:border-box;-webkit-font-smoothing:antialiased}.container{background:var(--card-bg);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.08);padding:20px}.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;margin-bottom:8px}.title-group h1{font-size:22px;font-weight:600;color:var(--header-color);margin:0}.meta-group{text-align:right;white-space:nowrap}.meta-group .total-count{font-size:18px;font-weight:600;color:var(--accent-color)}.meta-group .time-label{font-size:13px;color:var(--sub-text-color);margin-top:4px}table{width:100%;border-collapse:collapse;color:var(--text-color)}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border-color);vertical-align:middle}thead tr:first-child th{border-top:1px solid var(--border-color)}th{font-size:13px;font-weight:500;color:var(--sub-text-color)}td{font-size:15px}tr:last-child td{border-bottom:none}.header-right-align{text-align:right}.rank-cell{width:45px;text-align:center;font-weight:600;color:var(--sub-text-color);padding-left:0;padding-right:0}.rank-gold{color:var(--gold) !important}.rank-silver{color:var(--silver) !important}.rank-bronze{color:var(--bronze) !important}.column-main-label{width:45%}.data-cell{word-break:break-all}.name-cell{font-weight:500;color:var(--header-color)}.count-cell,.date-cell{text-align:right}.count-cell{font-weight:600;color:var(--accent-color)}.date-cell{font-size:14px;color:var(--sub-text-color)}`;

    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>${title}</title><style>${styles}</style></head><body><div class="container"><div class="header"><div class="title-group"><h1>${title}</h1></div>${metaInfoHtml}</div><table>${tableHeadHtml}<tbody>${tableRowsHtml}</tbody></table></div></body></html>`;
  }
}
