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
const jobsDb = require('./jobs-db');
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

/**
 * Strip inline markdown formatting from AI-generated resume content (BUG-06).
 * Preserves heading markers (#) needed by parseResumeStructure().
 */
function sanitizeAIResumeMarkdown(md) {
  if (!md) return '';
  return md
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-*_]{3,}\s*$/gm, '');
}

const REFERENCE_TEXT_LIMIT = 3500;
const PROJECT_SKILL_FILE = path.join(__dirname, '../SKILL.md');
const ASSISTANT_MAX_TOOL_STEPS = 6;
const ASSISTANT_SQL_ROW_LIMIT = 50;
const CONTROLLER_BASE_URL = `http://127.0.0.1:${process.env.CONTROLLER_PORT || '7893'}`;

function ensureFileDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function requestControllerJson(pathname, options = {}) {
  const response = await fetch(`${CONTROLLER_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `Controller request failed: ${pathname}`);
  }
  return data;
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

const ASSISTANT_TOOL_SCHEMAS = [
  {
    name: 'get_tool_guide',
    description: '读取某个工具的详细使用说明，做渐进式披露。',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: '要查看说明的工具名' }
      },
      required: ['tool_name'],
      additionalProperties: false
    },
    returns: '返回工具用途、参数、注意事项。'
  },
  {
    name: 'get_system_map',
    description: '读取系统入口地图，了解简历、岗位、数据库、爬虫、技能文档和联网工具从哪里进入。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    returns: '返回系统入口、路径和使用建议。'
  },
  {
    name: 'read_resume',
    description: '读取当前最新简历的 Markdown、文件名、文件路径。',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    returns: '返回当前简历内容和元信息。'
  },
  {
    name: 'read_current_job',
    description: '读取当前岗位详情，包括职位描述、关键词、链接。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'number', description: '可选，不传则使用当前对话绑定的 job_id' }
      },
      required: [],
      additionalProperties: false
    },
    returns: '返回岗位详情对象。'
  },
  {
    name: 'list_selected_jobs',
    description: '列出当前工作台卡片区中的岗位摘要，与收藏列表语义一致。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 10，最大 20' }
      },
      required: [],
      additionalProperties: false
    },
    returns: '返回工作台卡片区中的岗位列表。'
  },
  {
    name: 'search_jobs_db',
    description: '在本地职位库中按关键词搜索岗位。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 20' }
      },
      required: ['keyword'],
      additionalProperties: false
    },
    returns: '返回命中的岗位列表。'
  },
  {
    name: 'query_database',
    description: '对本地 SQLite 数据库执行只读 SELECT 查询。',
    parameters: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: '只允许 SELECT / WITH / PRAGMA 的只读 SQL' }
      },
      required: ['sql'],
      additionalProperties: false
    },
    returns: '返回 SQL 和结果行。'
  },
  {
    name: 'enqueue_crawl_tasks',
    description: '向后台采集队列追加批量搜索任务，让扩展在后台持续采集。',
    parameters: {
      type: 'object',
      properties: {
        cities: { type: 'array', items: { type: 'string' }, description: '城市数组，如 ["北京","上海"]' },
        keywords: { type: 'array', items: { type: 'string' }, description: '关键词数组，如 ["产品经理","AI产品经理"]' },
        source: { type: 'string', description: '任务来源，默认 ai_assistant' },
        priority: { type: 'string', enum: ['normal', 'urgent', 'high'], description: '任务优先级' },
        batch_id: { type: 'string', description: '批次号' },
        delivery_target: { type: 'string', description: '可选投递目标' }
      },
      required: ['cities', 'keywords'],
      additionalProperties: false
    },
    returns: '返回入队任务数和任务列表。'
  },
  {
    name: 'get_crawl_queue_status',
    description: '查询后台采集队列、最近结果和运行状态。',
    parameters: {
      type: 'object',
      properties: {
        recent_limit: { type: 'number', description: '最近结果条数，默认 10，最大 20' }
      },
      required: [],
      additionalProperties: false
    },
    returns: '返回队列状态、任务队列和最近结果。'
  },
  {
    name: 'update_resume',
    description: '在用户明确要求时，直接更新当前简历内容。',
    parameters: {
      type: 'object',
      properties: {
        content_md: { type: 'string', description: '完整简历 Markdown' },
        reason: { type: 'string', description: '更新原因' }
      },
      required: ['content_md'],
      additionalProperties: false
    },
    returns: '返回是否更新成功和最新简历内容。'
  },
  {
    name: 'update_resume_ops',
    description: '用结构化操作修改简历局部内容，优先于整篇覆盖。',
    parameters: {
      type: 'object',
      properties: {
        ops: { type: 'array', items: { type: 'object' }, description: '结构化操作数组' },
        reason: { type: 'string', description: '修改原因' },
        change_summary: { type: 'object', description: '变更摘要' }
      },
      required: ['ops'],
      additionalProperties: false
    },
    returns: '返回结构化变更信息，由前端实时应用。'
  },
  {
    name: 'read_project_skill',
    description: '读取项目的 SKILL.md，理解爬虫、插件和系统工作方式。',
    parameters: {
      type: 'object',
      properties: {
        skill_path: { type: 'string', description: '相对 ai-bootstrap 的技能文档路径' }
      },
      required: [],
      additionalProperties: false
    },
    returns: '返回技能文档路径和内容摘要。'
  },
  {
    name: 'fetch_url',
    description: '抓取指定 URL 的网页正文文本。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '以 http/https 开头的 URL' }
      },
      required: ['url'],
      additionalProperties: false
    },
    returns: '返回网页正文、状态码和内容类型。'
  },
  {
    name: 'web_search',
    description: '联网搜索公开网页信息，返回结果摘要。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 10' }
      },
      required: ['query'],
      additionalProperties: false
    },
    returns: '返回搜索结果列表。'
  },
  {
    name: 'smart_job_recommend',
    description: '根据用户要求和简历，在数据库中自动筛选、评分、推荐匹配岗位。',
    parameters: {
      type: 'object',
      properties: {
        requirements: { type: 'string', description: '自然语言筛选要求' },
        top_n: { type: 'number', description: '返回前 N 个岗位，默认 20' },
        auto_select: { type: 'boolean', description: '是否自动加入工作台收藏列表' }
      },
      required: ['requirements'],
      additionalProperties: false
    },
    returns: '返回筛选摘要和推荐岗位列表。'
  },
  {
    name: 'collect_recent_jobs_to_workbench',
    description: '按 SQL 的 crawled_at 时间筛选最近入库岗位，再结合简历做匹配并批量加入工作台收藏列表。',
    parameters: {
      type: 'object',
      properties: {
        requirements: { type: 'string', description: '自然语言筛选要求' },
        within_hours: { type: 'number', description: '最近多少小时内入库，默认 24' },
        top_n: { type: 'number', description: '最多加入工作台的岗位数，默认 50' }
      },
      required: ['requirements'],
      additionalProperties: false
    },
    returns: '返回最近入库岗位的筛选摘要和加入工作台数量。'
  },
  {
    name: 'batch_select_jobs',
    description: '批量加入工作台：将岗位同时标记为已选中并加入收藏卡片区。',
    parameters: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'number' }, description: '岗位 ID 数组' }
      },
      required: ['job_ids'],
      additionalProperties: false
    },
    returns: '返回实际加入工作台的数量。'
  },
  {
    name: 'batch_deselect_jobs',
    description: '批量移出工作台：将岗位从收藏卡片区移除（取消收藏）。',
    parameters: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'number' }, description: '要移出的岗位 ID 数组' }
      },
      required: ['job_ids'],
      additionalProperties: false
    },
    returns: '返回实际移出工作台的数量。'
  },
];

function getAssistantToolSchemaMap() {
  return ASSISTANT_TOOL_SCHEMAS.reduce((acc, schema) => {
    acc[schema.name] = schema;
    return acc;
  }, {});
}

function describeToolParameter(paramName, schema) {
  const type = schema?.type || 'any';
  const enumText = Array.isArray(schema?.enum) && schema.enum.length > 0
    ? `，可选值: ${schema.enum.join('/')}`
    : '';
  return `${paramName}: ${type}${enumText}${schema?.description ? `，${schema.description}` : ''}`;
}

function buildToolGuideFromSchema(schema) {
  const properties = schema?.parameters?.properties || {};
  const required = schema?.parameters?.required || [];
  const argDescriptions = Object.keys(properties).reduce((acc, key) => {
    acc[key] = describeToolParameter(key, properties[key]);
    return acc;
  }, {});

  return {
    purpose: schema.description,
    args: argDescriptions,
    required,
    returns: schema.returns || '',
    notes: [
      required.length > 0 ? `必填参数: ${required.join(', ')}` : '该工具无必填参数。',
      '参数必须满足工具 schema，不能随意传未定义字段。'
    ]
  };
}

function validateSchemaValue(value, schema, pathLabel) {
  if (!schema) return;
  const type = schema.type;

  if (type === 'string' && typeof value !== 'string') {
    throw new Error(`${pathLabel} 必须是 string`);
  }
  if (type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) {
    throw new Error(`${pathLabel} 必须是 number`);
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`${pathLabel} 必须是 boolean`);
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`${pathLabel} 必须是 array`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateSchemaValue(item, schema.items, `${pathLabel}[${index}]`));
    }
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${pathLabel} 必须是 object`);
    }
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.includes(value)) {
    throw new Error(`${pathLabel} 取值非法，允许值: ${schema.enum.join(', ')}`);
  }
}

