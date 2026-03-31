/**
 * resume-pipeline.js - 简历处理管线
 *
 * 接收已解析的 Markdown 简历内容，生成三个产出物：
 * 1. resume.md       - 带 YAML front-matter 的标准化 Markdown
 * 2. resume.meta.json - 结构化元数据（姓名、联系方式、技能等）
 * 3. conversion_report.json - 工具链、降级信息、丢失内容统计
 */

const fs = require('fs');
const path = require('path');

const RESUMES_DIR = path.join(__dirname, '../../data/resumes');

/**
 * 从 Markdown 内容中提取结构化元数据
 */
function extractMetadata(markdown) {
  const meta = {
    name: '', phone: '', email: '', school: '', major: '',
    skills: [], experience: [], education: [], links: [], keywords: []
  };

  // Extract name (first line or ## header)
  const nameMatch = markdown.match(/^#?\s*(.+?)$/m);
  if (nameMatch) meta.name = nameMatch[1].trim();

  // Extract phone
  const phoneMatch = markdown.match(/(?:电话|联系电话|手机|Tel|Phone)[：:]\s*(\d[\d\s-]+)/i);
  if (phoneMatch) meta.phone = phoneMatch[1].trim();

  // Extract email
  const emailMatch = markdown.match(/(?:邮箱|电子邮件|Email|E-mail)[：:]\s*([\w.+-]+@[\w.-]+)/i);
  if (emailMatch) meta.email = emailMatch[1].trim();

  // Extract school
  const schoolMatch = markdown.match(/(?:学校|院校|毕业院校)[：:]\s*(.+?)(?:\s|$)/);
  if (schoolMatch) meta.school = schoolMatch[1].trim();

  // Extract major
  const majorMatch = markdown.match(/(?:专业|主修)[：:]\s*(.+?)(?:\s|$)/);
  if (majorMatch) meta.major = majorMatch[1].trim();

  // Extract links (URLs in the content)
  const linkPattern = /https?:\/\/[^\s)>\]]+/g;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(markdown)) !== null) {
    meta.links.push(linkMatch[0]);
  }

  // Extract keywords from skill/expertise sections
  const keywordPatterns = [
    /(?:技能|专长|技术)[：:](.+)/g,
    /(?:关键词)[：:](.+)/g,
  ];
  for (const pattern of keywordPatterns) {
    let match;
    while ((match = pattern.exec(markdown)) !== null) {
      meta.keywords.push(...match[1].split(/[,，、;；\s]+/).filter(Boolean));
    }
  }

  return meta;
}

/**
 * 根据元数据生成 YAML front-matter
 */
function generateYAMLFrontMatter(meta) {
  const lines = ['---'];
  if (meta.name) lines.push(`name: "${meta.name}"`);
  if (meta.phone) lines.push(`phone: "${meta.phone}"`);
  if (meta.email) lines.push(`email: "${meta.email}"`);
  if (meta.school) lines.push(`school: "${meta.school}"`);
  if (meta.major) lines.push(`major: "${meta.major}"`);
  if (meta.keywords.length) lines.push(`keywords: [${meta.keywords.map(k => `"${k}"`).join(', ')}]`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * 处理简历：生成标准化 Markdown、元数据 JSON、转换报告
 *
 * @param {string} contentMd - 已解析的 Markdown 文本
 * @param {Object} [options]
 * @param {string} [options.resumeId] - 简历 ID（默认自动生成）
 * @param {string} [options.inputFormat] - 原始输入格式
 * @returns {Promise<{ resumeId, resumeDir, resumeMd, resumeMeta, conversionReport }>}
 */
async function processResume(contentMd, options = {}) {
  const resumeId = options.resumeId || `resume_${Date.now()}`;
  const resumeDir = path.join(RESUMES_DIR, String(resumeId));

  if (!fs.existsSync(resumeDir)) {
    fs.mkdirSync(resumeDir, { recursive: true });
  }

  // 1. Extract metadata
  const meta = extractMetadata(contentMd);

  // 2. Generate normalized markdown with front-matter
  const frontMatter = generateYAMLFrontMatter(meta);
  const normalizedMd = `${frontMatter}\n\n${contentMd}`;

  // 3. Create conversion report
  const conversionReport = {
    tool_chain: ['resume-parser', 'resume-pipeline'],
    input_format: options.inputFormat || 'unknown',
    output_format: 'markdown',
    processed_at: new Date().toISOString(),
    degradations: [],
    lost_content: [],
    stats: {
      input_chars: contentMd.length,
      output_chars: normalizedMd.length,
      metadata_fields_extracted: Object.keys(meta).filter(k => {
        const v = meta[k];
        return Array.isArray(v) ? v.length > 0 : !!v;
      }).length
    }
  };

  // 4. Save artifacts
  const mdPath = path.join(resumeDir, 'resume.md');
  const metaPath = path.join(resumeDir, 'resume.meta.json');
  const reportPath = path.join(resumeDir, 'conversion_report.json');

  fs.writeFileSync(mdPath, normalizedMd, 'utf-8');
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(reportPath, JSON.stringify(conversionReport, null, 2), 'utf-8');

  return {
    resumeId,
    resumeDir,
    resumeMd: normalizedMd,
    resumeMeta: meta,
    conversionReport,
    paths: { mdPath, metaPath, reportPath }
  };
}

module.exports = { processResume, extractMetadata };
