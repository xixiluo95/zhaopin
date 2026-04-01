/**
 * ai-handler.js - AI 配置管理 & 简历优化 & 岗位匹配 API Handler
 *
 * 提供 GET/POST /api/ai/config 端点。
 * 提供 POST /api/ai/optimize 端点（M8-N3-WP1）。
 * 提供 POST /api/ai/match 端点（M8-N3-WP2）。
 * 使用 credential-crypto.js 加密/脱敏 API Key。
 * 依赖 db.js 中的 getDatabase() 操作 ai_configs 表。
 */

const { getDatabase, getDeepThinkSettings, updateDeepThinkSettings, getSecondaryModelConfig, upsertSecondaryModelConfig, deleteSecondaryModelConfig } = require('./db');
const fs = require('fs');
const path = require('path');
const { encrypt, decrypt, maskKey } = require('./services/credential-crypto');
const { createActiveLLMClient } = require('./services/llm/llm-factory');
const { createLLMClient } = require('./services/llm/llm-factory');
const { parseResumeToMarkdown } = require('./services/resume-parser');
const resumeDb = require('./resume-db');
const { runDeepThink, resolveDeepThinkMode, validateDeepThinkConfig } = require('./services/ai/deep-think');

const AI_BOOTSTRAP_DIR = process.env.ZHAOPIN_AI_BOOTSTRAP_DIR
  || path.join(__dirname, '../crawler/extension/ai-bootstrap');

const AI_MEMORY_WRITE_DIR = process.env.ZHAOPIN_AI_MEMORY_DIR
  || path.join(__dirname, 'data', 'ai-memory');
const AI_MEMORY_WRITE_FILE = path.join(AI_MEMORY_WRITE_DIR, 'memory.md');

const AI_BOOTSTRAP_FILES = [
  {
    key: 'identity',
    label: '身份定义',
    file: process.env.ZHAOPIN_AI_IDENTITY_FILE || path.join(AI_BOOTSTRAP_DIR, '01-identity.md')
  },
  {
    key: 'rules',
    label: '规范与格式',
    file: process.env.ZHAOPIN_AI_RULES_FILE || path.join(AI_BOOTSTRAP_DIR, '02-rules.md')
  },
  {
    key: 'memory',
    label: '长期记忆',
    file: process.env.ZHAOPIN_AI_MEMORY_FILE || path.join(AI_BOOTSTRAP_DIR, '03-memory.md')
  }
];

const AI_TEMPLATE_REFERENCE_FILES = [
  process.env.ZHAOPIN_AI_TEMPLATE_DOCX || '/home/xixil/下载/简历模板.docx',
  process.env.ZHAOPIN_AI_TEMPLATE_PDF_1 || '/home/xixil/下载/简历张三模板.pdf',
  process.env.ZHAOPIN_AI_TEMPLATE_PDF_2 || '/home/xixil/下载/简历张三模板 (1).pdf'
];

const REFERENCE_TEXT_LIMIT = 3500;
const PROJECT_SKILL_FILE = path.join(__dirname, '../SKILL.md');
const ASSISTANT_MAX_TOOL_STEPS = 6;
const ASSISTANT_SQL_ROW_LIMIT = 50;

function ensureFileDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readAIBootstrapContext() {
  const sections = [];

  for (const item of AI_BOOTSTRAP_FILES) {
    try {
      if (!fs.existsSync(item.file)) {
        continue;
      }

      const content = fs.readFileSync(item.file, 'utf8').trim();
      if (!content) {
        continue;
      }

      sections.push({ key: item.key, text: `## ${item.label}\n文件: ${item.file}\n\n${content}` });
    } catch (err) {
      console.warn(`[AIBootstrap] 读取失败: ${item.file}`, err.message);
    }
  }

  // Prefer updated memory from data dir over extension's 03-memory.md
  try {
    if (fs.existsSync(AI_MEMORY_WRITE_FILE)) {
      const updatedMemory = fs.readFileSync(AI_MEMORY_WRITE_FILE, 'utf8').trim();
      if (updatedMemory) {
        const idx = sections.findIndex((s) => s.key === 'memory');
        const replacement = `## 长期记忆\n文件: ${AI_MEMORY_WRITE_FILE}\n\n${updatedMemory}`;
        if (idx >= 0) {
          sections[idx] = { key: 'memory', text: replacement };
        } else {
          sections.push({ key: 'memory', text: replacement });
        }
      }
    }
  } catch (e) {
    // Ignore - use bootstrap memory as fallback
  }

  return sections.map((s) => s.text).join('\n\n');
}

function detectResumeMimeType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (ext === '.pdf') {
    return 'application/pdf';
  }
  return '';
}

function trimReferenceText(text, limit = REFERENCE_TEXT_LIMIT) {
  const normalized = String(text || '').replace(/\r/g, '\n').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n\n[已截断，保留前 ${limit} 个字符]`;
}

function extractResumeStructureHints(markdown) {
  const lines = String(markdown || '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return '当前简历为空。';
  }

  const sectionTitles = [];
  const bulletCounts = [];
  let currentBulletCount = 0;

  for (const line of lines) {
    if (!line.startsWith('- ') && !line.includes('：') && line.length <= 20) {
      if (sectionTitles.length > 0 || bulletCounts.length > 0) {
        bulletCounts.push(currentBulletCount);
        currentBulletCount = 0;
      }
      sectionTitles.push(line);
      continue;
    }

    if (line.startsWith('- ')) {
      currentBulletCount += 1;
    }
  }

  if (sectionTitles.length > 0) {
    bulletCounts.push(currentBulletCount);
  }

  const topLines = lines.slice(0, Math.min(8, lines.length)).join(' | ');
  const sectionsSummary = sectionTitles
    .map((title, index) => `${index + 1}. ${title}${typeof bulletCounts[index] === 'number' ? `（${bulletCounts[index]}条）` : ''}`)
    .join('；');

  return [
    `当前简历前几行：${topLines}`,
    sectionsSummary ? `当前简历区块顺序：${sectionsSummary}` : '当前简历没有识别出稳定区块标题。',
    '改写时必须尽量保持这些区块顺序和字段布局稳定，不要把简历改写成普通散文。'
  ].join('\n');
}

async function readTemplateReferenceContext(referenceFiles) {
  const uniqueFiles = [...new Set((referenceFiles || []).filter(Boolean))];
  const sections = [];

  for (const filePath of uniqueFiles) {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        continue;
      }

      const mimeType = detectResumeMimeType(filePath);
      if (!mimeType) {
        continue;
      }

      const parsed = await parseResumeToMarkdown(filePath, mimeType);
      const trimmed = trimReferenceText(parsed);
      if (!trimmed) {
        continue;
      }

      sections.push(`## 版式参考\n文件: ${filePath}\n\n${trimmed}`);
    } catch (err) {
      console.warn(`[AITemplate] 读取失败: ${filePath}`, err.message);
    }
  }

  return sections.join('\n\n');
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    candidates.unshift(fenceMatch[1].trim());
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }

  return null;
}