function validateAssistantToolArguments(toolName, args) {
  const schema = getAssistantToolSchemaMap()[toolName];
  if (!schema) {
    throw new Error(`未知工具: ${toolName}`);
  }

  const payload = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const parameterSchema = schema.parameters || { type: 'object', properties: {}, required: [], additionalProperties: true };
  const properties = parameterSchema.properties || {};
  const required = parameterSchema.required || [];

  for (const field of required) {
    if (payload[field] === undefined) {
      throw new Error(`${toolName}.${field} 是必填参数`);
    }
  }

  if (parameterSchema.additionalProperties === false) {
    for (const field of Object.keys(payload)) {
      if (!properties[field]) {
        throw new Error(`${toolName}.${field} 不是允许的参数`);
      }
    }
  }

  for (const [field, value] of Object.entries(payload)) {
    validateSchemaValue(value, properties[field], `${toolName}.${field}`);
  }

  return payload;
}

function getAssistantToolCatalog() {
  return ASSISTANT_TOOL_SCHEMAS.map((schema) => ({
    name: schema.name,
    summary: schema.description,
    parameters: schema.parameters,
  }));
}

function getAssistantToolGuide(toolName) {
  const schema = getAssistantToolSchemaMap()[toolName];
  return schema ? buildToolGuideFromSchema(schema) : null;
}

function getAssistantOpenAITools() {
  return ASSISTANT_TOOL_SCHEMAS.map((schema) => ({
    type: 'function',
    function: {
      name: schema.name,
      description: schema.description,
      parameters: schema.parameters || { type: 'object', properties: {}, required: [], additionalProperties: false }
    }
  }));
}

function getToolExecutionMeta(toolName) {
  const toolToFile = {
    get_tool_guide: 'controller/ai-handler.js',
    get_system_map: 'controller/ai-handler.js',
    read_resume: 'controller/resume-db.js',
    read_current_job: 'controller/ai-handler.js',
    list_selected_jobs: 'controller/ai-handler.js',
    search_jobs_db: 'controller/ai-handler.js',
    query_database: 'controller/ai-handler.js',
    enqueue_crawl_tasks: 'controller/ai-handler.js -> controller /enqueue',
    get_crawl_queue_status: 'controller/ai-handler.js -> controller /status,/queue,/results',
    update_resume: 'controller/resume-db.js',
    update_resume_ops: 'controller/ai-handler.js',
    read_project_skill: 'controller/ai-handler.js',
    fetch_url: 'controller/ai-handler.js',
    web_search: 'controller/ai-handler.js',
    smart_job_recommend: 'controller/services/job-recommender.js',
    batch_select_jobs: 'controller/jobs-db.js',
    batch_deselect_jobs: 'controller/jobs-db.js',
  };

  return {
    tool: toolName,
    file: toolToFile[toolName] || 'controller/ai-handler.js',
  };
}

