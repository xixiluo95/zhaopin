/**
 * resume-parser.js - 简历文件解析为 Markdown
 *
 * 职责单一：接收文件路径和 MIME 类型，返回 Markdown 文本。
 * 支持 DOCX（mammoth → HTML → turndown → Markdown）
 * 支持 PDF（pdfjs-dist legacy → 纯文本）
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const mammoth = require('mammoth');
const TurndownService = require('turndown');

// 支持的 MIME 类型常量
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_MIME = 'application/pdf';
const MD_MIME = 'text/markdown';
const HTML_MIME = 'text/html';
const TXT_MIME = 'text/plain';

// turndown 实例（复用，统一配置）
const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-'
});

/**
 * 将简历文件解析为 Markdown 文本
 *
 * @param {string} filePath - 文件绝对路径
 * @param {string} mimeType - 文件 MIME 类型
 * @returns {Promise<string>} Markdown 文本
 * @throws {Error} 文件不存在、不支持的格式、解析失败
 */
async function parseResumeToMarkdown(filePath, mimeType) {
  // 校验文件存在
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // 按格式分发解析
  if (mimeType === DOCX_MIME) {
    return parseDocx(filePath);
  }

  if (mimeType === PDF_MIME) {
    return parsePdf(filePath);
  }

  if (mimeType === MD_MIME) {
    return parseMd(filePath);
  }

  if (mimeType === HTML_MIME) {
    return parseHtml(filePath);
  }

  if (mimeType === TXT_MIME) {
    return parseTxt(filePath);
  }

  // 按扩展名兜底
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return parseMd(filePath);
  if (ext === '.html' || ext === '.htm') return parseHtml(filePath);
  if (ext === '.txt') return parseTxt(filePath);

  throw new Error(`Unsupported file format: ${mimeType}`);
}

/**
 * 解析 DOCX 文件为 Markdown
 *
 * mammoth → HTML → turndown → Markdown
 *
 * @param {string} filePath - DOCX 文件路径
 * @returns {Promise<string>} Markdown 文本
 */
async function parseDocx(filePath) {
  // Step 1: DOCX → HTML (mammoth) — 显式处理图片，禁止 base64 内联
  const result = await mammoth.convertToHtml(
    { path: filePath },
    {
      convertImage: mammoth.images.imgElement(() => ({ src: '' }))
    }
  );

  if (result.messages && result.messages.length > 0) {
    console.warn('[resume-parser] mammoth warnings:', result.messages);
  }

  // Step 2: HTML → Markdown (turndown)
  const markdown = turndownService.turndown(result.value);

  // Step 3: 清洗 Markdown — 去除 base64 残留、页脚、模板污染
  return sanitizeResumeMarkdown(markdown);
}

/**
 * 清洗简历 Markdown 内容
 * 去除 base64 图片数据、页脚残留、模板 artefacts
 */
function sanitizeResumeMarkdown(md) {
  return String(md || '')
    .replace(/!\[.*?\]\(data:image\/[^)]+\)/g, '')
    .replace(/<img[^>]*src="data:image\/[^"]+"[^>]*\/?>/gi, '')
    .replace(/^\s*\|\s*PAGE\s*$/gim, '')
    .replace(/\(data:image\/[^)]{20,}\)/g, '')
    .replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]{50,}/g, '')
    .replace(/\n{3,}/g, '\n\n')
    // Strip markdown heading markers (keep the text)
    .replace(/^#{1,6}\s+/gm, '')
    // Strip horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Convert markdown links [text](url) to just text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Strip bold markers **text** → text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // Strip italic markers *text* → text
    .replace(/\*([^*]+)\*/g, '$1')
    // Strip bullet list markers at line start (but preserve the text)
    .replace(/^[\s]*[-*+]\s+/gm, '')
    // Strip numbered list markers at line start
    .replace(/^[\s]*\d+\.\s+/gm, '')
    .trim();
}

