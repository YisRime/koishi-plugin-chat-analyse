import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';

/** 定义了渲染列表中单行数据的格式，是一个由字符串、数字或 `Date` 对象构成的数组。 */
export type RenderListItem = (string | number | Date)[];

/**
 * @interface ListRenderData
 * @description 定义了调用 `renderList` 方法所需的数据结构。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: RenderListItem[];
}

/**
 * @interface CircadianChartData
 * @description 定义了调用 `renderCircadianChart` 方法所需的数据结构。
 */
export interface CircadianChartData {
  title: string;
  time: Date;
  total: string | number;
  data: number[];
}

/**
 * @class Renderer
 * @description 负责将结构化的列表数据渲染为设计精美的 PNG 图片。
 */
export class Renderer {
  /**
   * @private @readonly
   * @property COMMON_STYLE - 存储所有卡片共享的基础 CSS 样式。
   */
  private readonly COMMON_STYLE = `:root{--card-bg:#fff;--text-color:#111827;--header-color:#111827;--sub-text-color:#6b7280;--border-color:#e5e7eb;--accent-color:#4a6ee0;--chip-bg:#f3f4f6;--stripe-bg:#f9fafb;--gold:#f59e0b;--silver:#9ca3af;--bronze:#a16207}body{display:inline-block;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:0 0;margin:0;padding:8px;-webkit-font-smoothing:antialiased}.container{display:inline-block;background:var(--card-bg);border-radius:12px;padding:0;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,.05)}.header{padding:10px 14px}.header-table{border-collapse:collapse;width:100%}.header-table-left,.header-table-right{width:1%;white-space:nowrap}.header-table-left{text-align:left}.header-table-center{text-align:center}.header-table-right{text-align:right}.title-text{font-size:18px;font-weight:600;color:var(--header-color);margin:0}.stat-chip,.time-label{display:inline-flex;align-items:baseline;padding:4px 8px;border-radius:8px;background:var(--chip-bg);font-size:13px;color:var(--sub-text-color)}.stat-chip span{font-weight:600;color:var(--text-color);margin-left:4px}`;

  constructor(private ctx: Context) {}

  /**
   * @private
   * @method generateFullHtml
   * @description 将卡片内容和特定样式组合成一个完整的 HTML 文档。
   * @param cardContent - 卡片部分的 HTML 字符串。
   * @param specificStyles - 该卡片类型独有的 CSS 样式字符串。
   * @returns 完整的 HTML 字符串。
   */
  private generateFullHtml(cardContent: string, specificStyles: string): string {
    return `<!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>${this.COMMON_STYLE}${specificStyles}</style>
      </head>
      <body>
        ${cardContent}
      </body>
      </html>`;
  }

  private async htmlToImage(fullHtmlContent: string): Promise<Buffer | null> {
    const page = await this.ctx.puppeteer.page();
    try {
      await page.setViewport({ width: 720, height: 1080, deviceScaleFactor: 2.0 });
      await page.setContent(fullHtmlContent, { waitUntil: 'networkidle0' });
      const dimensions = await page.evaluate(() => ({ width: document.body.scrollWidth, height: document.body.scrollHeight }));
      await page.setViewport({ ...dimensions, deviceScaleFactor: 2.0 });
      return await page.screenshot({ type: 'png', fullPage: true, omitBackground: true });
    } catch (error) {
      this.ctx.logger.error('图片渲染失败:', error);
      return null;
    } finally {
      if (page) await page.close().catch(e => this.ctx.logger.error('关闭页面失败:', e));
    }
  }

