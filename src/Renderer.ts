import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';
import { WordCloudData } from './Analyse';

/**
 * @interface ListRenderData
 * @description 定义了调用 `renderList` 方法所需的数据结构。
 */
export interface ListRenderData {
  title: string;
  time: Date;
  total?: string | number;
  list: (string | number | Date)[][];
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
  labels?: string[];
}

/**
 * @class Renderer
 * @description 负责将结构化的数据渲染为设计精美的 PNG 图片。
 */
export class Renderer {
  private readonly COMMON_STYLE = `
    :root {
      --card-bg: #fff; --text-color: #111827; --header-color: #111827;
      --sub-text-color: #6b7280; --border-color: #e5e7eb; --accent-color: #4a6ee0;
      --chip-bg: #f3f4f6; --stripe-bg: #f9fafb; --gold: #f59e0b;
      --silver: #9ca3af; --bronze: #a16207;
    }
    body {
      display: inline-block; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI',
      Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: transparent; margin: 0; padding: 8px;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      display: inline-block; background: var(--card-bg); border-radius: 12px;
      padding: 0; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,.05);
    }
    .header {
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
    }
    .title-text {
      font-size: 18px; font-weight: 600; color: var(--header-color);
      margin: 0; text-align: center;
    }
    .stat-chip, .time-label {
      display: inline-flex; align-items: baseline; padding: 4px 8px;
      border-radius: 8px; background: var(--chip-bg);
      font-size: 13px; color: var(--sub-text-color);
      white-space: nowrap;
    }
    .stat-chip span {
      font-weight: 600; color: var(--text-color); margin-left: 4px;
    }
  `;

  /**
   * @constructor
   * @description Renderer 类的构造函数。
   * @param {Context} ctx - Koishi 的插件上下文，用于访问 logger 和 puppeteer 服务。
   */
  constructor(private ctx: Context) {}

  /**
   * @private
   * @method generateFullHtml
   * @description 将卡片内容和特定样式组合成一个完整的 HTML 文档，以便进行渲染。
   * @param {string} cardContent - 卡片主体部分的 HTML 字符串。
   * @param {string} specificStyles - 针对该卡片类型的特定 CSS 样式字符串。
   * @returns {string} - 一个完整的、可被浏览器渲染的 HTML 字符串。
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

  /**
   * @private
   * @method htmlToImage
   * @description 使用 puppeteer 将给定的 HTML 字符串内容渲染成 PNG 图片的 Buffer。
   * @param {string} fullHtmlContent - 完整的 HTML 内容字符串。
   * @returns {Promise<Buffer | null>} - 成功时返回包含 PNG 图片数据的 Buffer，失败则返回 null。
   */
  private async htmlToImage(fullHtmlContent: string): Promise<Buffer | null> {
    const page = await this.ctx.puppeteer.page();
    try {
      await page.setViewport({ width: 850, height: 10, deviceScaleFactor: 2.0 });
      await page.setContent(fullHtmlContent, { waitUntil: 'networkidle0' });
      const { width, height } = await page.evaluate(() => ({
          width: document.body.scrollWidth,
          height: document.body.scrollHeight
      }));
      await page.setViewport({ width, height, deviceScaleFactor: 2.0 });
      return await page.screenshot({ type: 'png', omitBackground: true });
    } catch (error) {
      this.ctx.logger.error('图片渲染失败:', error);
      return null;
    } finally {
      await page.close().catch(e => this.ctx.logger.error('关闭页面失败:', e));
    }
  }

  /**
   * @private
   * @method formatDate
   * @description 将 Date 对象格式化为易于理解的相对时间字符串（如“刚刚”，“5分钟前”）。
   * @param {Date} date - 需要格式化的日期对象。
   * @returns {string} - 格式化后的时间字符串。
   */
  private formatDate(date: Date): string {
    if (!date) return '未知';
    const diff = Date.now() - date.getTime();
    if (diff < Time.minute) return '刚刚';
    if (diff > 365 * Time.day) return date.toLocaleDateString('zh-CN');

    const units: [string, number][] = [['月', 30 * Time.day], ['天', Time.day], ['小时', Time.hour], ['分钟', Time.minute]];
    for (const [unit, ms] of units) {
      if (diff >= ms) return `${Math.floor(diff / ms)}${unit}前`;
    }
    return '刚刚';
  }