/**
 * 解析 PDF 文件为 Markdown（纯文本包裹）
 *
 * 使用 pdfjs-dist legacy 版本，Node 端禁用 Worker。
 *
 * @param {string} filePath - PDF 文件路径
 * @returns {Promise<string>} Markdown 文本
 */
async function parsePdf(filePath) {
  // 动态导入 ESM 模块（pdfjs-dist v5 是纯 ESM）
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  // Node 端设置 Worker 为 legacy 版本的本地文件（pdfjs-dist v5 必须指定有效路径）
  const pdfjsDistRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const workerPath = path.join(pdfjsDistRoot, 'legacy', 'build', 'pdf.worker.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

  const dataBuffer = fs.readFileSync(filePath);
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(dataBuffer),
    standardFontDataUrl: pathToFileURL(
      path.join(pdfjsDistRoot, 'standard_fonts') + '/'
    ).href
  });

  const pdfDocument = await loadingTask.promise;
  const numPages = pdfDocument.numPages;
  const pageTexts = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdfDocument.getPage(i);
    const textContent = await page.getTextContent();
    const items = textContent.items.filter(it => it.str && it.str.trim());
    pageTexts.push(reconstructPdfPageText(items));
  }

  // 将纯文本直接作为 Markdown 返回（PDF 本身无结构化格式）
  const fullText = pageTexts.join('\n\n');
  return fullText.trim();
}

/**
 * 根据 PDF 文本项的 Y 坐标重建行/段落结构
 *
 * pdfjs textContent.items 中每个 item 的 transform[5] 是 Y 坐标，
 * transform[4] 是 X 坐标，height 是字体大小。
 * 利用这些信息检测换行和段落分隔。
 *
 * @param {Array} items - 过滤后的非空文本项
 * @returns {string} - 带换行的文本
 */
function reconstructPdfPageText(items) {
  if (!items || items.length === 0) return '';

  const lines = [];
  let currentLine = [];
  let prevY = null;
  let prevXEnd = null;
  let avgFontSize = 12;

  for (const item of items) {
    const y = item.transform[5];
    const x = item.transform[4];
    const fontSize = item.height || Math.abs(item.transform[0]) || 12;
    avgFontSize = fontSize;

    if (prevY !== null) {
      const yDiff = Math.abs(y - prevY);

      if (yDiff > avgFontSize * 1.5) {
        // 段落跳跃：先保存当前行，再插入空行
        if (currentLine.length > 0) {
          lines.push(currentLine.join(''));
          currentLine = [];
        }
        lines.push('');
      } else if (yDiff > avgFontSize * 0.3) {
        // 行间距：新行
        if (currentLine.length > 0) {
          lines.push(currentLine.join(''));
          currentLine = [];
        }
      }
      // 同行文本：检查是否有显著 X 间距
      else if (prevXEnd !== null) {
        const xGap = x - prevXEnd;
        if (xGap > avgFontSize * 3) {
          currentLine.push(' ');
        }
      }
    }

    currentLine.push(item.str);
    prevY = y;
    prevXEnd = x + (item.width || 0);
  }

  // 刷出最后一行
  if (currentLine.length > 0) {
    lines.push(currentLine.join(''));
  }

  return lines.join('\n');
}

/**
 * 解析 Markdown 文件（直接读取）
 *
 * @param {string} filePath - MD 文件路径
 * @returns {Promise<string>} Markdown 文本
 */
async function parseMd(filePath) {
  return fs.readFileSync(filePath, 'utf-8').trim();
}

/**
 * 解析 HTML 文件为 Markdown
 *
 * @param {string} filePath - HTML 文件路径
 * @returns {Promise<string>} Markdown 文本
 */
async function parseHtml(filePath) {
  const html = fs.readFileSync(filePath, 'utf-8');
  return turndownService.turndown(html);
}

/**
 * 解析 TXT 文件为 Markdown（原样返回）
 *
 * @param {string} filePath - TXT 文件路径
 * @returns {Promise<string>} Markdown 文本
 */
async function parseTxt(filePath) {
  return fs.readFileSync(filePath, 'utf-8').trim();
}

module.exports = { parseResumeToMarkdown };
