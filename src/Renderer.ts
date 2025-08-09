import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';

/**
 * 定义了渲染列表中单行数据的格式。它是一个由字符串、数字或 `Date` 对象组成的数组。
 */
export type RenderListItem = (string | number | Date)[];

/**
 * @interface ListRenderData
 * @description 定义了调用 `renderList` 方法所需的数据结构。
 * 它包含了渲染一张完整列表图片所必需的所有信息。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: RenderListItem[];
}

/**
 * @class Renderer
 * @classdesc
 * 负责将结构化的数据（特别是列表）转换为设计精美的PNG图片。
 * 其核心特性是能够动态计算内容尺寸，生成布局紧凑、自适应的图片。
 */
export class Renderer {
  /**
   * @param {Context} ctx - Koishi 的插件上下文，用于访问核心服务如 `puppeteer` 和 `logger`。
   */
  constructor(private ctx: Context) {}

  /**
   * @private
   * @method htmlToImage
   * @description
   * 负责将任意HTML字符串转换为PNG图片Buffer。
   * @param {string} html - 要渲染的HTML主体内容（不包含 `<html>` 和 `<body>` 标签）。
   * @returns {Promise<Buffer>} 返回一个包含PNG图片数据的 Buffer 对象。
   * @throws {Error} 如果 Puppeteer 截图过程中发生错误，将抛出异常。
   */
  private async htmlToImage(html: string): Promise<Buffer> {
    let page = null;
    try {
      page = await this.ctx.puppeteer.page();
      await page.setViewport({ width: 720, height: 1080, deviceScaleFactor: 2.0 });
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
              :root {
                --card-bg: #ffffff; --text-color: #111827; --header-color: #111827;
                --sub-text-color: #6b7280; --border-color: #e5e7eb; --accent-color: #3b82f6;
                --chip-bg: #f3f4f6; --stripe-bg: #f9fafb; --gold: #f59e0b; --silver: #9ca3af; --bronze: #a16207;
              }
              body {
                display: inline-block; /* Crucial for shrink-wrapping */
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: transparent; margin: 0; padding: 10px;
                -webkit-font-smoothing: antialiased;
              }
              .container {
                display: inline-block; background: var(--card-bg);
                border-radius: 12px; padding: 0; overflow: hidden;
                box-shadow: 0 2px 4px rgba(0,0,0,0.05);
              }
              .header { padding: 12px 16px; }
              .header-table { border-collapse: collapse; table-layout: auto; width: 100%; }
              .header-table-left, .header-table-right { width: 1%; white-space: nowrap; }
              .header-table-left { text-align: left; }
              .header-table-center { text-align: center; }
              .header-table-right { text-align: right; }
              .title-text { font-size: 18px; font-weight: 600; color: var(--header-color); margin: 0; }
              .stat-chip, .time-label {
                display: inline-flex; align-items: baseline; padding: 5px 10px; border-radius: 8px;
                background: var(--chip-bg); font-size: 13px; color: var(--sub-text-color);
              }
              .stat-chip span { font-weight: 600; color: var(--text-color); margin-left: 4px; }
              .table-container { border-top: 1px solid var(--border-color); }
              .main-table { border-collapse: collapse; table-layout: auto; width: 100%; }
              .main-table th, .main-table td {
                padding: 10px 16px;
                vertical-align: middle;
              }
              .main-table th {
                font-size: 12px; font-weight: 500; color: var(--sub-text-color);
                text-transform: uppercase; letter-spacing: 0.05em; background: var(--stripe-bg);
              }
              .main-table td { font-size: 14px; color: var(--text-color); }
              .main-table tbody tr:nth-child(even) { background-color: var(--stripe-bg); }
              .main-table .name-cell, .main-table .name-header {
                text-align: left;
                white-space: normal;
              }
              .main-table .rank-cell, .main-table .count-cell, .main-table .date-cell, .main-table .percent-cell, .main-table .header-right-align {
                text-align: right;
                white-space: nowrap;
                width: 1%;
                font-variant-numeric: tabular-nums;
              }
              .name-cell { font-weight: 500; }
              .rank-cell { font-weight: 500; color: var(--sub-text-color); }
              .count-cell { font-weight: 600; color: var(--accent-color); }
              .date-cell { color: var(--sub-text-color); }
              .rank-gold, .rank-silver, .rank-bronze { font-weight: 600; }
              .rank-gold { color: var(--gold) !important; }
              .rank-silver { color: var(--silver) !important; }
              .rank-bronze { color: var(--bronze) !important; }
              .percent-cell { position: relative; }
              .percent-bar { position: absolute; top: 0; left: 0; height: 100%; background-color: var(--accent-color); opacity: 0.1; }
              .percent-text { position: relative; z-index: 1; }
            </style>
          </head>
          <body>${html}</body>
        </html>
      `, { waitUntil: 'networkidle0' });

      const dimensions = await page.evaluate(() => {
        const el = document.body;
        return {
          width: el.scrollWidth,
          height: el.scrollHeight
        };
      });

      await page.setViewport({ ...dimensions, deviceScaleFactor: 2.0 });
      return await page.screenshot({ type: 'png', fullPage: true, omitBackground: true });
    } catch (error) {
      this.ctx.logger.error('图片渲染出错:', error);
      throw new Error(`图片渲染出错: ${error.message || '未知错误'}`);
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  /**
   * @private
   * @method formatDate
   * @description
   * 将 `Date` 对象格式化为人类友好的相对时间字符串。
   * @param {Date} date - 需要格式化的日期对象。
   * @returns {string} - 格式化后的时间字符串。
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';
    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';
    if (diff > 365 * Time.day) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    const timeUnits: { unit: string; ms: number }[] = [
        { unit: '月', ms: 30 * Time.day }, { unit: '天', ms: Time.day },
        { unit: '时', ms: Time.hour }, { unit: '分', ms: Time.minute },
    ];
    let remainingDiff = diff;
    const parts: string[] = [];
    for (const { unit, ms } of timeUnits) {
        if (remainingDiff >= ms) {
            const value = Math.floor(remainingDiff / ms);
            parts.push(`${value}${unit}`);
            remainingDiff %= ms;
        }
    }
    const result = parts.slice(0, 2).join('');
    return result ? `${result}前` : '刚刚';
  }

  /**
   * @public
   * @method renderList
   * @description
   * 接收一个标准化的 `ListRenderData` 对象和可选的表头数组，
   * 然后构建一个包含标题、统计信息和数据表格的完整HTML卡片。
   * @param {ListRenderData} data - 包含渲染所需全部信息的对象。
   * @param {string[]} [headers] - (可选) 表格的表头字符串数组。如果提供，将渲染表头。
   * @returns {Promise<string | Buffer>}
   * 如果成功，返回包含PNG图片的 Buffer。如果输入的数据列表为空，则返回一个提示性字符串。
   */
  public async renderList(data: ListRenderData, headers?: string[]): Promise<string | Buffer> {
    const { title, time, list } = data;
    if (!list?.length) return '暂无数据可供渲染';

    let totalValueForPercent = 0;
    const countHeaderIndex = headers?.findIndex(h => ['总计发言', '条数', '次数', '数量'].includes(h));
    if (countHeaderIndex > -1) {
      totalValueForPercent = list.reduce((sum, row) => sum + (Number(row[countHeaderIndex]) || 0), 0);
    }
    const totalCount = data.total || totalValueForPercent;

    const tableHeadHtml = (headers?.length > 0)
      ? `<thead><tr><th class="rank-cell">#</th>${headers.map((h, i) => {
          const firstCell = list[0]?.[i];
          const isRightAlign = typeof firstCell === 'number' || firstCell instanceof Date || h.includes('占比');
          const alignClass = isRightAlign ? 'header-right-align' : 'name-header';
          return `<th class="${alignClass}">${h}</th>`;
        }).join('')}</tr></thead>`
      : '';

    const tableRowsHtml = list.map((row, index) => {
      const rank = index + 1;
      const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
      const rankCell = `<td class="rank-cell ${rankClass}">${rank}</td>`;
      const dataCells = row.map((cell, i) => {
        let className = '';
        let content: string;
        const headerText = headers?.[i] || '';

        if (headerText.includes('占比')) {
          className = 'percent-cell';
          const percentValue = parseFloat(String(cell).replace('%',''));
          content = `<div class="percent-bar" style="width: ${percentValue}%;"></div><span class="percent-text">${cell}</span>`;
        } else if (cell instanceof Date) {
          className = 'date-cell';
          content = this.formatDate(cell);
        } else if (typeof cell === 'number') {
          className = 'count-cell';
          content = cell.toLocaleString();
        } else {
          className = 'name-cell';
          content = String(cell);
        }
        return `<td class="${className}">${content}</td>`;
      }).join('');
      return `<tr>${rankCell}${dataCells}</tr>`;
    }).join('');

    const cardHtml = `
      <div class="container">
        <div class="header">
          <table class="header-table">
            <tr>
              <td class="header-table-left">
                <div class="stat-chip">总计: <span>${typeof totalCount === 'number' ? totalCount.toLocaleString() : totalCount}</span></div>
              </td>
              <td class="header-table-center">
                <h1 class="title-text">${title}</h1>
              </td>
              <td class="header-table-right">
                <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')}</div>
              </td>
            </tr>
          </table>
        </div>
        <div class="table-container">
          <table class="main-table">${tableHeadHtml}<tbody>${tableRowsHtml}</tbody></table>
        </div>
      </div>
    `;

    return this.htmlToImage(cardHtml);
  }
}