function summarizeToolResult(toolName, toolResult) {
  if (!toolResult || typeof toolResult !== 'object') return '执行完成';
  switch (toolName) {
    case 'enqueue_crawl_tasks':
      return `已入队 ${toolResult.queued || 0} 个后台任务`;
    case 'get_crawl_queue_status':
      return `队列长度 ${toolResult.status?.queueLength || 0}，运行中 ${toolResult.status?.runningCount || 0}`;
    case 'smart_job_recommend':
      return `扫描 ${toolResult.summary?.total_scanned || 0} 条，推荐 ${toolResult.summary?.recommended || 0} 条`;
    case 'batch_select_jobs':
      return `已加入工作台 ${toolResult.updated || 0} 条`;
    case 'batch_deselect_jobs':
      return `已移出工作台 ${toolResult.updated || 0} 条`;
    case 'search_jobs_db':
      return `命中 ${Array.isArray(toolResult.jobs) ? toolResult.jobs.length : 0} 条岗位`;
    case 'list_selected_jobs':
      return `当前工作台 ${Array.isArray(toolResult.jobs) ? toolResult.jobs.length : 0} 条`;
    case 'query_database':
      return `返回 ${Array.isArray(toolResult.rows) ? toolResult.rows.length : 0} 行`;
    default:
      return '执行完成';
  }
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
    .map((tool) => {
      const required = tool.parameters?.required?.length
        ? ` | required: ${tool.parameters.required.join(', ')}`
        : '';
      return `- ${tool.name}: ${tool.summary}${required}`;
    })
    .join('\n');

  return [
    '你是招聘工作台里的插件态 AI 助手。',
    '你采用简化版 openclaw 的工作方式：先读取开头的三份 .md 文档作为固定上下文，再围绕当前对话与工具进行工作。',
    '这三份 .md 文档在本轮请求中只会出现在上下文开头一次，你必须先基于它们理解身份、规范和长期记忆。',
    '之后你要优先和用户对话，只有在需要读取简历、岗位、数据库、技能文档、互联网网页或需要修改简历时，才调用工具。',
    '不要把所有工具都先跑一遍。优先基于已有上下文和用户消息判断，再按需调用工具。',
    '如果简历内容和岗位信息已经在上下文中（标注"已预读"），直接使用这些内容，不要再调用 read_resume 或 read_current_job。',
    '工具使用采用渐进式披露：先看下面的摘要；若要细化某个工具用法，先调用 get_tool_guide。',
    '如果用户明确要求优化、改写、修改简历，优先调用 update_resume_ops 进行局部结构化修改；仅在需要整篇重写时才使用 update_resume。',
    '如果用户只是咨询，不要修改简历。',
    '如果用户要求后台搜索、批量采集、切页面后继续跑，优先使用 enqueue_crawl_tasks / get_crawl_queue_status，不要假装前端聊天就能持续执行页面脚本。',
    currentJobId ? `当前对话绑定岗位 ID: ${currentJobId}` : '当前没有绑定岗位 ID。',
    '你必须始终只输出 JSON，不允许输出 JSON 之外的自然语言。',
    '当需要工具时，输出：{"action":"tool_call","tool":"工具名","arguments":{...},"reason":"为什么需要这个工具"}',
    'arguments 必须满足工具的函数签名：只传 schema 中定义的字段，字段类型必须正确。',
    '当准备回复用户时，输出：{"action":"respond","reply":"给用户看的回复","suggestions":["可选建议"],"resume_updated":true/false,"resume_updated_content_md":"若本轮改了简历则返回最新完整 Markdown，否则空字符串","memory_update":{"should_update":true/false,"reason":"为什么更新长期记忆","content_md":"完整长期记忆 Markdown 或空字符串"}}',
    '如果你已经通过 update_resume 修改了简历，最终 respond 时必须把 resume_updated 设为 true。',
    `## 岗位推荐触发规则（最高优先级）
当用户消息包含以下任何意图时，你必须立即调用 smart_job_recommend 工具，不能只用文字回答：
- 推荐/筛选/匹配/找/选 + 岗位/工作/职位/公司
- 不要外包/排除外包/非外包
- 薪资/工资 + 要求/不低于/以上/至少
- 根据简历/按照简历/结合简历 + 推荐/匹配
- 帮我找/给我推荐/帮我筛选 + 工作/岗位
- 合适的岗位/适合我的/匹配的工作
- 把岗位加入工作台/放到工作台
- 批量搜索/采集/抓取 + 岗位/职位

检测到上述意图后的标准流程：
1. 如果用户明确提到“搜索/采集/批量搜索/后台继续跑”，先调用 enqueue_crawl_tasks 建立后台任务
2. 需要汇报后台状态时，再调用 get_crawl_queue_status
3. 如果用户是在已有本地职位库里做推荐/筛选，再调用 smart_job_recommend
4. 当用户明确要求“放到工作台/加入工作台”时，直接调用 batch_select_jobs，不要只改 selected 不改收藏`,
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
    `## 简历格式规范（必须严格遵守）
当输出或修改简历时，必须使用以下固定格式，不允许使用其他 Markdown 写法：

### 整体结构
\`\`\`
# 姓名

个人简介/摘要（1-2句话）

📞 电话 | ✉️ 邮箱 | 🔗 链接

---

## 求职意向
期望职位：XXX | 期望城市：XXX | 期望薪资：XXX

---

## 工作经历

### 公司名称 ｜ 时间范围
**职位名称** · 地点

- **【能力标签】** 具体职责描述和量化成果
  项目示例：项目名称 —— 项目简述

---

## 教育经历

### 学校名称 ｜ 时间范围
**学位 · 专业**

---

## 技能特长
- 技能类别：具体技能列表
\`\`\`

### 工作经历块规则
1. 每家公司用 ### 三级标题，格式：\`### 公司名称 ｜ 起止时间\`
2. 职位信息紧跟标题：\`**职位名称** · 地点\`
3. 每条成就用能力标签开头：\`- **【标签】** 描述\`
4. 项目示例缩进在对应成就下方
5. 不要使用多层嵌套列表
6. 量化结果优先（百分比、数字、指标）`,
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

const DIRECT_CRAWL_CITY_DEFAULTS = ['北京', '上海', '杭州', '深圳'];
const DIRECT_CRAWL_KEYWORD_DEFAULTS = [
  '产品经理',
  'AI产品经理',
  '产品',
  '产品运营'
];

function hasAnyKeyword(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractDirectCrawlYearsLimit(message) {
  const text = String(message || '');
  const match = text.match(/([0-9]+)\s*年(?:以下|以内|及以下)/);
  if (match) {
    return Number(match[1]);
  }
  if (/应届|校招|毕业两年内/.test(text)) {
    return 2;
  }
  return null;
}

function extractDirectCrawlCities(message) {
  const text = String(message || '');
  const supportedCities = ['北京', '上海', '杭州', '深圳', '广州', '南京', '苏州', '成都', '武汉', '西安'];
  const matches = supportedCities.filter((city) => text.includes(city));
  return matches.length > 0 ? matches : DIRECT_CRAWL_CITY_DEFAULTS;
}

function extractDirectCrawlKeywords(message) {
  const text = String(message || '');
  const keywords = [];

  if (/AI产品|人工智能产品|大模型产品|智能体产品|机器人产品/i.test(text)) {
    keywords.push('AI产品经理');
  }
  if (/产品运营/.test(text)) {
    keywords.push('产品运营');
  }
  if (/产品经理|产品岗位|产品岗/.test(text)) {
    keywords.push('产品经理');
  }
  if (/产品\b/.test(text) || /产品/.test(text)) {
    keywords.push('产品');
  }

  return [...new Set(keywords)].slice(0, 6).length > 0
    ? [...new Set(keywords)].slice(0, 6)
    : DIRECT_CRAWL_KEYWORD_DEFAULTS;
}

function extractRecentWindowHours(message) {
  const text = String(message || '');
  const dayMatch = text.match(/最近\s*([0-9]+)\s*天/);
  if (dayMatch) {
    return Math.max(1, Number(dayMatch[1]) * 24);
  }
  const hourMatch = text.match(/最近\s*([0-9]+)\s*(?:小时|个小时|h)/i);
  if (hourMatch) {
    return Math.max(1, Number(hourMatch[1]));
  }
  if (/今天|今日/.test(text)) return 24;
  if (/最近|最新|新爬取|新抓取|新采集|刚爬取|刚抓取|刚采集/.test(text)) return 24;
  return 24;
}

function detectDirectAssistantIntent(message) {
  const text = String(message || '').trim();
  if (!text) return null;

  const wantsWorkbench = /工作台|卡片区|收藏列表|放到工作台|加入工作台/.test(text);
  const recentCollectIntent = wantsWorkbench
    && hasAnyKeyword(text, [/新爬取/, /新抓取/, /新采集/, /最近.*爬取/, /最新.*爬取/, /最近.*入库/, /最新.*入库/, /今天.*爬取/, /刚.*爬取/])
    && hasAnyKeyword(text, [/收藏/, /加入/, /推送/, /放到/]);

  if (recentCollectIntent) {
    return {
      type: 'recent_jobs_recommend_and_collect',
      requirements: text,
      within_hours: extractRecentWindowHours(text),
    };
  }

  const localRecommendIntent = wantsWorkbench && hasAnyKeyword(text, [
    /推荐/, /筛选/, /匹配/, /找/, /适合/, /可投递/, /可以投递/, /能投递/
  ]) && hasAnyKeyword(text, [
    /岗位/, /职位/, /工作/
  ]);

  if (localRecommendIntent) {
    return {
      type: 'local_recommend_and_collect',
      requirements: text,
    };
  }

  const crawlIntent = hasAnyKeyword(text, [
    /批量搜索/, /批量采集/, /批量抓取/, /后台继续跑/, /继续跑/, /采集所有/, /搜索所有/
  ]) && hasAnyKeyword(text, [
    /岗位/, /职位/, /工作/
  ]);

  if (crawlIntent) {
    return {
      type: 'enqueue_crawl_tasks',
      cities: extractDirectCrawlCities(text),
      keywords: extractDirectCrawlKeywords(text),
      yearsLimit: extractDirectCrawlYearsLimit(text),
      wantsWorkbench: /工作台|卡片区|收藏列表|放到工作台|加入工作台/.test(text),
    };
  }

  const statusIntent = hasAnyKeyword(text, [
    /队列状态/, /采集状态/, /还在跑/, /是否在运行/, /运行状态/, /进度/, /排队/, /后台任务/
  ]);

  if (statusIntent) {
    return {
      type: 'get_crawl_queue_status',
      recent_limit: 10,
    };
  }

  return null;
}

async function handleDirectAssistantIntent({ db, intent, message, onProgress }) {
  if (!intent) return null;

  if (intent.type === 'recent_jobs_recommend_and_collect') {
    onProgress?.({
      type: 'trace',
      message: '命中最近入库岗位收藏链路，将按 SQL 的 crawled_at 时间筛选。',
      category: 'route',
      file: 'controller/jobs-db.js',
    });
    onProgress?.({
      type: 'phase',
      message: '正在读取最近入库岗位...',
    });

    const toolResult = await executeAssistantTool({
      db,
      toolName: 'collect_recent_jobs_to_workbench',
      args: {
        requirements: intent.requirements,
        within_hours: intent.within_hours,
        top_n: 50,
      },
      currentJobId: null,
      resume: null,
    });

    onProgress?.({
      type: 'trace',
      message: `最近 ${intent.within_hours} 小时内共扫描 ${toolResult.summary?.total_scanned || 0} 条，加入工作台 ${toolResult.collected?.updated || 0} 条。`,
      category: 'result',
      tool: 'collect_recent_jobs_to_workbench',
      file: 'controller/jobs-db.js + controller/services/job-recommender.js',
    });

    return {
      success: true,
      reply: `已按最近 ${intent.within_hours} 小时入库的岗位做匹配，共扫描 ${toolResult.summary?.total_scanned || 0} 条，推荐 ${toolResult.summary?.recommended || 0} 条，加入工作台 ${toolResult.collected?.updated || 0} 条。`,
      suggestions: [
        '可继续让我只看今天新入库的岗位',
        '可继续让我按薪资或城市进一步缩小范围'
      ],
      resume_updated: false,
      resume_updated_content_md: '',
      memory_update: { should_update: false, reason: '', content_md: '' },
      tool_trace: [
        { tool: 'collect_recent_jobs_to_workbench', reason: '命中最近入库岗位收藏链路，按 SQL 时间过滤后再匹配' }
      ],
      direct_intent: {
        type: 'recent_jobs_recommend_and_collect',
        within_hours: intent.within_hours,
        summary: toolResult.summary || {},
        collected: toolResult.collected || { updated: 0, total: 0 },
        jobs: toolResult.jobs || [],
      }
    };
  }

  if (intent.type === 'local_recommend_and_collect') {
    onProgress?.({
      type: 'trace',
      message: '命中库内筛选直达链路，跳过网站采集队列。',
      category: 'route',
      file: 'controller/ai-handler.js',
    });
    onProgress?.({
      type: 'phase',
      message: '正在读取简历和本地岗位库...',
    });
    const { recommendJobs } = require('./services/job-recommender');
    const resume = resumeDb.getLatestResume();
    if (!resume?.content_md) {
      throw new Error('请先上传简历，再进行库内岗位筛选');
    }

    const llmClient = createActiveLLMClient(db);
    if (!llmClient) {
      throw new Error('请先配置 AI 提供商');
    }

    onProgress?.({
      type: 'trace',
      message: '使用 controller/services/job-recommender.js 执行数据库内筛选和并行评分。',
      category: 'action',
      file: 'controller/services/job-recommender.js',
    });

    const result = await recommendJobs({
      userPrompt: intent.requirements,
      resumeMd: resume.content_md,
      db,
      llmClient,
      topN: 50,
      onProgress,
    });

    const jobIds = (result.jobs || []).map((job) => Number(job.id)).filter((id) => Number.isInteger(id) && id > 0);
    onProgress?.({
      type: 'trace',
      message: `数据库筛选完成：扫描 ${result.summary?.total_scanned || 0} 条，推荐 ${result.summary?.recommended || 0} 条。`,
      category: 'result',
      tool: 'smart_job_recommend',
      file: 'controller/services/job-recommender.js',
    });
    onProgress?.({
      type: 'phase',
      message: '正在把推荐结果加入工作台...',
    });
    const collected = jobIds.length > 0 ? jobsDb.batchCollectToWorkbench(jobIds) : { updated: 0, total: 0 };
    onProgress?.({
      type: 'trace',
      message: `已加入工作台 ${collected.updated} 条岗位。`,
      category: 'result',
      tool: 'batch_select_jobs',
      file: 'controller/jobs-db.js',
    });

    return {
      success: true,
      reply: `已在数据库中完成并行筛选，共扫描 ${result.summary?.total_scanned || 0} 条岗位，硬过滤后 ${result.summary?.after_hard_filter || 0} 条，加入工作台 ${collected.updated} 条。`,
      suggestions: [
        '可继续让我缩小到指定城市或薪资范围',
        '可继续让我查看这批岗位为什么被推荐'
      ],
      resume_updated: false,
      resume_updated_content_md: '',
      memory_update: { should_update: false, reason: '', content_md: '' },
      tool_trace: [
        { tool: 'smart_job_recommend', reason: '命中库内筛选硬路由，直接在数据库内推荐岗位' },
        { tool: 'batch_select_jobs', reason: '将推荐岗位批量加入工作台收藏列表' }
      ],
      direct_intent: {
        type: 'local_recommend_and_collect',
        summary: result.summary || {},
        collected,
        jobs: result.jobs || [],
      }
    };
  }

  if (intent.type === 'enqueue_crawl_tasks') {
    onProgress?.({
      type: 'trace',
      message: '命中后台采集直达链路，准备调用 controller /enqueue。',
      category: 'route',
      file: 'controller/ai-handler.js',
    });
    onProgress?.({
      type: 'phase',
      message: '正在创建后台采集任务...',
    });
    const batchId = `ai-batch-${Date.now()}`;
    const toolResult = await executeAssistantTool({
      db,
      toolName: 'enqueue_crawl_tasks',
      args: {
        cities: intent.cities,
        keywords: intent.keywords,
        source: 'ai_assistant',
        priority: 'urgent',
        batch_id: batchId
      },
      currentJobId: null,
      resume: null,
    });
    onProgress?.({
      type: 'trace',
      message: `已创建批次 ${batchId}，入队 ${toolResult.queued || 0} 个任务。`,
      category: 'result',
      tool: 'enqueue_crawl_tasks',
      file: 'controller/ai-handler.js -> controller /enqueue',
    });

    const yearsText = intent.yearsLimit ? `${intent.yearsLimit}年以下` : '当前默认经验范围';
    const workbenchText = intent.wantsWorkbench
      ? '已先进入后台采集队列；工作台卡片区需要等采集结果入库后再加入。'
      : '已进入后台采集队列。';

    return {
      success: true,
      reply: `已创建后台采集任务 ${toolResult.queued} 个，批次 ${batchId}。范围：${intent.cities.join('、')}，关键词：${intent.keywords.join('、')}，经验要求按 ${yearsText} 执行。${workbenchText}`,
      suggestions: [
        '可继续让我查询这批任务的运行状态',
        '如果要缩小范围，可以指定城市或关键词'
      ],
      resume_updated: false,
      resume_updated_content_md: '',
      memory_update: { should_update: false, reason: '', content_md: '' },
      tool_trace: [
        { tool: 'enqueue_crawl_tasks', reason: '命中批量采集硬路由，直接入后台队列' }
      ],
      direct_intent: {
        type: 'enqueue_crawl_tasks',
        batch_id: batchId,
        queued: toolResult.queued,
        tasks: toolResult.tasks || [],
      }
    };
  }

  if (intent.type === 'get_crawl_queue_status') {
    onProgress?.({
      type: 'trace',
      message: '命中采集状态直达链路，准备读取 controller 状态。',
      category: 'route',
      file: 'controller/ai-handler.js',
    });
    const toolResult = await executeAssistantTool({
      db,
      toolName: 'get_crawl_queue_status',
      args: { recent_limit: intent.recent_limit || 10 },
      currentJobId: null,
      resume: null,
    });
    onProgress?.({
      type: 'trace',
      message: `状态读取完成：队列 ${toolResult.status?.queueLength || 0}，运行中 ${toolResult.status?.runningCount || 0}。`,
      category: 'result',
      tool: 'get_crawl_queue_status',
      file: 'controller/ai-handler.js -> controller /status,/queue,/results',
    });

    const status = toolResult.status || {};
    return {
      success: true,
      reply: `当前队列长度 ${status.queueLength || 0}，运行中 ${status.runningCount || 0}，待处理 ${status.pendingCount || 0}，已完成 ${status.completedCount || 0}。`,
      suggestions: [
        '如果需要，我可以继续细看最近失败原因',
        '如果需要，我可以继续检查这批任务是否由 AI 助手发起'
      ],
      resume_updated: false,
      resume_updated_content_md: '',
      memory_update: { should_update: false, reason: '', content_md: '' },
      tool_trace: [
        { tool: 'get_crawl_queue_status', reason: '命中采集状态硬路由，直接查询后台状态' }
      ],
      direct_intent: {
        type: 'get_crawl_queue_status',
        status: toolResult.status || {},
        queue: toolResult.queue || {},
        recent_results: toolResult.recent_results || [],
      }
    };
  }

  return null;
}

async function executeAssistantTool({ db, toolName, args, currentJobId, resume, onProgress = null }) {
  const validatedArgs = validateAssistantToolArguments(toolName, args);

  switch (toolName) {
    case 'get_tool_guide': {
      const guide = getAssistantToolGuide(validatedArgs?.tool_name);
      if (!guide) {
        throw new Error(`未知工具说明: ${validatedArgs?.tool_name || ''}`);
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
      const job = getJobRecord(db, Number(validatedArgs?.job_id) || currentJobId);
      return {
        job: serializeJobRecord(job),
      };
    }
    case 'list_selected_jobs': {
      const limit = Math.max(1, Math.min(Number(validatedArgs?.limit) || 10, 20));
      const rows = db.prepare(
        'SELECT id, title, company, location, salary, keywords FROM scraped_jobs WHERE is_favorite = 1 ORDER BY id DESC LIMIT ?'
      ).all(limit);
      return { jobs: rows };
    }
    case 'search_jobs_db': {
      const keyword = String(validatedArgs?.keyword || '').trim();
      const limit = Math.max(1, Math.min(Number(validatedArgs?.limit) || 10, 20));
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
      const sql = sanitizeSqlQuery(validatedArgs?.sql);
      const rows = db.prepare(sql).all();
      return { sql, rows };
    }
    case 'enqueue_crawl_tasks': {
      const rawCities = Array.isArray(validatedArgs?.cities) ? validatedArgs.cities : [];
      const rawKeywords = Array.isArray(validatedArgs?.keywords) ? validatedArgs.keywords : [];
      const cities = rawCities.map((item) => String(item || '').trim()).filter(Boolean);
      const keywords = rawKeywords.map((item) => String(item || '').trim()).filter(Boolean);
      if (cities.length === 0 || keywords.length === 0) {
        throw new Error('cities 和 keywords 都必须是非空数组');
      }

      const source = String(validatedArgs?.source || 'ai_assistant').trim() || 'ai_assistant';
      const priority = String(validatedArgs?.priority || 'normal').trim() || 'normal';
      const batchId = String(validatedArgs?.batch_id || '').trim() || null;
      const deliveryTarget = String(validatedArgs?.delivery_target || '').trim() || null;

      const tasks = [];
      for (const city of cities) {
        for (const keyword of keywords) {
          const payload = { city, keyword, source, priority };
          if (batchId) payload.batchId = batchId;
          if (deliveryTarget) payload.deliveryTarget = deliveryTarget;
          const result = await requestControllerJson('/enqueue', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          tasks.push({
            taskId: result.taskId,
            city,
            keyword,
            queueLength: result.queueLength || null
          });
        }
      }

      return {
        success: true,
        queued: tasks.length,
        tasks,
        background_run: true
      };
    }
    case 'get_crawl_queue_status': {
      const recentLimit = Math.max(1, Math.min(Number(validatedArgs?.recent_limit) || 10, 20));
      const [status, queue, results] = await Promise.all([
        requestControllerJson('/status'),
        requestControllerJson('/queue', { method: 'GET' }),
        requestControllerJson('/results', { method: 'GET' })
      ]);
      return {
        status,
        queue,
        recent_results: Array.isArray(results) ? results.slice(-recentLimit) : []
      };
    }
    case 'update_resume': {
      const contentMd = sanitizeAIResumeMarkdown(String(validatedArgs?.content_md || '').trim());
      const reason = String(validatedArgs?.reason || '').trim();
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
    case 'update_resume_ops': {
      const ops = validatedArgs?.ops;
      const reason = String(validatedArgs?.reason || '').trim();
      const changeSummary = validatedArgs?.change_summary || {};
      if (!Array.isArray(ops) || ops.length === 0) {
        throw new Error('ops 必须是非空数组');
      }
      // 白名单校验
      const ALLOWED_OPS = [
        'resume_set_field', 'resume_update_node', 'resume_insert_node',
        'resume_delete_node', 'resume_move_node', 'resume_replace_text',
        'resume_set_template', 'resume_commit_changes', 'resume_rollback_changes'
      ];
      for (const op of ops) {
        if (!ALLOWED_OPS.includes(op.tool)) {
          throw new Error(`不允许的操作: ${op.tool}`);
        }
      }
      return {
        success: true,
        reason,
        resume_updated: true,
        resume_ops: ops,
        resume_change_summary: changeSummary,
      };
    }
    case 'read_project_skill': {
      // 支持读取子目录中的 skill 文件
      let skillPath = PROJECT_SKILL_FILE;
      if (validatedArgs?.skill_path) {
        const resolved = path.resolve(AI_BOOTSTRAP_DIR, validatedArgs.skill_path);
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
      return await fetchUrlText(validatedArgs?.url);
    }
    case 'web_search': {
      return await searchWeb(validatedArgs?.query, Math.max(1, Math.min(Number(validatedArgs?.limit) || 5, 10)));
    }
    case 'smart_job_recommend': {
      const { recommendJobs } = require('./services/job-recommender');
      const resumeData = resume || resumeDb.getLatestResume();
      const resumeMd = resumeData?.content_md || '';
      const requirements = String(validatedArgs?.requirements || '').trim();
      if (!requirements) throw new Error('请提供筛选要求');
      if (!resumeMd) throw new Error('请先上传简历');

      const llmClient = createActiveLLMClient(db);
      const result = await recommendJobs({
        userPrompt: requirements,
        resumeMd,
        db,
        llmClient,
        topN: Number(validatedArgs?.top_n) || 20,
        onProgress,
      });

      // 如果用户要求自动加入工作台
      if (validatedArgs?.auto_select && result.success && result.jobs.length > 0) {
        const ids = result.jobs.map((job) => job.id);
        const collectResult = jobsDb.batchCollectToWorkbench(ids);
        result.auto_selected = true;
        result.auto_selected_count = collectResult.updated;
      }

      return result;
    }
    case 'collect_recent_jobs_to_workbench': {
      const { recommendJobs } = require('./services/job-recommender');
      const resumeData = resume || resumeDb.getLatestResume();
      const resumeMd = resumeData?.content_md || '';
      const requirements = String(validatedArgs?.requirements || '').trim();
      const withinHours = Math.max(1, Math.min(Number(validatedArgs?.within_hours) || 24, 24 * 30));
      const topN = Math.max(1, Math.min(Number(validatedArgs?.top_n) || 50, 200));

      if (!requirements) throw new Error('请提供筛选要求');
      if (!resumeMd) throw new Error('请先上传简历');

      const recentJobs = jobsDb.getRecentlyCrawledJobs(withinHours, 1000);
      if (recentJobs.length === 0) {
        return {
          success: true,
          summary: {
            total_scanned: 0,
            after_hard_filter: 0,
            recommended: 0,
            within_hours: withinHours,
          },
          collected: { updated: 0, total: 0 },
          jobs: [],
        };
      }

      const llmClient = createActiveLLMClient(db);
      const result = await recommendJobs({
        userPrompt: requirements,
        resumeMd,
        db,
        llmClient,
        topN,
        candidateJobs: recentJobs,
        onProgress,
      });

      const ids = (result.jobs || []).map((job) => job.id).filter(Boolean);
      const collected = ids.length > 0 ? jobsDb.batchCollectToWorkbench(ids) : { updated: 0, total: 0 };

      return {
        ...result,
        summary: {
          ...(result.summary || {}),
          within_hours: withinHours,
        },
        collected,
      };
    }
    case 'batch_select_jobs': {
      const jobIds = validatedArgs?.job_ids;
      if (!Array.isArray(jobIds) || jobIds.length === 0) {
        throw new Error('job_ids 必须是非空数组');
      }
      const collectResult = jobsDb.batchCollectToWorkbench(jobIds);
      return { success: true, updated: collectResult.updated, total: collectResult.total };
    }
    case 'batch_deselect_jobs': {
      const deselectIds = validatedArgs?.job_ids;
      if (!Array.isArray(deselectIds) || deselectIds.length === 0) {
        throw new Error('job_ids 必须是非空数组');
      }
      const result = jobsDb.batchSetFavorite(deselectIds, false);
      return { success: true, updated: result.updated, total: result.total };
    }
    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

async function runAssistantLoop({ llmClient, systemPrompt, conversationHistory, userMessage, db, currentJobId, resume }) {
  const messages = [{ role: 'system', content: systemPrompt }];
  messages.push(...conversationHistory);
  messages.push({ role: 'user', content: userMessage });
  const nativeTools = typeof llmClient?.supportsNativeTools === 'function' && llmClient.supportsNativeTools()
    ? getAssistantOpenAITools()
    : null;

  let resumeUpdated = false;
  let latestResumeContent = resume?.content_md || '';
  const toolTrace = [];

  for (let step = 0; step < ASSISTANT_MAX_TOOL_STEPS; step += 1) {
    const result = await llmClient.chat(messages, nativeTools ? { tools: nativeTools, toolChoice: 'auto' } : undefined);
    if (result.error || !result.content) {
      if (!result.error && Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
        // continue below
      } else {
        const errMsg = result.error?.message || 'AI 调用返回为空';
        throw new Error(errMsg);
      }
    }

    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        const toolName = toolCall?.function?.name;
        const rawArgs = toolCall?.function?.arguments || '{}';
        const parsedArgs = extractJsonObject(rawArgs) || {};

        const toolResult = await executeAssistantTool({
          db,
          toolName,
          args: parsedArgs,
          currentJobId,
          resume,
          onProgress: null,
        });

        if (toolResult?.resume_updated && toolResult?.content_md) {
          resumeUpdated = true;
          latestResumeContent = toolResult.content_md;
        }

        toolTrace.push({
          tool: toolName,
          reason: 'native_tool_call',
        });

        messages.push({
          role: 'assistant',
          content: result.content || '',
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    if (!result.content) {
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
        onProgress: null,
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
 * SSE 版助手循环 - 带进度回调
 */
async function runAssistantLoopWithProgress({ llmClient, systemPrompt, conversationHistory, userMessage, db, currentJobId, resume, onProgress }) {
  const messages = [{ role: 'system', content: systemPrompt }];
  messages.push(...conversationHistory);
  messages.push({ role: 'user', content: userMessage });
  const nativeTools = typeof llmClient?.supportsNativeTools === 'function' && llmClient.supportsNativeTools()
    ? getAssistantOpenAITools()
    : null;

  let resumeUpdated = false;
  let latestResumeContent = resume?.content_md || '';
  const toolTrace = [];
  let collectedOps = [];
  let lastChangeSummary = {};

  onProgress({
    type: 'trace',
    message: nativeTools
      ? '已启用原生 function calling；模型可直接返回 tool calls。'
      : '当前模型未启用原生 function calling，将使用 JSON 工具协议兜底。',
    category: 'mode',
  });

  for (let step = 0; step < ASSISTANT_MAX_TOOL_STEPS; step += 1) {
    if (step > 0) {
      onProgress({ type: 'phase', message: `第 ${step + 1} 轮思考...` });
    }

    const result = await llmClient.chat(messages, nativeTools ? { tools: nativeTools, toolChoice: 'auto' } : undefined);
    if (result.error || !result.content) {
      if (!result.error && Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
        // continue below
      } else {
        const errMsg = result.error?.message || 'AI 调用返回为空';
        throw new Error(errMsg);
      }
    }

    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        const toolName = toolCall?.function?.name;
        const rawArgs = toolCall?.function?.arguments || '{}';
        const parsedArgs = extractJsonObject(rawArgs) || {};
        const toolMeta = getToolExecutionMeta(toolName);

        onProgress({
          type: 'trace',
          message: `模型决定调用 ${toolName}`,
          category: 'decision',
          tool: toolName,
          file: toolMeta.file,
          arguments_preview: parsedArgs,
        });

        const TOOL_LABELS = {
          read_resume: '📄 正在读取简历...',
          read_current_job: '📋 正在读取岗位信息...',
          update_resume: '✏️ 正在修改简历...',
          update_resume_ops: '✏️ 正在局部修改简历...',
          search_jobs_db: '🔍 正在搜索岗位...',
          query_database: '🗃️ 正在查询数据...',
          list_selected_jobs: '📌 正在读取收藏岗位...',
          web_search: '🌐 正在搜索网络...',
          fetch_url: '🔗 正在读取网页...',
          enqueue_crawl_tasks: '🕸️ 正在加入后台采集队列...',
          get_crawl_queue_status: '📡 正在读取采集状态...',
          smart_job_recommend: '🎯 正在智能推荐岗位...',
          batch_select_jobs: '📥 正在加入工作台...',
          batch_deselect_jobs: '📤 正在移出工作台...',
        };
        onProgress({ type: 'tool', tool: toolName, message: TOOL_LABELS[toolName] || `🔧 正在执行 ${toolName}...` });

        const toolResult = await executeAssistantTool({
          db,
          toolName,
          args: parsedArgs,
          currentJobId,
          resume,
          onProgress,
        });

        if (toolResult?.resume_updated && toolResult?.content_md) {
          resumeUpdated = true;
          latestResumeContent = toolResult.content_md;
          onProgress({ type: 'resume_updated', message: '✅ 简历已更新' });
        }

        if (toolResult?.resume_updated && toolResult?.resume_ops) {
          resumeUpdated = true;
          collectedOps.push(...toolResult.resume_ops);
          lastChangeSummary = toolResult.resume_change_summary || lastChangeSummary;
          onProgress({
            type: 'resume_ops_batch',
            ops: toolResult.resume_ops,
            change_summary: toolResult.resume_change_summary || {},
          });
          onProgress({ type: 'resume_updated', message: '✅ 简历局部更新' });
        }

        if (toolName === 'smart_job_recommend' && toolResult?.success && toolResult?.jobs) {
          onProgress({
            type: 'job_recommendations',
            summary: toolResult.summary || {},
            jobs: toolResult.jobs || [],
          });
        }

        toolTrace.push({
          tool: toolName,
          reason: 'native_tool_call',
        });

        onProgress({
          type: 'trace',
          message: summarizeToolResult(toolName, toolResult),
          category: 'result',
          tool: toolName,
          file: toolMeta.file,
        });

        messages.push({
          role: 'assistant',
          content: result.content || '',
        });
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolName,
          content: JSON.stringify(toolResult),
        });
      }
      continue;
    }

    if (!result.content) {
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
      const toolName = parsed.tool;
      const toolMeta = getToolExecutionMeta(toolName);
      const TOOL_LABELS = {
        read_resume: '📄 正在读取简历...',
        read_current_job: '📋 正在读取岗位信息...',
        update_resume: '✏️ 正在修改简历...',
        update_resume_ops: '✏️ 正在局部修改简历...',
        search_jobs_db: '🔍 正在搜索岗位...',
        query_database: '🗃️ 正在查询数据...',
        list_selected_jobs: '📌 正在读取收藏岗位...',
        web_search: '🌐 正在搜索网络...',
        fetch_url: '🔗 正在读取网页...',
        enqueue_crawl_tasks: '🕸️ 正在加入后台采集队列...',
        get_crawl_queue_status: '📡 正在读取采集状态...',
        smart_job_recommend: '🎯 正在智能推荐岗位...',
        batch_select_jobs: '📥 正在加入工作台...',
        batch_deselect_jobs: '📤 正在移出工作台...',
      };
      onProgress({
        type: 'trace',
        message: `模型决定调用 ${toolName}`,
        category: 'decision',
        tool: toolName,
        file: toolMeta.file,
        arguments_preview: parsed.arguments || {},
      });
      onProgress({ type: 'tool', tool: toolName, message: TOOL_LABELS[toolName] || `🔧 正在执行 ${toolName}...` });

      const toolResult = await executeAssistantTool({
        db,
        toolName,
        args: parsed.arguments || {},
        currentJobId,
        resume,
        onProgress,
      });

      if (toolResult?.resume_updated && toolResult?.content_md) {
        resumeUpdated = true;
        latestResumeContent = toolResult.content_md;
        onProgress({ type: 'resume_updated', message: '✅ 简历已更新' });
      }

      // 结构化操作模式 — 实时推送 ops 给前端
      if (toolResult?.resume_updated && toolResult?.resume_ops) {
        resumeUpdated = true;
        collectedOps.push(...toolResult.resume_ops);
        lastChangeSummary = toolResult.resume_change_summary || lastChangeSummary;
        onProgress({
          type: 'resume_ops_batch',
          ops: toolResult.resume_ops,
          change_summary: toolResult.resume_change_summary || {},
        });
        onProgress({ type: 'resume_updated', message: '✅ 简历局部更新' });
      }

      // 推荐岗位结果实时推送给前端
      if (toolName === 'smart_job_recommend' && toolResult?.success && toolResult?.jobs) {
        onProgress({
          type: 'job_recommendations',
          summary: toolResult.summary || {},
          jobs: toolResult.jobs || [],
        });
      }

      toolTrace.push({
        tool: toolName,
        reason: String(parsed.reason || '').trim(),
      });

      onProgress({
        type: 'trace',
        message: summarizeToolResult(toolName, toolResult),
        category: 'result',
        tool: toolName,
        file: toolMeta.file,
      });

      messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
      messages.push({
        role: 'user',
        content: `工具 ${toolName} 执行结果:\n${JSON.stringify(toolResult, null, 2)}`,
      });

      continue;
    }

    if (parsed.action === 'respond') {
      onProgress({ type: 'phase', message: '✨ 生成回复中...' });
      return {
        reply: String(parsed.reply || '').trim(),
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        resume_updated: resumeUpdated || !!parsed.resume_updated,
        resume_updated_content_md: resumeUpdated
          ? latestResumeContent
          : (parsed.resume_updated_content_md || ''),
        resume_ops: collectedOps.length > 0 ? collectedOps : null,
        resume_change_summary: collectedOps.length > 0 ? lastChangeSummary : null,
        memory_update: parsed.memory_update || { should_update: false, reason: '', content_md: '' },
        tool_trace: toolTrace,
      };
    }

    // Unknown action - treat content as reply
    return {
      reply: String(result.content || '').trim(),
      suggestions: [],
      resume_updated: resumeUpdated,
      resume_updated_content_md: resumeUpdated ? latestResumeContent : '',
      memory_update: { should_update: false, reason: '', content_md: '' },
      tool_trace: toolTrace,
    };
  }

  return {
    reply: '已达到最大工具调用步数，请精简问题后重试。',
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
      const directIntent = detectDirectAssistantIntent(message);
      const directResult = await handleDirectAssistantIntent({ db, intent: directIntent, message });
      if (directResult) {
        res.end(JSON.stringify({
          success: true,
          reply: sanitizeReply(directResult.reply),
          suggestions: directResult.suggestions,
          resume_updated: false,
          resume_updated_content_md: '',
          memory_updated: false,
          memory_update_reason: '',
          tool_trace: directResult.tool_trace,
          direct_intent: directResult.direct_intent,
        }));
        return;
      }

      const bootstrapContext = readAIBootstrapContext();

      // Auto-preread: inject resume + job into system prompt to avoid tool_call rounds
      let prereadContext = '';
      if (resume && resume.content_md) {
        prereadContext += `\n\n## 当前简历内容（已预读，无需调用 read_resume）\n\`\`\`markdown\n${resume.content_md}\n\`\`\`\n`;
      }
      if (currentJobId) {
        try {
          const jobRow = db.prepare('SELECT title, company, description FROM scraped_jobs WHERE id = ?').get(currentJobId);
          if (jobRow) {
            prereadContext += `\n\n## 当前岗位信息（已预读，无需调用 read_current_job）\n- 岗位: ${jobRow.title}\n- 公司: ${jobRow.company}\n- 描述: ${(jobRow.description || '').slice(0, 1000)}\n`;
          }
        } catch (e) {
          // ignore - model can still use read_current_job tool
        }
      }

      const systemPrompt = buildAssistantSystemPrompt({
        bootstrapContext,
        currentJobId,
      }) + prereadContext;
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
 * POST /api/ai/assistant/stream - SSE 流式 AI 助手
 * 返回 text/event-stream，实时推送工具执行进度和最终回复
 */
async function handleAssistantChatStream(req, res) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const db = getDatabase();
      const llmClient = createActiveLLMClient(db);
      if (!llmClient) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '请先配置 AI 提供商' }));
        return;
      }

      const message = String(body.message || '').trim();
      if (!message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '缺少 message' }));
        return;
      }

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const sendEvent = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      };
      res.write(': connected\n\n');

      const currentJobId = Number(body.job_id) || null;
      const resume = resumeDb.getLatestResume();
      const directIntent = detectDirectAssistantIntent(message);
      if (directIntent) {
        sendEvent('trace', {
          message: `命中直接意图路由: ${directIntent.type}`,
          category: 'route',
          file: 'controller/ai-handler.js',
        });
      }
      const directResult = await handleDirectAssistantIntent({
        db,
        intent: directIntent,
        message,
        onProgress: (event) => sendEvent(event.type, event),
      });
      if (directResult) {
        sendEvent('phase', { message: '命中直接执行路由...' });
        if (directResult.direct_intent?.type === 'enqueue_crawl_tasks') {
          sendEvent('trace', {
            message: `使用 controller /enqueue 创建后台任务，批次 ${directResult.direct_intent.batch_id}`,
            category: 'action',
            file: 'controller/ai-handler.js -> controller /enqueue',
          });
        }
        if (directResult.direct_intent?.type === 'local_recommend_and_collect') {
          sendEvent('trace', {
            message: '使用数据库内推荐链路，不触发网站并行抓取',
            category: 'action',
            file: 'controller/services/job-recommender.js',
          });
        }
        sendEvent('done', {
          success: true,
          reply: sanitizeReply(directResult.reply),
          suggestions: directResult.suggestions,
          resume_updated: false,
          resume_updated_content_md: '',
          memory_updated: false,
          memory_update_reason: '',
          tool_trace: directResult.tool_trace,
          direct_intent: directResult.direct_intent,
        });
        res.end();
        return;
      }

      const bootstrapContext = readAIBootstrapContext();
      const systemPrompt = buildAssistantSystemPrompt({ bootstrapContext, currentJobId });

      // Auto-preread context
      let prereadContext = '';
      if (resume && resume.content_md) {
        prereadContext += `\n\n## 当前简历内容（已预读，无需调用 read_resume）\n\`\`\`markdown\n${resume.content_md}\n\`\`\`\n`;
      }
      if (currentJobId) {
        try {
          const jobRow = db.prepare('SELECT title, company, description FROM scraped_jobs WHERE id = ?').get(currentJobId);
          if (jobRow) {
            prereadContext += `\n\n## 当前岗位信息（已预读，无需调用 read_current_job）\n- 岗位: ${jobRow.title}\n- 公司: ${jobRow.company}\n- 描述: ${(jobRow.description || '').slice(0, 1000)}\n`;
          }
        } catch (e) { /* ignore */ }
      }

      const fullSystemPrompt = systemPrompt + prereadContext;
      const conversationHistory = normalizeAssistantHistory(body.conversation_history);

      sendEvent('phase', { message: '正在思考...' });
      sendEvent('trace', {
        message: '进入标准 assistant loop，开始判断是否需要工具调用。',
        category: 'route',
        file: 'controller/ai-handler.js',
      });

      const assistantResult = await runAssistantLoopWithProgress({
        llmClient,
        systemPrompt: fullSystemPrompt,
        conversationHistory,
        userMessage: message,
        db,
        currentJobId,
        resume,
        onProgress: (event) => sendEvent(event.type, event),
      });

      const memoryResult = buildMemoryUpdateResult({
        memory_update: assistantResult.memory_update,
      });

      // 记录简历编辑版本
      if (assistantResult.resume_updated && typeof resumeDb.createResumeVersion === 'function') {
        try {
          resumeDb.createResumeVersion({
            resumeId: resume?.id || 1,
            oldContentMd: resume?.content_md || '',
            newContentMd: assistantResult.resume_updated_content_md || '',
            ops: assistantResult.resume_ops || null,
            changeSummary: assistantResult.resume_change_summary || null,
          });
        } catch (vErr) {
          console.warn('[AIAssistant] 版本记录失败:', vErr.message);
        }
      }

      sendEvent('done', {
        success: true,
        reply: sanitizeReply(assistantResult.reply),
        suggestions: assistantResult.suggestions || [],
        resume_updated: assistantResult.resume_updated,
        resume_updated_content_md: assistantResult.resume_updated_content_md || '',
        resume_ops: assistantResult.resume_ops || null,
        resume_change_summary: assistantResult.resume_change_summary || null,
        memory_updated: memoryResult.updated,
        tool_trace: assistantResult.tool_trace || [],
      });

      res.end();
    } catch (err) {
      console.error('[AIAssistant:Stream] 处理失败:', err.message);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      } catch (e) { /* ignore */ }
      res.end();
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
        // 默认获取所有已加入工作台卡片区的岗位
        jobs = db.prepare(
          'SELECT id, title, company, raw_payload FROM scraped_jobs WHERE is_favorite = 1'
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
  handleAssistantChatStream,
  handleJobMatch,
  handleDeepThink,
  handleSaveDeepThinkConfig,
  handleSaveSecondaryModel,
  handleDeleteSecondaryModel,
  handleKeywordScore,
  handleGetCapabilities,
  handleGetDeepThinkConfig
};