function stripMarkdownCodeFence(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/^```(?:markdown|md|json|text)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : raw;
}

function normalizeOptimizedMarkdown(content, fallbackContent) {
  const cleaned = stripMarkdownCodeFence(content);
  if (cleaned) {
    return cleaned;
  }
  return String(fallbackContent || '').trim();
}

function buildMemoryUpdateResult(parsed) {
  const update = parsed?.memory_update;
  if (!update || update.should_update !== true) {
    return { updated: false };
  }

  const contentMd = String(update.content_md || '').trim();
  if (!contentMd) {
    return { updated: false };
  }

  const memoryFile = AI_MEMORY_WRITE_FILE;

  try {
    ensureFileDir(memoryFile);
    fs.writeFileSync(memoryFile, `${contentMd}\n`, 'utf8');
    return {
      updated: true,
      reason: String(update.reason || '').trim()
    };
  } catch (err) {
    console.error('[AIMemory] 写入失败:', err.message);
    return { updated: false, error: err.message };
  }
}

function toSafeText(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function truncateText(text, limit = 4000) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n\n[已截断，保留前 ${limit} 个字符]`;
}

function extractJobDescription(job) {
  if (!job) return '';
  try {
    const payload = typeof job.raw_payload === 'string'
      ? JSON.parse(job.raw_payload)
      : (job.raw_payload || {});
    return payload.jobDesc || payload.description || payload['岗位描述'] || '';
  } catch {
    return '';
  }
}

function getJobRecord(db, jobId) {
  if (!jobId) return null;
  return db.prepare(
    'SELECT id, title, company, location, salary, keywords, raw_payload, url, platform FROM scraped_jobs WHERE id = ?'
  ).get(jobId);
}

function serializeJobRecord(job) {
  if (!job) return null;
  return {
    id: job.id,
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    salary: job.salary || '',
    keywords: job.keywords || '',
    platform: job.platform || '',
    url: job.url || '',
    description: extractJobDescription(job),
  };
}

function normalizeAssistantHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((item) => ({
      role: item?.role === 'assistant' ? 'assistant' : 'user',
      content: toSafeText(item?.text || item?.content || '').trim(),
    }))
    .filter((item) => item.content);
}

function getAssistantToolCatalog() {
  return [
    { name: 'get_tool_guide', summary: '读取某个工具的详细使用说明，做渐进式披露。' },
    { name: 'get_system_map', summary: '读取系统入口地图，了解简历、岗位、数据库、爬虫、技能文档和联网工具从哪里进入。' },
    { name: 'read_resume', summary: '读取当前最新简历的 Markdown、文件名、文件路径。' },
    { name: 'read_current_job', summary: '读取当前岗位详情，包括职位描述、关键词、链接。' },
    { name: 'list_selected_jobs', summary: '列出当前已收藏/选中的岗位摘要。' },
    { name: 'search_jobs_db', summary: '在本地职位库中按关键词搜索岗位。' },
    { name: 'query_database', summary: '对本地 SQLite 数据库执行只读 SELECT 查询。' },
    { name: 'update_resume', summary: '在用户明确要求时，直接更新当前简历内容。' },
    { name: 'read_project_skill', summary: '读取项目的 SKILL.md，理解爬虫/插件入口与工作方式。' },
    { name: 'fetch_url', summary: '抓取指定 URL 的网页正文文本。' },
    { name: 'web_search', summary: '联网搜索公开网页信息，返回结果摘要。' },
  ];
}

function getAssistantToolGuide(toolName) {
  const guides = {
    get_tool_guide: {
      purpose: '读取某个工具的详细说明，适合首次决定是否使用工具时。',
      args: { tool_name: '工具名' },
      notes: ['先读摘要，再按需展开，不要一上来把所有工具都调用一遍。']
    },
    get_system_map: {
      purpose: '读取整个招聘工作台的关键入口地图。',
      args: {},
      notes: ['优先用它理解系统里有哪些可用入口，再决定是否读取 SKILL.md 或调用具体工具。']
    },
    read_resume: {
      purpose: '读取当前最新简历，获取当前版本正文。',
      args: {},
      notes: ['修改前通常应先读一次。']
    },
    read_current_job: {
      purpose: '读取当前对话绑定的岗位详情。',
      args: { job_id: '可选，不传则用当前 job_id' },
      notes: ['分析岗位匹配度、定向优化简历前优先使用。']
    },
    list_selected_jobs: {
      purpose: '列出当前已收藏/选中的岗位。',
      args: { limit: '可选，默认 10' },
      notes: ['适合用户问“我收藏了哪些岗位”之类的问题。']
    },
    search_jobs_db: {
      purpose: '在 scraped_jobs 本地职位库中搜索。',
      args: { keyword: '关键词', limit: '可选，默认 10' },
      notes: ['适合按公司、职位名、关键词搜岗位。']
    },
    query_database: {
      purpose: '执行只读 SQL 查询。',
      args: { sql: '只允许 SELECT / WITH / PRAGMA' },
      notes: ['禁止 UPDATE/DELETE/INSERT/ATTACH/ALTER/DROP。结果会自动限流。']
    },
    update_resume: {
      purpose: '直接更新当前简历 Markdown。',
      args: { content_md: '完整 Markdown', reason: '更新原因' },
      notes: ['仅当用户明确提出修改/优化简历时使用。']
    },
    read_project_skill: {
      purpose: '读取项目根目录 SKILL.md 或子目录中的技能文档。',
      args: { skill_path: '可选，相对于 ai-bootstrap 目录的路径，如 skills/resume-script-editor/SKILL.md' },
      notes: ['适合用户问爬虫能力、系统结构、插件工作流、简历编辑工具用法。']
    },
    fetch_url: {
      purpose: '抓取指定 URL 的网页文本。',
      args: { url: 'http/https URL' },
      notes: ['仅抓取用户请求相关页面；正文会截断。']
    },
    web_search: {
      purpose: '搜索公开网页内容。',
      args: { query: '搜索词', limit: '可选，默认 5' },
      notes: ['返回的是搜索结果摘要，不是完整网页。']
    },
  };

  return guides[toolName] || null;
}