  private formatDate(date: Date): string {
    if (!date) return '未知';
    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';
    if (diff > 365 * Time.day) return date.toLocaleDateString('zh-CN').replace(/\//g, '-');

    const timeUnits: [string, number][] = [['月', 30 * Time.day], ['天', Time.day], ['时', Time.hour], ['分', Time.minute]];
    for (const [unit, ms] of timeUnits) {
      if (diff >= ms) return `${Math.floor(diff / ms)}${unit}前`;
    }
    return '刚刚';
  }

  public async renderList(data: ListRenderData, headers?: string[]): Promise<string | Buffer[]> {
    const { title, time, list } = data;
    if (!list?.length) return '暂无数据可供渲染';

    const CHUNK_SIZE = 100;
    const imageBuffers: Buffer[] = [];
    const totalItems = list.length;

    const countHeaderIndex = headers?.findIndex(h => ['总计发言', '条数', '次数', '数量'].includes(h)) ?? -1;
    const totalCount = data.total || (countHeaderIndex > -1 ? list.reduce((sum, row) => sum + (Number(row[countHeaderIndex]) || 0), 0) : totalItems);

    const renderCell = (cell: any, i: number) => {
      const headerText = headers?.[i] || '';
      if (headerText.includes('占比')) {
        const percentValue = parseFloat(String(cell).replace('%', ''));
        return `<td class="percent-cell"><div class="percent-bar" style="width: ${percentValue}%;"></div><span class="percent-text">${cell}</span></td>`;
      }
      if (cell instanceof Date) return `<td class="date-cell">${this.formatDate(cell)}</td>`;
      if (typeof cell === 'number') return `<td class="count-cell">${cell.toLocaleString()}</td>`;
      return `<td class="name-cell">${String(cell)}</td>`;
    };

    const totalPages = Math.ceil(totalItems / CHUNK_SIZE);

    const listStyles = `.table-container{border-top:1px solid var(--border-color)}.main-table{border-collapse:collapse;width:100%}.main-table th,.main-table td{padding:8px 14px;vertical-align:middle}.main-table th{font-size:12px;font-weight:500;color:var(--sub-text-color);text-transform:uppercase;letter-spacing:.05em;background:var(--stripe-bg)}.main-table td{font-size:14px;color:var(--text-color)}.main-table tbody tr:nth-child(even){background-color:var(--stripe-bg)}.main-table .name-cell,.main-table .name-header{text-align:left}.main-table .rank-cell,.main-table .count-cell,.main-table .date-cell,.main-table .percent-cell,.main-table .header-right-align{text-align:right;white-space:nowrap;width:1%;font-variant-numeric:tabular-nums}.name-cell{font-weight:500}.rank-cell{font-weight:500;color:var(--sub-text-color)}.count-cell{font-weight:600;color:var(--accent-color)}.date-cell{color:var(--sub-text-color)}.rank-gold,.rank-silver,.rank-bronze{font-weight:600}.rank-gold{color:var(--gold)!important}.rank-silver{color:var(--silver)!important}.rank-bronze{color:var(--bronze)!important}.percent-cell{position:relative}.percent-bar{position:absolute;top:0;right:0;height:100%;background-color:var(--accent-color);opacity:.15}.percent-text{position:relative;z-index:1}`;

    for (let i = 0; i < totalItems; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE);
      const pageNum = Math.floor(i / CHUNK_SIZE) + 1;
      const pageTitle = totalPages > 1 ? `${title} (第 ${pageNum}/${totalPages} 页)` : title;

      const tableRowsHtml = chunk.map((row, index) => {
        const rank = i + index + 1;
        const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
        return `<tr><td class="rank-cell ${rankClass}">${rank}</td>${row.map(renderCell).join('')}</tr>`;
      }).join('');

      const tableHeadHtml = headers?.length ? `<thead><tr><th class="rank-cell">#</th>${headers.map(h => `<th class="${typeof list[0]?.[headers.indexOf(h)] === 'string' ? 'name-header' : 'header-right-align'}">${h}</th>`).join('')}</tr></thead>` : '';

      const cardHtml = `<div class="container"><div class="header"><table class="header-table"><tr><td class="header-table-left"><div class="stat-chip">总计: <span>${typeof totalCount === 'number' ? totalCount.toLocaleString() : totalCount}</span></div></td><td class="header-table-center"><h1 class="title-text">${pageTitle}</h1></td><td class="header-table-right"><div class="time-label">${time.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')}</div></td></tr></table></div><div class="table-container"><table class="main-table">${tableHeadHtml}<tbody>${tableRowsHtml}</tbody></table></div></div>`;

      const fullHtml = this.generateFullHtml(cardHtml, listStyles);
      const imageBuffer = await this.htmlToImage(fullHtml);
      if (imageBuffer) imageBuffers.push(imageBuffer);
    }

    return imageBuffers.length > 0 ? imageBuffers : '图片渲染失败';
  }

  public async renderCircadianChart(data: CircadianChartData): Promise<string | Buffer[]> {
    const { title, time, total, data: hourlyCounts } = data;
    if (!hourlyCounts || hourlyCounts.every(c => c === 0)) return '暂无数据可供渲染';

    const maxCount = Math.max(...hourlyCounts, 1);
    const barsHtml = hourlyCounts.map((count, hour) => {
      const barHeight = (count / maxCount) * 100;
      const isPeak = count > 0 && count === maxCount;
      return `<div class="bar-wrapper"><div class="bar-value ${count === 0 ? 'hidden' : ''}">${count}</div><div class="bar-container"><div class="bar ${isPeak ? 'peak' : ''}" style="height: ${barHeight}%;"></div></div><div class="bar-label">${hour}</div></div>`;
    }).join('');

    const cardHtml = `<div class="container"><div class="header"><table class="header-table"><tr><td class="header-table-left"><div class="stat-chip">总计: <span>${typeof total === 'number' ? total.toLocaleString() : total}</span></div></td><td class="header-table-center"><h1 class="title-text">${title}</h1></td><td class="header-table-right"><div class="time-label">${time.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')}</div></td></tr></table></div><div class="chart-container">${barsHtml}</div></div>`;

    const chartStyles = `.chart-container{display:flex;align-items:flex-end;gap:4px;height:180px;padding:30px 15px 10px;border-top:1px solid var(--border-color)}.bar-wrapper{flex:1;text-align:center;display:flex;flex-direction:column;height:100%;justify-content:flex-end}.bar-value{font-size:11px;color:var(--sub-text-color);height:16px;line-height:16px;font-weight:500}.bar-value.hidden{visibility:hidden}.bar-container{flex-grow:1;display:flex;align-items:flex-end;width:100%}.bar{width:100%;background-color:var(--accent-color);opacity:.7;border-radius:3px 3px 0 0;transition:height .3s ease-out}.bar.peak{opacity:1;background-color:var(--gold)!important}.bar-label{font-size:10px;color:var(--sub-text-color);margin-top:4px;height:12px}`;

    const fullHtml = this.generateFullHtml(cardHtml, chartStyles);
    const imageBuffer = await this.htmlToImage(fullHtml);

    return imageBuffer ? [imageBuffer] : '图片渲染失败';
  }
}