  /**
   * @public
   * @method renderList
   * @description 将表格型数据渲染成一个或多个列表形式的图片。如果数据过多，会自动进行分页渲染。
   * @param {ListRenderData} data - 包含标题、时间、总计和列表数据的对象。
   * @param {string[]} [headers] - （可选）列表的表头数组。
   * @returns {Promise<string | Buffer[]>} - 成功时返回包含图片 Buffer 的数组，失败或无数据时返回提示字符串。
   */
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
        return `<td class="percent-cell"><div class="percent-bar" style="width: ${String(cell)};"></div><span class="percent-text">${cell}</span></td>`;
      }
      if (cell instanceof Date) return `<td class="date-cell">${this.formatDate(cell)}</td>`;
      if (typeof cell === 'number') return `<td class="count-cell">${cell.toLocaleString()}</td>`;
      return `<td class="name-cell">${String(cell)}</td>`;
    };

    const listStyles = `
      .table-container { padding: 0; }
      .main-table { border-collapse: collapse; width: 100%; }
      .main-table th, .main-table td { padding: 9px 16px; vertical-align: middle; text-align: left; }
      .main-table thead { border-bottom: 1px solid var(--border-color); }
      .main-table th { font-size: 12px; font-weight: 500; color: var(--sub-text-color); text-transform: uppercase; }
      .main-table td { font-size: 14px; color: var(--text-color); }
      .main-table tbody tr:nth-child(even) { background-color: var(--stripe-bg); }
      .rank-cell, .count-cell, .date-cell, .percent-cell { text-align: right; white-space: nowrap; width: 1%; font-variant-numeric: tabular-nums; }
      .name-cell { font-weight: 500; }
      .rank-cell { font-weight: 600; color: var(--sub-text-color); }
      .count-cell { font-weight: 600; color: var(--accent-color); }
      .rank-gold, .rank-silver, .rank-bronze { font-weight: 700; }
      .rank-gold { color: var(--gold) !important; }
      .rank-silver { color: var(--silver) !important; }
      .rank-bronze { color: var(--bronze) !important; }
      .percent-cell { position: relative; padding-right: 20px; }
      .percent-bar { position: absolute; top: 50%; right: 0; transform: translateY(-50%); height: 6px; background-color: var(--accent-color); opacity: .2; border-radius: 3px; }
      .percent-text { position: relative; z-index: 1; }
    `;

    for (let i = 0; i < totalItems; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE);
      const pageNum = Math.floor(i / CHUNK_SIZE) + 1;
      const pageTitle = totalItems > CHUNK_SIZE ? `${title} (第 ${pageNum}/${Math.ceil(totalItems / CHUNK_SIZE)} 页)` : title;

      const cardHtml = `
        <div class="container">
          <div class="header">
            <div class="stat-chip">总计: <span>${typeof totalCount === 'number' ? totalCount.toLocaleString() : totalCount}</span></div>
            <h1 class="title-text">${pageTitle}</h1>
            <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
          </div>
          <div class="table-container">
            <table class="main-table">
              ${headers?.length ? `
                <thead>
                  <tr>
                    <th class="rank-cell">#</th>
                    ${headers.map(h => `<th>${h}</th>`).join('')}
                  </tr>
                </thead>` : ''
              }
              <tbody>
                ${chunk.map((row, index) => {
                  const rank = i + index + 1;
                  const rankClass = rank === 1 ? 'rank-gold' : rank === 2 ? 'rank-silver' : rank === 3 ? 'rank-bronze' : '';
                  return `<tr><td class="rank-cell ${rankClass}">${rank}</td>${row.map(renderCell).join('')}</tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>`;

      const fullHtml = this.generateFullHtml(cardHtml, listStyles);
      const imageBuffer = await this.htmlToImage(fullHtml);
      if (imageBuffer) imageBuffers.push(imageBuffer);
    }

    return imageBuffers.length > 0 ? imageBuffers : '图片渲染失败';
  }

  /**
   * @public
   * @method renderCircadianChart
   * @description 将 24 小时制的活跃度数据渲染成一张柱状图图片。
   * @param {CircadianChartData} data - 包含标题、时间、总计和 24 小时数据数组的对象。
   * @returns {Promise<string | Buffer[]>} - 成功时返回包含图片 Buffer 的数组，失败或无数据时返回提示字符串。
   */
  public async renderCircadianChart(data: CircadianChartData): Promise<string | Buffer[]> {
    const { title, time, total, data: hourlyCounts, labels } = data;
    if (!hourlyCounts || hourlyCounts.every(c => c === 0)) return '暂无数据可供渲染';

    const maxCount = Math.max(...hourlyCounts, 1);
    const chartStyles = `
      .chart-container { display: flex; align-items: flex-end; gap: 4px; height: 180px; padding: 30px 15px 10px; }
      .bar-wrapper { flex: 1; text-align: center; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
      .bar-value { font-size: 11px; color: var(--sub-text-color); height: 16px; line-height: 16px; font-weight: 500; }
      .bar-container { flex-grow: 1; display: flex; align-items: flex-end; width: 100%; }
      .bar { width: 100%; background-color: var(--accent-color); opacity: .7; border-radius: 3px 3px 0 0; transition: height .3s ease-out; }
      .bar-label { font-size: 10px; color: var(--sub-text-color); margin-top: 4px; height: 12px; }
    `;

    const cardHtml = `
      <div class="container">
        <div class="header">
          <div class="stat-chip">总计: <span>${typeof total === 'number' ? total.toLocaleString() : total}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div class="chart-container">
          ${hourlyCounts.map((count, hour) => `
            <div class="bar-wrapper">
              <div class="bar-value">${count > 0 ? count : ''}</div>
              <div class="bar-container">
                <div class="bar" style="height: ${(count / maxCount) * 100}%;"></div>
              </div>
              <div class="bar-label">${labels ? labels[hour] : hour}</div>
            </div>`).join('')
          }
        </div>
      </div>`;

    const fullHtml = this.generateFullHtml(cardHtml, chartStyles);
    const imageBuffer = await this.htmlToImage(fullHtml);

    return imageBuffer ? [imageBuffer] : '图片渲染失败';
  }

  /**
   * @public
   * @method renderWordCloud
   * @description 将词频数据渲染成一张词云图片，使用 Puppeteer 和 wordcloud2.js。
   * @param {WordCloudData} data - 包含标题、时间和词汇列表的对象。
   * @returns {Promise<string | Buffer[]>} - 成功时返回图片 Buffer 数组，否则返回提示。
   */
  public async renderWordCloud(data: WordCloudData): Promise<string | Buffer[]> {
    const { title, time, words } = data;
    if (!words?.length) return '暂无数据可供渲染';

    const wordListJson = JSON.stringify(words);

    const cardHtml = `
      <div class="container">
        <div class="header">
          <div class="stat-chip">词数: <span>${words.length}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div id="wordcloud-container" style="width: 800px; height: 600px; margin: auto;"></div>
        <script src="https://cdn.jsdelivr.net/npm/wordcloud@1.2.2/src/wordcloud2.js"></script>
        <script>
          WordCloud(document.getElementById('wordcloud-container'), {
            list: ${wordListJson},
            gridSize: 16,
            weightFactor: (size) => Math.pow(size, 1.2) * 2.5,
            fontFamily: "'Noto Sans SC', sans-serif",
            color: 'random-dark',
            backgroundColor: 'transparent',
            rotateRatio: 0.5,
            minRotation: -Math.PI / 6,
            maxRotation: Math.PI / 6,
            shuffle: false,
          });
        </script>
      </div>`;

    const fullHtml = `<!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>${this.COMMON_STYLE}</style>
        </head>
        <body>
          ${cardHtml}
        </body>
      </html>`;

    const imageBuffer = await this.htmlToImage(fullHtml);
    return imageBuffer ? [imageBuffer] : '图片渲染失败';
  }
}