function getAssistantSystemMap() {
  return {
    overview: '招聘工作台插件态 AI 助手可通过下列入口按需完成对话、分析、查询与简历改写。',
    entries: [
      {
        id: 'bootstrap_docs',
        label: '启动上下文',
        path: AI_BOOTSTRAP_DIR,
        usage: '系统已在本轮请求开头自动注入 01-identity.md、02-rules.md、03-memory.md，无需再次读取。',
      },
      {
        id: 'resume',
        label: '简历入口',
        path: '/api/resume + resume-db',
        usage: '用 read_resume 读取当前简历；在用户明确要求修改简历时，用 update_resume 写回最新 Markdown。',
      },
      {
        id: 'job',
        label: '岗位入口',
        path: '/api/jobs/detail + scraped_jobs',
        usage: '用 read_current_job 读取当前岗位；用 list_selected_jobs / search_jobs_db / query_database 查看本地岗位库。',
      },
      {
        id: 'database',
        label: '数据库入口',
        path: '/home/xixil/kimi-code/zhaopin/controller/data/zhaopin.db',
        usage: '只允许用 query_database 执行只读 SELECT/WITH/PRAGMA 查询，不能修改数据。',
      },
      {
        id: 'crawler',
        label: '爬虫与扩展入口',
        path: '/home/xixil/kimi-code/zhaopin/crawler/extension/',
        usage: '如需理解采集、插件、内容脚本、调度方式，先用 read_project_skill 读取项目技能文档，再决定下一步。',
      },
      {
        id: 'skill_doc',
        label: '技能文档入口',
        path: PROJECT_SKILL_FILE,
        usage: '用 read_project_skill 读取项目级 SKILL.md，理解系统结构、Chrome 插件、Boss 采集与飞书同步能力。',
      },
      {
        id: 'internet',
        label: '互联网入口',
        path: 'fetch_url / web_search',
        usage: '需要查公开网页或联网搜索时使用；先搜索，再按需抓取具体 URL。',
      },
      {
        id: 'resume_editor_skill',
        label: '简历编辑工具技能',
        path: 'ai-bootstrap/skills/resume-script-editor/SKILL.md',
        usage: '用 read_project_skill 读取简历脚本编辑工具的详细说明，了解如何精确操作简历内容和样式。',
      },
    ],
    principles: [
      '优先对话，按需用工具。',
      '用户未明确要求时，不要修改简历。',
      '先读摘要，再渐进式展开具体工具。',
    ],
  };
}

function buildAssistantSystemPrompt({ bootstrapContext, currentJobId }) {
  const toolCatalog = getAssistantToolCatalog()
    .map((tool) => `- ${tool.name}: ${tool.summary}`)
    .join('\n');

  return [
    '你是招聘工作台里的插件态 AI 助手。',
    '你采用简化版 openclaw 的工作方式：先读取开头的三份 .md 文档作为固定上下文，再围绕当前对话与工具进行工作。',
    '这三份 .md 文档在本轮请求中只会出现在上下文开头一次，你必须先基于它们理解身份、规范和长期记忆。',
    '之后你要优先和用户对话，只有在需要读取简历、岗位、数据库、技能文档、互联网网页或需要修改简历时，才调用工具。',
    '不要把所有工具都先跑一遍。优先基于已有上下文和用户消息判断，再按需调用工具。',
    '工具使用采用渐进式披露：先看下面的摘要；若要细化某个工具用法，先调用 get_tool_guide。',
    '如果用户明确要求优化、改写、修改简历，你可以调用 update_resume 直接更新简历。',
    '如果用户只是咨询，不要修改简历。',
    currentJobId ? `当前对话绑定岗位 ID: ${currentJobId}` : '当前没有绑定岗位 ID。',
    '你必须始终只输出 JSON，不允许输出 JSON 之外的自然语言。',
    '当需要工具时，输出：{"action":"tool_call","tool":"工具名","arguments":{...},"reason":"为什么需要这个工具"}',
    '当准备回复用户时，输出：{"action":"respond","reply":"给用户看的回复","suggestions":["可选建议"],"resume_updated":true/false,"resume_updated_content_md":"若本轮改了简历则返回最新完整 Markdown，否则空字符串","memory_update":{"should_update":true/false,"reason":"为什么更新长期记忆","content_md":"完整长期记忆 Markdown 或空字符串"}}',
    '如果你已经通过 update_resume 修改了简历，最终 respond 时必须把 resume_updated 设为 true。',
    `## 硬性约束
1. 【最小修改原则】只修改用户明确要求的部分，不主动修改其他内容
2. 【格式保持】保持原有Markdown格式和结构不变
3. 【头部保护】永远不修改简历的header/联系方式部分，除非用户明确要求
4. 【两阶段执行】
   - 分析阶段：理解用户意图，确认修改范围
   - 执行阶段：只在确认范围内进行修改
5. 【输出格式】
   - 回复用自然语言，简洁友好
   - 如需展示修改内容，用代码块包裹
   - 不要在回复中暴露内部处理逻辑或JSON格式`,
    '工具摘要：',
    toolCatalog,
    bootstrapContext,
  ].filter(Boolean).join('\n\n');
}

// Sanitize reply - never expose raw JSON protocol to user
function sanitizeReply(reply) {
  if (!reply || typeof reply !== 'string') return reply || '（无回复）';

  const trimmed = reply.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"action"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.reply) return parsed.reply;
      if (parsed.action === 'respond' && parsed.content) return parsed.content;
      return '（AI处理中出现异常，请重试）';
    } catch (e) {
      // Not valid JSON, might be partial - strip protocol-looking parts
    }
  }

  // Strip any accidental JSON wrapper
  const jsonMatch = trimmed.match(/\{[\s\S]*"reply"\s*:\s*"([\s\S]*?)"[\s\S]*\}/);
  if (jsonMatch && jsonMatch[1]) {
    return jsonMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
  }

  return reply;
}

function sanitizeSqlQuery(sql) {
  const normalized = String(sql || '').trim().replace(/;+\s*$/g, '');
  if (!normalized) {
    throw new Error('SQL 不能为空');
  }

  const upper = normalized.toUpperCase();
  const readOnly = upper.startsWith('SELECT ') || upper.startsWith('WITH ') || upper.startsWith('PRAGMA ');
  if (!readOnly) {
    throw new Error('只允许执行 SELECT / WITH / PRAGMA 查询');
  }

  if (/\b(UPDATE|DELETE|INSERT|REPLACE|ALTER|DROP|ATTACH|DETACH|CREATE|VACUUM|TRUNCATE)\b/i.test(upper)) {
    throw new Error('检测到非只读 SQL 关键字');
  }

  if ((upper.startsWith('SELECT ') || upper.startsWith('WITH ')) && !/\bLIMIT\s+\d+\b/i.test(upper)) {
    return `${normalized} LIMIT ${ASSISTANT_SQL_ROW_LIMIT}`;
  }

  return normalized;
}

