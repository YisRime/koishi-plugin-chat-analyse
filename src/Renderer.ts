import { Context, Time } from 'koishi';
import {} from 'koishi-plugin-puppeteer';
import { WordCloudData } from './Analyse';
import { wordCloudScript } from './wordcloud';

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
 * @interface LineChartData
 * @description 定义了调用 `renderLineChart` 方法所需的数据结构，支持多组数据系列。
 */
export interface LineChartData {
  title: string;
  time: Date;
  series: {
    name: string;
    data: number[];
  }[];
  labels: string[];
}

/**
 * @class Renderer
 * @description 负责将结构化的数据渲染为设计精美的 PNG 图片。
 */
export class Renderer {

  private readonly COLOR_PALETTES = [
    // --- 4组近似色 ---
    // 1. Oceanic Blues: 更深邃、专业的蓝色系
    ['#A9D6E5', '#89C2D9', '#61A5C2', '#2A6F97', '#012A4A'],
    // 2. Forest Greens: 丰富、饱和的绿色系
    ['#ADDDBC', '#80C9A7', '#52B69A', '#34A0A4', '#168AAD'],
    // 3. Royal Purples: 优雅、浓郁的紫色系
    ['#C792DF', '#AB69C6', '#9040AD', '#7B2CBF', '#5A189A'],
    // 4. Sunset Glow: 温暖、明亮的日落色系
    ['#FFDD77', '#FFC94A', '#FFB703', '#F8961E', '#E85D04'],

    // --- 4组缤纷色 ---
    // 5. Vivid Candy: 鲜艳的糖果色
    ['#E63946', '#588157', '#A8DADC', '#457B9D', '#1D3557'],
    // 6. Retro Groove: 复古风格
    ['#264653', '#2A9D8F', '#F0C151', '#F4A261', '#E76F51'],
    // 7. Neon Pop: 高对比度的现代色彩组合
    ['#EF476F', '#FFD166', '#06D6A0', '#118AB2', '#073B4C'],
    // 8. Bold Impact: 大胆且冲击力强的撞色
    ['#D90429', '#F95738', '#F2C57C', '#0C7C59', '#003E1F']
  ];

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
      width: 600px;
    }
    .header {
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
    }
    .title-text {
      font-size: 16px; font-weight: 600; color: var(--header-color);
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
      await page.setViewport({ width: 720, height: 1080, deviceScaleFactor: 2.0 });
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
      if (page && !page.isClosed()) await page.close()
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
   * @description 将表格型数据渲染成列表形式的图片。如果数据过多，会通过异步生成器逐个产出图片。
   * @param {ListRenderData} data - 包含标题、时间、总计和列表数据的对象。
   * @param {string[]} [headers] - （可选）列表的表头数组。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，每次迭代产出一张图片的 Buffer。
   */
  public async *renderList(data: ListRenderData, headers?: string[]): AsyncGenerator<Buffer> {
    const { title, time, list } = data;
    const CHUNK_SIZE = 100;
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
      .main-table th { font-size: 12px; font-weight: 500; color: var(--sub-text-color); text-transform: uppercase; white-space: nowrap; }
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
      if (imageBuffer) yield imageBuffer;
    }
  }

  /**
   * @public
   * @method renderLineChart
   * @description 将时间序列数据（如活跃度）渲染成一张基于 SVG 的折线图。支持单组或多组数据进行对比。
   * @param {LineChartData} data - 包含标题、时间、数据系列和标签的对象。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，产出渲染后的图片 Buffer。
   */
  public async *renderLineChart(data: LineChartData): AsyncGenerator<Buffer> {
    const { title, time, series, labels } = data;
    const colorfulPalettes = this.COLOR_PALETTES.slice(4);
    const selectedPalette = colorfulPalettes[Math.floor(Math.random() * colorfulPalettes.length)];
    const shuffledColors = [...selectedPalette].sort(() => 0.5 - Math.random());
    const seriesColors = series.map((_, index) => shuffledColors[index % shuffledColors.length]);

    const width = 600, height = 320;
    const padding = { top: 10, right: 20, bottom: 70, left: 20 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const maxVal = Math.max(1, ...series.flatMap(s => s.data));
    const yTickCount = 5;
    const yTickValue = Math.ceil(maxVal / yTickCount);
    const yAxisMax = yTickValue * yTickCount;

    const getX = (index: number) => {
      if (labels.length <= 1) return padding.left + chartWidth / 2;
      return padding.left + (index / (labels.length - 1)) * chartWidth;
    };
    const getY = (value: number) => padding.top + chartHeight - (value / yAxisMax) * chartHeight;

    let svgElements = '';

    for (let i = 0; i <= yTickCount; i++) {
        const y = getY(i * yTickValue);
        const value = i * yTickValue;
        svgElements += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border-color)" stroke-width="1"/>`;
        svgElements += `<text x="${padding.left - 8}" y="${y + 4}" font-size="10" fill="var(--sub-text-color)" text-anchor="end">${value}</text>`;
    }

    labels.forEach((label, index) => {
        if (index % Math.ceil(labels.length / 12) === 0) {
            const x = getX(index);
            svgElements += `<text x="${x}" y="${height - padding.bottom + 20}" font-size="10" fill="var(--sub-text-color)" text-anchor="middle">${label}</text>`;
        }
    });

    series.forEach((s, seriesIndex) => {
        const color = seriesColors[seriesIndex];
        const points = s.data.map((value, index) => `${getX(index)},${getY(value)}`).join(' ');
        svgElements += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2"/>`;
    });

    if (series.length > 1) {
      const ITEMS_PER_ROW = 3;
      const ROW_HEIGHT = 20;
      const LEGEND_START_Y = height - padding.bottom + 45;
      const columnWidth = chartWidth / ITEMS_PER_ROW;
      series.forEach((s, seriesIndex) => {
        const rowIndex = Math.floor(seriesIndex / ITEMS_PER_ROW);
        const colIndex = seriesIndex % ITEMS_PER_ROW;
        const legendX = padding.left + (colIndex * columnWidth);
        const legendY = LEGEND_START_Y + (rowIndex * ROW_HEIGHT);
        const color = seriesColors[seriesIndex];
        svgElements += `<rect x="${legendX}" y="${legendY - 8}" width="12" height="8" fill="${color}" rx="2"/>`;
        svgElements += `<text x="${legendX + 18}" y="${legendY}" font-size="12" fill="var(--text-color)">${s.name}</text>`;
      });
    }

    const totalMessages = series.reduce((sum, s) => sum + s.data.reduce((a, b) => a + b, 0), 0);
    const cardHtml = `
      <div class="container">
        <div class="header">
          <div class="stat-chip">总计: <span>${totalMessages.toLocaleString()}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div class="chart-wrapper">
          <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
            ${svgElements}
          </svg>
        </div>
      </div>`;

    const chartStyles = ` .chart-wrapper { padding: 10px; } `;
    const fullHtml = this.generateFullHtml(cardHtml, chartStyles);
    const imageBuffer = await this.htmlToImage(fullHtml);
    if (imageBuffer) yield imageBuffer;
  }

  /**
   * @public
   * @method renderWordCloud
   * @description 将词频数据渲染成一张词云图片，使用 Puppeteer 和 wordcloud2.js。
   * @param {WordCloudData} data - 包含标题、时间和词汇列表，以及从config传入的options。
   * @returns {AsyncGenerator<Buffer>} - 一个异步生成器，产出渲染后的图片 Buffer。
   */
  public async *renderWordCloud(data: WordCloudData): AsyncGenerator<Buffer> {
    const { title, time, words } = data;
    const options = (data as any).options;
    if (!words?.length || !options) return;

    const wordsJson = JSON.stringify(words);
    const selectedPalette = this.COLOR_PALETTES[Math.floor(Math.random() * this.COLOR_PALETTES.length)];

    const weights = words.map(w => w[1]);
    const maxWeight = Math.max(...weights, 1);
    const minWeight = Math.min(...weights);

    const cardHtml = `
      <div class="container">
        <div class="header">
          <div class="stat-chip">词数: <span>${words.length}</span></div>
          <h1 class="title-text">${title}</h1>
          <div class="time-label">${time.toLocaleString('zh-CN', { hour12: false })}</div>
        </div>
        <div style="width: 512px; height: 512px; margin: auto; position: relative;">
          <canvas id="wordcloud-canvas" width="512" height="512"></canvas>
        </div>
        <script>${wordCloudScript}</script>
        <script>
          const canvas = document.getElementById('wordcloud-canvas');
          const maskImageUrl = ${JSON.stringify(options.maskImage)};
          const palette = ${JSON.stringify(selectedPalette)};

          const wordCloudOptions = {
            list: ${wordsJson},
            fontFamily: ${JSON.stringify(options.fontFamily)},
            weightFactor: (size) => {
              if (${maxWeight} === ${minWeight}) return (${options.minFontSize} + ${options.maxFontSize}) / 2;
              const normalizedWeight = (size - ${minWeight}) / (${maxWeight} - ${minWeight});
              return ${options.minFontSize} + normalizedWeight * (${options.maxFontSize} - ${options.minFontSize});
            },
            color: () => palette[Math.floor(Math.random() * palette.length)],
            shape: ${JSON.stringify(options.shape)},
            gridSize: ${options.gridSize},
            rotateRatio: ${options.rotateRatio},
            minRotation: ${options.minRotation},
            maxRotation: ${options.maxRotation},
            ellipticity: ${options.ellipticity},
            shuffle: true,
            drawOutOfBoundWords: false,
            backgroundColor: 'transparent',
          };

          function drawWordCloud(isMasked) {
            const finalOptions = { ...wordCloudOptions, clearCanvas: !isMasked };
            WordCloud(canvas, finalOptions);
          }

          if (maskImageUrl) {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              drawWordCloud(true);
            };
            img.onerror = () => {
              drawWordCloud(false);
            };
            img.src = maskImageUrl;
          } else {
            drawWordCloud(false);
          }
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
    if (imageBuffer) yield imageBuffer;
  }
}