function stripHtml(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrlText(url) {
  const normalized = String(url || '').trim();
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('URL 必须以 http:// 或 https:// 开头');
  }

  const response = await fetch(normalized, {
    headers: {
      'User-Agent': 'Mozilla/5.0 zhaopin-ai-assistant/1.0'
    }
  });
  const contentType = response.headers.get('content-type') || '';
  const raw = await response.text();
  const text = contentType.includes('html') ? stripHtml(raw) : raw;

  return {
    url: normalized,
    status: response.status,
    content_type: contentType,
    text: truncateText(text, 5000),
  };
}

async function searchWeb(query, limit = 5) {
  const normalized = String(query || '').trim();
  if (!normalized) {
    throw new Error('搜索词不能为空');
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 zhaopin-ai-assistant/1.0'
    }
  });
  const html = await response.text();
  const results = [];
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = regex.exec(html)) && results.length < limit) {
    const href = match[1];
    const title = stripHtml(match[2]);
    if (!title) continue;
    results.push({
      title,
      url: href,
    });
  }

  return {
    query: normalized,
    results,
  };
}

async function executeAssistantTool({ db, toolName, args, currentJobId, resume }) {
  switch (toolName) {
    case 'get_tool_guide': {
      const guide = getAssistantToolGuide(args?.tool_name);
      if (!guide) {
        throw new Error(`未知工具说明: ${args?.tool_name || ''}`);
      }
      return guide;
    }
    case 'get_system_map': {
      return getAssistantSystemMap();
    }
    case 'read_resume': {
      const latest = resume || resumeDb.getLatestResume();
      if (!latest) {
        return { exists: false };
      }
      return {
        exists: true,
        file_name: latest.file_name || '',
        file_path: latest.file_path || '',
        content_md: latest.content_md || '',
      };
    }
    case 'read_current_job': {
      const job = getJobRecord(db, Number(args?.job_id) || currentJobId);
      return {
        job: serializeJobRecord(job),
      };
    }
    case 'list_selected_jobs': {
      const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 20));
      const rows = db.prepare(
        'SELECT id, title, company, location, salary, keywords FROM scraped_jobs WHERE selected = 1 ORDER BY id DESC LIMIT ?'
      ).all(limit);
      return { jobs: rows };
    }
    case 'search_jobs_db': {
      const keyword = String(args?.keyword || '').trim();
      const limit = Math.max(1, Math.min(Number(args?.limit) || 10, 20));
      const rows = db.prepare(`
        SELECT id, title, company, location, salary, keywords
        FROM scraped_jobs
        WHERE title LIKE ? OR company LIKE ? OR keywords LIKE ?
        ORDER BY id DESC
        LIMIT ?
      `).all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, limit);
      return { keyword, jobs: rows };
    }
    case 'query_database': {
      const sql = sanitizeSqlQuery(args?.sql);
      const rows = db.prepare(sql).all();
      return { sql, rows };
    }
    case 'update_resume': {
      const contentMd = String(args?.content_md || '').trim();
      const reason = String(args?.reason || '').trim();
      if (!contentMd) {
        throw new Error('content_md 不能为空');
      }
      const result = resumeDb.updateResume({ content_md: contentMd });
      if (!result.success) {
        throw new Error(result.error || '更新简历失败');
      }
      return {
        success: true,
        reason,
        resume_updated: true,
        content_md: contentMd,
      };
    }
    case 'read_project_skill': {
      // 支持读取子目录中的 skill 文件
      let skillPath = PROJECT_SKILL_FILE;
      if (args?.skill_path) {
        const resolved = path.resolve(AI_BOOTSTRAP_DIR, args.skill_path);
        // 安全检查：只允许读取 ai-bootstrap 目录下的文件
        if (resolved.startsWith(path.resolve(AI_BOOTSTRAP_DIR)) && fs.existsSync(resolved)) {
          skillPath = resolved;
        } else if (fs.existsSync(PROJECT_SKILL_FILE)) {
          skillPath = PROJECT_SKILL_FILE;
        } else {
          throw new Error('技能文档不存在');
        }
      }
      if (!fs.existsSync(skillPath)) {
        throw new Error('项目 SKILL.md 不存在');
      }
      return {
        path: skillPath,
        content: truncateText(fs.readFileSync(skillPath, 'utf8'), 8000),
      };
    }
    case 'fetch_url': {
      return await fetchUrlText(args?.url);
    }
    case 'web_search': {
      return await searchWeb(args?.query, Math.max(1, Math.min(Number(args?.limit) || 5, 10)));
    }
    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

async function runAssistantLoop({ llmClient, systemPrompt, conversationHistory, userMessage, db, currentJobId, resume }) {
  const messages = [{ role: 'system', content: systemPrompt }];
  messages.push(...conversationHistory);
  messages.push({ role: 'user', content: userMessage });

  let resumeUpdated = false;
  let latestResumeContent = resume?.content_md || '';
  const toolTrace = [];

  for (let step = 0; step < ASSISTANT_MAX_TOOL_STEPS; step += 1) {
    const result = await llmClient.chat(messages);
    if (result.error || !result.content) {
      const errMsg = result.error?.message || 'AI 调用返回为空';
      throw new Error(errMsg);
    }

    const parsed = extractJsonObject(result.content);
    if (!parsed) {
      return {
        reply: String(result.content || '').trim(),
        suggestions: [],
        resume_updated: resumeUpdated,
        resume_updated_content_md: resumeUpdated ? latestResumeContent : '',
        memory_update: { should_update: false, reason: '', content_md: '' },
        tool_trace: toolTrace,
      };
    }

    if (parsed.action === 'tool_call' && parsed.tool) {
      const toolResult = await executeAssistantTool({
        db,
        toolName: parsed.tool,
        args: parsed.arguments || {},
        currentJobId,
        resume,
      });

      if (toolResult?.resume_updated && toolResult?.content_md) {
        resumeUpdated = true;
        latestResumeContent = toolResult.content_md;
      }

      toolTrace.push({
        tool: parsed.tool,
        reason: String(parsed.reason || '').trim(),
      });

      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({
        role: 'user',
        content: `工具 ${parsed.tool} 的执行结果如下，请继续：\n${JSON.stringify(toolResult)}`
      });
      continue;
    }

    if (parsed.action === 'respond') {
      return {
        reply: String(parsed.reply || '').trim(),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 6) : [],
        resume_updated: parsed.resume_updated === true || resumeUpdated,
        resume_updated_content_md: String(parsed.resume_updated_content_md || (resumeUpdated ? latestResumeContent : '')).trim(),
        memory_update: parsed.memory_update || { should_update: false, reason: '', content_md: '' },
        tool_trace: toolTrace,
      };
    }
  }

  return {
    reply: '本轮工具调用达到上限，请把请求再收窄一点。',
    suggestions: [],
    resume_updated: resumeUpdated,
    resume_updated_content_md: resumeUpdated ? latestResumeContent : '',
    memory_update: { should_update: false, reason: '', content_md: '' },
    tool_trace: toolTrace,
  };
}

/**
 * GET /api/ai/config - 获取所有 AI 配置（api_key 脱敏）
 *
 * Response: {
 *   "configs": [
 *     {
 *       "id": 1,
 *       "provider": "zhipu",
 *       "api_key_masked": "abc123...xyz",
 *       "base_url": "https://...",
 *       "model_name": "glm-5-turbo",
 *       "is_active": 1
 *     }
 *   ]
 * }
 */
function handleGetConfig(req, res) {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      id,
      provider,
      api_key_encrypted,
      base_url,
      model_name,
      is_active,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM ai_configs
    ORDER BY id ASC
  `).all();

  const configs = rows.map((row) => {
    // 解密后脱敏，避免返回密文
    let apiKeyMasked = '***';
    try {
      if (row.api_key_encrypted) {
        const decrypted = decrypt(row.api_key_encrypted);
        apiKeyMasked = maskKey(decrypted);
      }
    } catch {
      // 解密失败（如空字符串），保持默认脱敏
    }

    return {
      id: row.id,
      provider: row.provider,
      api_key_masked: apiKeyMasked,
      base_url: row.base_url,
      model_name: row.model_name,
      is_active: row.is_active
    };
  });

  // 附加深度思考设置和第二模型配置
  const deepThinkSettings = getDeepThinkSettings();
  const secondaryModel = getSecondaryModelConfig();

  let secondaryModelInfo = null;
  if (secondaryModel) {
    let apiKeyMasked = '***';
    try {
      if (secondaryModel.api_key_encrypted) {
        const decrypted = decrypt(secondaryModel.api_key_encrypted);
        apiKeyMasked = maskKey(decrypted);
      }
    } catch { /* ignore */ }
    secondaryModelInfo = {
      id: secondaryModel.id,
      provider: secondaryModel.provider,
      api_key_masked: apiKeyMasked,
      base_url: secondaryModel.base_url,
      model_name: secondaryModel.model_name
    };
  }

  res.end(JSON.stringify({
    configs,
    deep_think_settings: deepThinkSettings ? {
      enabled: !!deepThinkSettings.enabled,
      mode: deepThinkSettings.mode,
      max_rounds: deepThinkSettings.max_rounds,
      compression_enabled: !!deepThinkSettings.compression_enabled,
      debug: !!deepThinkSettings.debug,
      no_new_info_rounds: deepThinkSettings.no_new_info_rounds,
      fallback_to_single: !!deepThinkSettings.fallback_to_single
    } : null,
    secondary_model: secondaryModelInfo
  }));
}

/**
 * POST /api/ai/config - 保存 AI 配置（api_key 加密存储）
 *
 * Body: {
 *   "provider": "zhipu",
 *   "api_key": "sk-xxx",
 *   "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
 *   "model_name": "glm-5-turbo"
 * }
 *
 * Response: { "success": true, "id": 1 }
 */
function handleSaveConfig(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (!body.provider) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing provider field' }));
        return;
      }

      if (!body.api_key) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing api_key field' }));
        return;
      }

      if (typeof body.api_key === 'string' && body.api_key.includes('...')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'API Key 看起来是脱敏显示值，请输入完整 Key' }));
        return;
      }

      const db = getDatabase();
      const encryptedKey = encrypt(body.api_key);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // 检查 provider 是否已存在
      const existing = db.prepare(
        'SELECT id FROM ai_configs WHERE provider = ?'
      ).get(body.provider);

      let resultId;

      const saveConfigTxn = db.transaction(() => {
        db.prepare('UPDATE ai_configs SET is_active = 0').run();

        if (existing) {
          db.prepare(`
            UPDATE ai_configs
            SET api_key_encrypted = ?, base_url = ?, model_name = ?,
                is_active = 1, updated_at = ?
            WHERE id = ?
          `).run(encryptedKey, body.base_url || '', body.model_name || '', now, existing.id);
          return existing.id;
        }

        const result = db.prepare(`
          INSERT INTO ai_configs (provider, api_key_encrypted, base_url, model_name, is_active, updated_at)
          VALUES (?, ?, ?, ?, 1, ?)
        `).run(body.provider, encryptedKey, body.base_url || '', body.model_name || '', now);
        return result.lastInsertRowid;
      });

      resultId = saveConfigTxn();
      console.log(`[AIConfig] Activated provider "${body.provider}" (id: ${resultId})`);

      res.end(JSON.stringify({ success: true, id: resultId }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request: ' + err.message }));
    }
  });
}

/**
 * POST /api/ai/optimize - 调用 LLM 优化简历（M8-N3-WP1）
 *
 * Body: {
 *   "job_id": 123,              // 可选，指定目标岗位 ID
 *   "instructions": "突出数据分析经验"  // 可选，用户自定义优化方向
 * }
 *
 * Response: {
 *   "success": true,
 *   "optimized_content_md": "# 优化后的简历...",
 *   "changes_summary": "主要优化了以下方面：..."
 * }
 */
async function handleOptimizeResume(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const db = getDatabase();

      // 1. 检查 AI 配置是否就绪
      const llmClient = createActiveLLMClient(db);
      if (!llmClient) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请先配置 AI 提供商' }));
        return;
      }

      // 2. 获取当前简历内容
      const resume = resumeDb.getLatestResume();
      if (!resume || !resume.content_md) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请先上传简历' }));
        return;
      }

      // 3. 如果指定了 job_id，获取对应岗位信息
      let jobInfo = '';
      if (body.job_id) {
        const job = db.prepare(
          'SELECT title, company, raw_payload FROM scraped_jobs WHERE id = ?'
        ).get(body.job_id);
        if (job) {
          let jobDesc = '';
          try {
            const payload = typeof job.raw_payload === 'string'
              ? JSON.parse(job.raw_payload)
              : (job.raw_payload || {});
            jobDesc = payload.jobDesc || payload.description || payload['岗位描述'] || '';
          } catch {
            // raw_payload 解析失败，忽略描述
          }
          jobInfo = `目标岗位：${job.title || '未知'} at ${job.company || '未知'}\n岗位要求：${jobDesc || '暂无描述'}`;
        }
      }

      // 4. 构建 Prompt
      const instructions = body.instructions ? `优化方向：${body.instructions}` : '';
      const bootstrapContext = readAIBootstrapContext();
      const structureHints = extractResumeStructureHints(resume.content_md);
      const templateReferenceContext = await readTemplateReferenceContext([
        resume.file_path,
        ...AI_TEMPLATE_REFERENCE_FILES
      ]);
      const systemPrompt = [
        '你是这个招聘工作台内置的 AI 助手与简历优化顾问。',
        '请优先遵守下面预读文件里的身份定义、规范格式和长期记忆。',
        '如果预读文件与用户临时指令冲突，优先执行用户当前明确提出的任务，但不要违反规范文件中的硬约束。',
        '你的核心任务不是自由发挥重写，而是基于当前简历模板做定向优化，让输出仍然适合被当成正式简历渲染。',
        '必须尽量保留当前简历的区块顺序、字段布局、信息密度、标题风格和列表结构。',
        '不要输出散文式说明、不要改成求职信、不要加入多余标题、不要输出代码块包裹的 Markdown。',
        '你必须只返回一个 JSON 对象，不要返回 JSON 之外的任何文字。',
        'JSON Schema:',
        '{',
        '  "explanation": "给用户看的简短分析，中文，字符串",',
        '  "suggestions": ["最多5条建议"],',
        '  "optimized_content_md": "可直接写回编辑器的 Markdown 简历内容",',
        '  "changes_summary": "这次改了什么，字符串",',
        '  "memory_update": {',
        '    "should_update": true/false,',
        '    "reason": "为什么需要更新长期记忆",',
        '    "content_md": "当 should_update=true 时，返回完整的长期记忆 Markdown 文件内容；否则返回空字符串"',
        '  }',
        '}',
        '只有在发现稳定的用户长期偏好、长期约束、长期模板偏好时，才更新 memory_update。',
        '如果只是一次性的岗位指令，不要更新长期记忆。',
        bootstrapContext,
        '## 当前简历结构约束',
        structureHints,
        templateReferenceContext
      ].filter(Boolean).join('\n\n');
      const userPrompt = [
        jobInfo,
        instructions,
        '',
        '简历内容：',
        resume.content_md
      ].filter(Boolean).join('\n');

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      // 5. 调用 LLM
      const result = await llmClient.chat(messages);

      if (result.error || !result.content) {
        const errMsg = result.error?.message || 'AI 调用返回为空';
        console.error('[AIOptimize] LLM 调用失败:', errMsg);
        res.writeHead(500);
        res.end(JSON.stringify({ error: '简历优化失败：' + errMsg }));
        return;
      }

      const parsed = extractJsonObject(result.content);
      if (!parsed) {
        console.error('[AIOptimize] 无法解析模型返回的 JSON');
        res.writeHead(500);
        res.end(JSON.stringify({ error: '简历优化失败：AI 返回格式不正确' }));
        return;
      }

      const optimizedContent = normalizeOptimizedMarkdown(
        parsed.optimized_content_md,
        resume.content_md
      );
      const memoryResult = buildMemoryUpdateResult(parsed);

      console.log('[AIOptimize] 简历优化完成，内容长度:', optimizedContent.length);

      res.end(JSON.stringify({
        success: true,
        explanation: String(parsed.explanation || '').trim(),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 5) : [],
        optimized_content_md: optimizedContent,
        changes_summary: String(parsed.changes_summary || '简历已根据要求优化完成').trim(),
        memory_updated: memoryResult.updated,
        memory_update_reason: memoryResult.reason || ''
      }));
    } catch (err) {
      console.error('[AIOptimize] 处理失败:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: '简历优化失败：' + err.message }));
    }
  });
}

/**
 * POST /api/ai/assistant - AI 助手对话接口
 *
 * Body: {
 *   "job_id": 123,
 *   "message": "你好",
 *   "conversation_history": [
 *     { "role": "user", "text": "..." },
 *     { "role": "assistant", "text": "..." }
 *   ]
 * }
 */
async function handleAssistantChat(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const db = getDatabase();
      const llmClient = createActiveLLMClient(db);
      if (!llmClient) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请先配置 AI 提供商' }));
        return;
      }

      const message = String(body.message || '').trim();
      if (!message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 message' }));
        return;
      }

      const currentJobId = Number(body.job_id) || null;
      const resume = resumeDb.getLatestResume();
      const bootstrapContext = readAIBootstrapContext();
      const systemPrompt = buildAssistantSystemPrompt({
        bootstrapContext,
        currentJobId,
      });
      const conversationHistory = normalizeAssistantHistory(body.conversation_history);
      const assistantResult = await runAssistantLoop({
        llmClient,
        systemPrompt,
        conversationHistory,
        userMessage: message,
        db,
        currentJobId,
        resume,
      });

      const memoryResult = buildMemoryUpdateResult({
        memory_update: assistantResult.memory_update,
      });

      res.end(JSON.stringify({
        success: true,
        reply: sanitizeReply(assistantResult.reply),
        suggestions: assistantResult.suggestions,
        resume_updated: assistantResult.resume_updated,
        resume_updated_content_md: assistantResult.resume_updated_content_md,
        memory_updated: memoryResult.updated,
        memory_update_reason: memoryResult.reason || '',
        tool_trace: assistantResult.tool_trace,
      }));
    } catch (err) {
      console.error('[AIAssistant] 处理失败:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'AI 助手失败：' + err.message }));
    }
  });
}

/**
 * POST /api/ai/match - AI 岗位匹配打分（M8-N3-WP2）
 *
 * Body: {
 *   "job_ids": [1, 2, 3]  // 可选，不传则匹配所有待投递岗位
 * }
 *
 * Response: {
 *   "success": true,
 *   "matches": [
 *     { "job_id": 1, "title": "...", "company": "...", "score": 85, "reason": "..." }
 *   ]
 * }
 */
async function handleJobMatch(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const db = getDatabase();

      // 1. 检查 AI 配置是否就绪
      const llmClient = createActiveLLMClient(db);
      if (!llmClient) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请先配置 AI 提供商' }));
        return;
      }

      // 2. 获取当前简历内容
      const resume = resumeDb.getLatestResume();
      if (!resume || !resume.content_md) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请先上传简历' }));
        return;
      }

      // 3. 获取岗位列表
      let jobs;
      if (body.job_ids && Array.isArray(body.job_ids) && body.job_ids.length > 0) {
        const placeholders = body.job_ids.map(() => '?').join(',');
        jobs = db.prepare(
          `SELECT id, title, company, raw_payload FROM scraped_jobs WHERE id IN (${placeholders})`
        ).all(...body.job_ids);
      } else {
        // 默认获取所有已选中的岗位
        jobs = db.prepare(
          'SELECT id, title, company, raw_payload FROM scraped_jobs WHERE selected = 1'
        ).all();
      }

      if (!jobs || jobs.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '没有可匹配的岗位，请先选择岗位' }));
        return;
      }

      // 4. 构建岗位列表文本
      const jobListText = jobs.map((job, idx) => {
        let description = '';
        try {
          const payload = typeof job.raw_payload === 'string'
            ? JSON.parse(job.raw_payload)
            : (job.raw_payload || {});
          description = payload.jobDesc || payload.description || payload['岗位描述'] || '暂无描述';
        } catch {
          // raw_payload 解析失败，使用默认描述
        }
        return `${idx + 1}. ${job.title} - ${job.company} | ${description}`;
      }).join('\n');

      // 5. 构建 Prompt
      const systemPrompt = [
        '你是一个专业的招聘匹配顾问。请根据简历内容对以下岗位列表进行匹配度评分。',
        '对每个岗位给出 0-100 的分数和简短推荐理由。',
        '返回 JSON 格式结果：[{"job_id": 1, "score": 85, "reason": "推荐理由"}]。',
        '只返回 JSON 数组，不要添加任何额外解释。'
      ].join('');

      const userPrompt = [
        `简历内容：\n${resume.content_md}`,
        '',
        `岗位列表：\n${jobListText}`
      ].join('\n');

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      // 6. 调用 LLM
      const result = await llmClient.chat(messages);

      if (result.error || !result.content) {
        const errMsg = result.error?.message || 'AI 调用返回为空';
        console.error('[AIMatch] LLM 调用失败:', errMsg);
        res.writeHead(500);
        res.end(JSON.stringify({ error: '岗位匹配失败：' + errMsg }));
        return;
      }

      // 7. 解析 JSON 响应
      let matches;
      try {
        // 尝试从 AI 返回内容中提取 JSON 数组
        const content = result.content.trim();
        // 处理可能的 markdown 代码块包裹
        const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(jsonStr);

        if (Array.isArray(parsed)) {
          // 将 AI 返回的 job_id 与原始岗位数据关联
          const jobMap = new Map(jobs.map(j => [j.id, j]));
          matches = parsed.map((item) => {
            const job = jobMap.get(item.job_id);
            return {
              job_id: item.job_id,
              title: job?.title || '',
              company: job?.company || '',
              score: typeof item.score === 'number' ? item.score : 0,
              reason: item.reason || ''
            };
          });
        } else {
          // AI 返回了非数组 JSON，降级返回原始文本
          throw new Error('AI 返回的 JSON 不是数组格式');
        }
      } catch (parseErr) {
        console.warn('[AIMatch] JSON 解析失败，降级返回原始文本:', parseErr.message);
        matches = null;
      }

      console.log(`[AIMatch] 岗位匹配完成，匹配岗位数: ${matches ? matches.length : 0}`);

      res.end(JSON.stringify({
        success: true,
        ...(matches !== null
          ? { matches }
          : { raw_text: result.content }
        )
      }));
    } catch (err) {
      console.error('[AIMatch] 处理失败:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: '岗位匹配失败：' + err.message }));
    }
  });
}

/**
 * POST /api/ai/deep-think - 深度思考分析
 *
 * Body: {
 *   "task": "分析该候选人与岗位的匹配风险",
 *   "job_id": 123,
 *   "deep_think_config": { "mode": "auto", "max_rounds": 10, ... },
 *   "secondary_model": { "enabled": true, "provider": "...", ... }
 * }
 *
 * Response: {
 *   "success": true,
 *   "result": { mode_used, rounds_used, stop_reason, final_answer, state, logs }
 * }
 */
async function handleDeepThink(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const db = getDatabase();

      // 验证必填字段
      if (!body.task || typeof body.task !== 'string' || !body.task.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 task 字段' }));
        return;
      }

      // 验证深度思考配置（合并 DB 设置 + 请求覆盖）
      const dbSettings = getDeepThinkSettings();
      const mergedDeepThinkConfig = {
        ...(dbSettings ? {
          enabled: !!dbSettings.enabled,
          mode: dbSettings.mode,
          max_rounds: dbSettings.max_rounds,
          compression_enabled: !!dbSettings.compression_enabled,
          debug: !!dbSettings.debug,
          no_new_info_rounds: dbSettings.no_new_info_rounds,
          fallback_to_single_when_secondary_missing: !!dbSettings.fallback_to_single
        } : {}),
        ...(body.deep_think_config || {})
      };

      if (Object.keys(mergedDeepThinkConfig).length > 0) {
        const validation = validateDeepThinkConfig(mergedDeepThinkConfig);
        if (!validation.valid) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: '配置错误: ' + validation.errors.join('; ') }));
          return;
        }
      }

      // 获取主模型配置
      const activeConfig = db.prepare(
        'SELECT * FROM ai_configs WHERE is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1'
      ).get();

      if (!activeConfig) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '未配置 AI 模型，请先在 AI 配置中设置' }));
        return;
      }

      const primaryApiKey = decrypt(activeConfig.api_key_encrypted);
      if (!primaryApiKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '主模型 API Key 无效' }));
        return;
      }

      const primaryModelConfig = {
        provider: activeConfig.provider,
        apiKey: primaryApiKey,
        baseURL: activeConfig.base_url,
        model: activeConfig.model_name
      };

      // 处理第二模型配置（优先请求传入，否则从 DB 读取）
      let secondaryModelConfig = null;
      if (body.secondary_model && body.secondary_model.enabled) {
        const sm = body.secondary_model;
        let smApiKey = sm.api_key || '';
        if (sm.api_key_encrypted) {
          smApiKey = decrypt(sm.api_key_encrypted);
        }
        secondaryModelConfig = {
          enabled: true,
          provider: sm.provider || 'custom',
          apiKey: smApiKey,
          baseURL: sm.base_url || '',
          model: sm.model || '',
          temperature: sm.temperature || 0.2,
          max_tokens: sm.max_tokens || 4000,
          timeout: sm.timeout || 60,
          role_preference: sm.role_preference || 'critic'
        };
      } else {
        // 从 DB 读取第二模型配置
        const dbSecondary = getSecondaryModelConfig();
        if (dbSecondary && dbSecondary.api_key_encrypted) {
          try {
            const smApiKey = decrypt(dbSecondary.api_key_encrypted);
            if (smApiKey) {
              secondaryModelConfig = {
                enabled: true,
                provider: dbSecondary.provider,
                apiKey: smApiKey,
                baseURL: dbSecondary.base_url || '',
                model: dbSecondary.model_name || ''
              };
            }
          } catch { /* 解密失败则跳过 */ }
        }
      }

      // 获取岗位上下文
      let jobContext = '';
      if (body.job_id) {
        const job = db.prepare('SELECT * FROM scraped_jobs WHERE id = ?').get(body.job_id);
        if (job) {
          jobContext = serializeJobRecord(job);
        }
      }

      // 获取候选人上下文（简历）
      let candidateContext = '';
      const resume = resumeDb.getLatestResume();
      if (resume && resume.content_md) {
        candidateContext = resume.content_md.slice(0, 5000);
      }

      // 创建 chat 函数工厂
      function createChatFn(modelConfig) {
        const client = createLLMClient({
          provider: modelConfig.provider,
          apiKey: modelConfig.apiKey,
          baseURL: modelConfig.baseURL,
          model: modelConfig.model
        });
        return async (messages) => client.chat(messages);
      }

      console.log('[DeepThink] 开始深度思考分析...');

      // 运行深度思考
      const result = await runDeepThink({
        task: body.task,
        jobContext,
        candidateContext,
        primaryModelConfig,
        secondaryModelConfig,
        deepThinkConfig: mergedDeepThinkConfig,
        createChatFn
      });

      console.log(`[DeepThink] 完成: ${result.rounds_used} 轮, 停止原因: ${result.stop_reason}`);

      // 脱敏日志中的敏感信息
      const safeResult = {
        ...result,
        logs: result.logs.map(log => {
          const safe = { ...log };
          if (safe.data) {
            delete safe.data.apiKey;
            delete safe.data.api_key;
          }
          return safe;
        })
      };

      res.end(JSON.stringify({ success: true, result: safeResult }));
    } catch (err) {
      console.error('[DeepThink] 处理失败:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: '深度思考失败：' + err.message }));
    }
  });
}

/**
 * POST /api/ai/deep-think/config - 保存深度思考设置
 *
 * Body: {
 *   "enabled": true,
 *   "mode": "auto",
 *   "max_rounds": 10,
 *   "compression_enabled": true,
 *   "debug": false,
 *   "no_new_info_rounds": 3,
 *   "fallback_to_single": true
 * }
 */
function handleSaveDeepThinkConfig(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const updated = updateDeepThinkSettings(body);
      if (!updated) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '未提供有效的配置字段' }));
        return;
      }
      const settings = getDeepThinkSettings();
      console.log('[DeepThink] 配置已更新:', JSON.stringify(settings));
      res.end(JSON.stringify({ success: true, settings }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: '无效请求: ' + err.message }));
    }
  });
}

/**
 * POST /api/ai/secondary-model - 保存第二模型配置
 *
 * Body: {
 *   "provider": "openai",
 *   "api_key": "sk-xxx",
 *   "base_url": "https://api.openai.com/v1",
 *   "model_name": "gpt-4o"
 * }
 */
function handleSaveSecondaryModel(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.provider || !body.api_key) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 provider 或 api_key' }));
        return;
      }
      if (typeof body.api_key === 'string' && body.api_key.includes('...')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'API Key 看起来是脱敏值，请输入完整 Key' }));
        return;
      }
      const encryptedKey = encrypt(body.api_key);
      const id = upsertSecondaryModelConfig({
        provider: body.provider,
        apiKeyEncrypted: encryptedKey,
        baseUrl: body.base_url || '',
        modelName: body.model_name || ''
      });
      console.log(`[AIConfig] 第二模型配置已保存 (provider: ${body.provider}, id: ${id})`);
      res.end(JSON.stringify({ success: true, id }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: '无效请求: ' + err.message }));
    }
  });
}

/**
 * DELETE /api/ai/secondary-model - 删除第二模型配置
 */
function handleDeleteSecondaryModel(req, res) {
  const changes = deleteSecondaryModelConfig();
  console.log(`[AIConfig] 第二模型配置已删除 (${changes} 行)`);
  res.end(JSON.stringify({ success: true, deleted: changes }));
}

/**
 * POST /api/ai/keyword-score - 计算关键词匹配度
 * Body: { job_keywords: string[], resume_keywords: string[] }
 * OR: { job_id: number } (auto-extract from job + resume)
 */
function handleKeywordScore(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const { calculateKeywordScore, extractKeywordsFromText } = require('./services/ai/keyword-score-tool');

      let jobKeywords = body.job_keywords || [];
      let resumeKeywords = body.resume_keywords || [];

      // Auto-extract if job_id provided
      if (body.job_id && !jobKeywords.length) {
        const db = getDatabase();
        const job = db.prepare('SELECT * FROM scraped_jobs WHERE id = ?').get(body.job_id);
        if (job) {
          const jobText = [job.title, job.description, job.requirements, job.jobLabels].filter(Boolean).join('\n');
          jobKeywords = extractKeywordsFromText(jobText);
        }
      }

      // Auto-extract from resume if not provided
      if (!resumeKeywords.length) {
        const resume = resumeDb.getLatestResume();
        if (resume && resume.content_md) {
          resumeKeywords = extractKeywordsFromText(resume.content_md);
        }
      }

      const result = calculateKeywordScore(jobKeywords, resumeKeywords);
      res.end(JSON.stringify({ success: true, ...result }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: '评分失败: ' + err.message }));
    }
  });
}

/**
 * GET /api/ai/capabilities — 返回当前 AI 能力状态
 */
function handleGetCapabilities(req, res) {
  try {
    const db = getDatabase();
    const activeConfig = db.prepare('SELECT * FROM ai_configs WHERE is_active = 1').get();
    const dtSettings = getDeepThinkSettings();
    const secondaryModel = getSecondaryModelConfig();

    const capabilities = {
      assistant_chat: !!activeConfig,
      deep_think: !!(activeConfig && dtSettings && dtSettings.enabled),
      deep_think_modes: ['single', 'dual', 'auto'],
      secondary_model_ready: !!(secondaryModel && secondaryModel.api_key_encrypted && secondaryModel.model_name),
      trace_supported: true,
      resume_script_editor: true,
      version: new Date().toISOString().split('T')[0]
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(capabilities));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

/**
 * GET /api/ai/deep-think/config — 返回深度思考配置
 */
function handleGetDeepThinkConfig(req, res) {
  try {
    const settings = getDeepThinkSettings();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(settings || {
      enabled: false,
      mode: 'auto',
      max_rounds: 10,
      compression_enabled: true,
      debug: false,
      no_new_info_rounds: 3,
      fallback_to_single: true
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
}

module.exports = {
  handleGetConfig,
  handleSaveConfig,
  handleOptimizeResume,
  handleAssistantChat,
  handleJobMatch,
  handleDeepThink,
  handleSaveDeepThinkConfig,
  handleSaveSecondaryModel,
  handleDeleteSecondaryModel,
  handleKeywordScore,
  handleGetCapabilities,
  handleGetDeepThinkConfig
};
