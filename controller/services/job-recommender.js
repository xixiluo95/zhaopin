/**
 * job-recommender.js - AI 智能岗位推荐引擎
 *
 * 核心流程：
 * 1. LLM 解析用户自然语言要求 → 结构化条件
 * 2. LLM 从简历提取候选人画像
 * 3. 从 DB 获取所有岗位
 * 4. 硬过滤（纯代码）
 * 5. LLM 批量打分排序
 * 6. 返回 topN 推荐结果
 */

/**
 * 学历等级映射表，用于学历过滤的数值比较
 */
const EDUCATION_RANK = {
  '高中': 1,
  '中专/中技': 1,
  '大专': 2,
  '本科': 3,
  '硕士': 4,
  '博士': 5,
};

/**
 * 归一化学历文本为标准等级名称
 * 用于岗位学历字段与用户要求的统一比较
 * 无法识别/不限 → 返回 null，保留给 LLM 判断
 */
function normalizeEducation(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/不限|无/.test(s)) return null;
  if (/博士/.test(s)) return '博士';
  if (/硕士|研究生/.test(s)) return '硕士';
  if (/本科|学士|大学本科/.test(s)) return '本科';
  if (/大专|专科|高职/.test(s)) return '大专';
  if (/中专|中技|技校|职高/.test(s)) return '中专/中技';
  if (/高中/.test(s)) return '高中';
  return null;
}

/**
 * 安全解析 raw_payload 字段（不同于 safeParseLLMJson，专用于 DB payload）
 */
function safeParsePayload(rawPayload) {
  try {
    if (!rawPayload) return {};
    return typeof rawPayload === 'string' ? JSON.parse(rawPayload) : (rawPayload || {});
  } catch {
    return {};
  }
}

const OUTSOURCING_KEYWORDS = [
  '外包', '派遣', '驻场', '外派', '人力资源', '外协', '劳务',
  '人力外包', '项目外派', '服务外包', '技术外包', '乙方',
  '猎头', '人才服务', '人事代理', '劳务派遣', '人力服务',
  '信息技术服务', '软件外包', '项目外包', '资源外包'
];

// 原值 6，适度增大单批规模以减少总批次数；如模型稳定性下降可回退。
const SCORE_BATCH_SIZE = 10;
// 原值 2，增加并行 worker 缩短总耗时；保持保守并发避免过度限流。
const SCORE_PARALLELISM = 3;

/**
 * 安全解析 LLM 返回的 JSON（容错处理 ```json ``` 包裹）
 */
function safeParseLLMJson(text) {
  let cleaned = String(text || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

/**
 * 薪资解析
 * "15-25K" → {min:15000, max:25000}
 * "20-35K·13薪" → {min:20000, max:35000, months:13}
 * "面议" → null
 */
function parseSalary(salaryStr) {
  if (!salaryStr || typeof salaryStr !== 'string') return null;
  const s = salaryStr.trim();
  if (s === '面议' || s === '薪资面议') return null;

  // 匹配 "15-25K" 或 "15-25k" 或 "15K-25K"
  const rangeMatch = s.match(/(\d+(?:\.\d+)?)\s*[kK]?\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[kK]/i);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]) * 1000;
    const max = parseFloat(rangeMatch[2]) * 1000;
    const monthMatch = s.match(/(\d+)\s*薪/);
    const result = { min, max };
    if (monthMatch) result.months = parseInt(monthMatch[1], 10);
    return result;
  }

  // 匹配单一数字 "20K"
  const singleMatch = s.match(/(\d+(?:\.\d+)?)\s*[kK]/i);
  if (singleMatch) {
    const val = parseFloat(singleMatch[1]) * 1000;
    return { min: val, max: val };
  }

  return null;
}

/**
 * 从 raw_payload 提取岗位描述
 */
function extractDescription(job) {
  try {
    const payload = typeof job.raw_payload === 'string'
      ? JSON.parse(job.raw_payload)
      : (job.raw_payload || {});
    return payload.jobDesc || payload.description || payload['岗位描述'] || '';
  } catch {
    return '';
  }
}

function parseExperienceYears(experienceStr) {
  const text = String(experienceStr || '').trim();
  if (!text) return null;
  if (/应届|在校生?|实习|经验不限|无需经验/.test(text)) return { min: 0, max: 0 };

  const rangeMatch = text.match(/(\d+)\s*[-~至到]\s*(\d+)\s*年/);
  if (rangeMatch) {
    return {
      min: Number(rangeMatch[1]),
      max: Number(rangeMatch[2]),
    };
  }

  const belowMatch = text.match(/(\d+)\s*年(?:以下|以内|及以下)/);
  if (belowMatch) {
    return {
      min: 0,
      max: Number(belowMatch[1]),
    };
  }

  const aboveMatch = text.match(/(\d+)\s*年(?:以上|起|及以上)/);
  if (aboveMatch) {
    return {
      min: Number(aboveMatch[1]),
      max: null,
    };
  }

  const singleMatch = text.match(/(\d+)\s*年/);
  if (singleMatch) {
    const years = Number(singleMatch[1]);
    return { min: years, max: years };
  }

  return null;
}

/**
 * 标题切块法解析岗位描述为结构化字段（保守策略）
 * 只有出现明确标题时才拆段，正文零散的"优先"不动
 */
function parseJobDescription(desc) {
  if (!desc) return { responsibilities: '', requirements: '', bonus: '', raw: '' };

  // 定义标题模式（优先级从高到低）
  const SECTION_HEADERS = [
    { pattern: /(?:^|\n)\s*(?:【)?(?:加分项|优先考虑|优先条件)(?:】)?\s*[:：]?\s*\n?/i, target: 'bonus' },
    { pattern: /(?:^|\n)\s*(?:【)?(?:任职要求|岗位要求|任职资格|职位要求|要求)(?:】)?\s*[:：]?\s*\n?/i, target: 'requirements' },
    { pattern: /(?:^|\n)\s*(?:【)?(?:岗位职责|工作内容|工作职责|核心职责|职位职责|职责)(?:】)?\s*[:：]?\s*\n?/i, target: 'responsibilities' },
  ];

  // 找到所有标题位置
  const matches = [];
  for (const header of SECTION_HEADERS) {
    const m = desc.match(header.pattern);
    if (m) {
      matches.push({
        index: m.index + m[0].length, // 内容起始位置
        target: header.target,
        headerLength: m[0].length,
      });
    }
  }

  // 无任何标题匹配 → 首段默认归入 responsibilities
  if (matches.length === 0) {
    return { responsibilities: '', requirements: '', bonus: '', raw: desc };
  }

  // 按出现位置排序
  matches.sort((a, b) => a.index - b.index);

  const result = { responsibilities: '', requirements: '', bonus: '', raw: desc };

  // 按位置切段并映射
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index - matches[i + 1].headerLength : desc.length;
    const content = desc.slice(start, end).trim();
    result[matches[i].target] = content;
  }

  return result;
}

/**
 * 构建结构化岗位卡片 JSON
 */
function buildJobCard(job) {
  const payload = safeParsePayload(job.raw_payload);
  const desc = payload.description || payload.jobDesc || '';
  const parsed = parseJobDescription(desc);

  return {
    id: job.id,
    title: job.title,
    company: job.company,
    location: job.location,
    salary: job.salary,
    experience: job.experience,
    education: job.education,
    platform: job.platform,
    url: payload.url || job.url,
    industry: payload.brandIndustry || '',
    companyScale: payload.brandScaleName || '',
    fundingStage: payload.brandStageName || '',
    hardRequirements: payload.hardRequirements || '',
    bossTitle: payload.bossTitle || '',
    responsibilities: parsed.responsibilities,
    requirements: parsed.requirements,
    bonus: parsed.bonus,
    description_excerpt: desc.slice(0, 300),
    is_favorite: job.is_favorite,
  };
}

function isOutsourcing(job) {
  const matchedKeywords = [];
  const targets = [
    job.company || '',
    job.title || '',
    extractDescription(job),
  ];
  const combined = targets.join(' ');
  for (const kw of OUTSOURCING_KEYWORDS) {
    if (combined.includes(kw)) {
      matchedKeywords.push(kw);
    }
  }
  return {
    isOutsourcing: matchedKeywords.length > 0,
    matchedKeywords,
  };
}

/**
 * 硬过滤（纯代码，不依赖 LLM）
 * @param {Array} jobs - 岗位列表
 * @param {Object} filters - 过滤条件
 * @returns {{passed: Array, excluded: Array<{job: Object, reason: string}>}}
 */
function hardFilter(jobs, filters) {
  const {
    min_salary = null,
    max_salary = null,
    exclude_outsourcing = false,
    locations = [],
    exclude_keywords = [],
    include_keywords = [],
    max_experience_years = null,
    min_education = null,
    min_experience_years = null,
  } = filters || {};

  const passed = [];
  const excluded = [];

  for (const job of jobs) {
    let excluded_reason = null;

    // 1. 外包检测
    if (exclude_outsourcing) {
      const outsourcing = isOutsourcing(job);
      if (outsourcing.isOutsourcing) {
        excluded_reason = `外包岗位 (匹配: ${outsourcing.matchedKeywords.join(', ')})`;
      }
    }

    // 2. 薪资范围检查
    if (!excluded_reason && (min_salary || max_salary)) {
      const salary = parseSalary(job.salary);
      if (salary) {
        if (min_salary && salary.max < min_salary) {
          excluded_reason = `薪资上限 ${salary.max} 低于最低要求 ${min_salary}`;
        }
        if (!excluded_reason && max_salary && salary.min > max_salary) {
          excluded_reason = `薪资下限 ${salary.min} 高于最高要求 ${max_salary}`;
        }
      }
      // 薪资面议的不在此过滤，保留给 LLM 评判
    }

    // 3. 地点匹配
    if (!excluded_reason && locations.length > 0) {
      const jobLocation = (job.location || '').toLowerCase();
      const matched = locations.some(loc =>
        jobLocation.includes(loc.toLowerCase())
      );
      if (!matched) {
        excluded_reason = `地点不匹配 (要求: ${locations.join('/')}, 岗位: ${job.location || '未知'})`;
      }
    }

    // 4. 排除关键词
    if (!excluded_reason && exclude_keywords.length > 0) {
      const combined = `${job.title || ''} ${job.company || ''} ${job.keywords || ''}`.toLowerCase();
      for (const kw of exclude_keywords) {
        if (combined.includes(kw.toLowerCase())) {
          excluded_reason = `包含排除关键词: ${kw}`;
          break;
        }
      }
    }

    // 5. 包含关键词（如有要求，至少匹配一个）
    if (!excluded_reason && include_keywords.length > 0) {
      const combined = `${job.title || ''} ${job.company || ''} ${job.keywords || ''} ${extractDescription(job)}`.toLowerCase();
      const matched = include_keywords.some(kw =>
        combined.includes(kw.toLowerCase())
      );
      if (!matched) {
        excluded_reason = `未包含任何要求关键词: ${include_keywords.join(', ')}`;
      }
    }

    // 6. 经验要求（上限检查）
    if (!excluded_reason && max_experience_years !== null && max_experience_years !== undefined) {
      const parsedExperience = parseExperienceYears(job.experience);
      if (parsedExperience && parsedExperience.min !== null && parsedExperience.min > max_experience_years) {
        excluded_reason = `经验要求过高 (岗位: ${job.experience || '未知'}, 允许: ${max_experience_years}年以下)`;
      }
    }

    // 7. 最低学历过滤（保守：只排除明确低于要求的）
    if (!excluded_reason && min_education) {
      const jobEdu = normalizeEducation(job.education);
      if (jobEdu) {
        const jobRank = EDUCATION_RANK[jobEdu] || 0;
        const minRank = EDUCATION_RANK[min_education] || 0;
        if (jobRank > 0 && jobRank < minRank) {
          excluded_reason = `学历不满足 (岗位: ${job.education}, 最低要求: ${min_education})`;
        }
      }
      // jobEdu 为 null（无法识别/不限/空值）→ 保留给 LLM，不硬杀
    }

    // 8. 最低经验年限过滤（保守：只排除明确低于要求的）
    if (!excluded_reason && min_experience_years !== null && min_experience_years !== undefined) {
      const parsedExperience = parseExperienceYears(job.experience);
      if (parsedExperience && parsedExperience.max !== null && parsedExperience.max < min_experience_years) {
        excluded_reason = `经验不满足 (岗位: ${job.experience || '未知'}, 最低要求: ${min_experience_years}年)`;
      }
      // 无法解析 → 保留给 LLM
    }

    if (excluded_reason) {
      excluded.push({ job, reason: excluded_reason });
    } else {
      passed.push(job);
    }
  }

  return { passed, excluded };
}

/**
 * 用 LLM 解析用户自然语言要求为结构化条件
 */
async function parseRequirements(llmClient, userPrompt) {
  const systemPrompt = '你是一个需求解析器。将用户的求职筛选要求转为JSON。';
  const prompt = `用户说: "${userPrompt}"
返回格式(只返回JSON,不要其他文字):
{
  "min_salary": 数字或null,
  "max_salary": 数字或null,
  "max_experience_years": 数字或null,
  "min_education": "大专"|"本科"|"硕士"|"博士"|null,
  "min_experience_years": 数字或null,
  "max_experience_years": 数字或null,
  "exclude_outsourcing": true或false,
  "locations": ["城市名"] 或 [],
  "exclude_keywords": ["关键词"],
  "include_keywords": ["关键词"],
  "role_types": ["岗位方向"],
  "experience_range": "经验要求" 或 null,
  "other_preferences": ["其他偏好描述"]
}
注意:
- min_salary和max_salary的单位是元(月薪)。例如用户说"20k以上",则min_salary=20000。
- 如果用户说"2年以下/2年以内/毕业两年内"，则 max_experience_years=2。
- 如果用户说"本科及以上"，则 min_education="本科"。
- 如果用户说"1-3年"，则 min_experience_years=1, max_experience_years=3。
- "经验不限"时 min_experience_years 和 max_experience_years 都为 null。`;

  const response = await llmClient.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);
  return safeParseLLMJson(response.content);
}

/**
 * 用 LLM 从简历提取候选人画像
 */
async function extractResumeProfile(llmClient, resumeMd) {
  const systemPrompt = '你是一个简历分析专家。';
  const prompt = `分析以下简历,提取候选人画像。只返回JSON:
${resumeMd}
返回:
{
  "name": "姓名",
  "target_roles": ["目标方向"],
  "skills": ["技能列表"],
  "experience_years": 数字,
  "industries": ["行业经验"],
  "strengths": ["核心优势,最多3个"],
  "education": "最高学历"
}`;

  const response = await llmClient.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);
  return safeParseLLMJson(response.content);
}

/**
 * LLM 批量打分（每批 5-8 个岗位）
 */
async function batchScore(llmClient, profile, preferences, jobsBatch) {
  const jobList = jobsBatch.map((j, i) => {
    const card = buildJobCard(j);
    const reqText = card.requirements || card.description_excerpt;
    const fullDesc = extractDescription(j);
    return `${i + 1}. [ID:${j.id}] ${j.title} - ${j.company}
   薪资: ${j.salary || '面议'} | 经验: ${j.experience || '不限'} | 学历: ${j.education || '不限'}
   任职要求: ${reqText || '无'}
   加分项: ${card.bonus || '无'}
   技能标签: ${card.hardRequirements || '无'}
   完整描述(兜底): ${fullDesc.slice(0, 200)}`;
  }).join('\n');

  const systemPrompt = `你是岗位匹配专家。根据候选人画像为岗位打分(0-100)。只返回JSON。
评分时优先看任职要求，其次看加分项，技能标签仅作辅助线索。
若任职要求为空，参考完整描述。`;
  const prompt = `候选人画像:
${JSON.stringify(profile)}

用户偏好:
${JSON.stringify(preferences)}

岗位列表:
${jobList}

只返回JSON数组(不要其他文字):
[{"id": 数字, "score": 0-100, "reasons": ["匹配原因1","原因2"]}]

评分标准:
- 技能匹配(35%): 候选人技能是否与岗位要求吻合
- 方向匹配(25%): 岗位方向是否与候选人目标一致
- 经验匹配(20%): 经验年限是否满足
- 综合适配(20%): 行业经验、公司质量、发展前景`;

  const response = await llmClient.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ]);
  return safeParseLLMJson(response.content);
}

async function scoreCandidatesWithParallelBatches({
  llmClient,
  profile,
  preferences,
  candidates,
  batchSize = SCORE_BATCH_SIZE,
  parallelism = SCORE_PARALLELISM,
  onProgress = null,
}) {
  const batches = [];
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize));
  }

  const scoredJobs = [];
  let cursor = 0;
  let completedBatches = 0;
  const totalBatches = batches.length;

  async function worker() {
    while (cursor < batches.length) {
      const currentIndex = cursor;
      cursor += 1;
      const batch = batches[currentIndex];

      try {
        const scores = await batchScore(llmClient, profile, preferences, batch);
        if (!Array.isArray(scores)) continue;

        for (const scoreItem of scores) {
          const matchedJob = batch.find((job) => job.id === scoreItem.id);
          if (!matchedJob) continue;
          scoredJobs.push({
            ...matchedJob,
            score: Math.max(0, Math.min(100, scoreItem.score || 0)),
            reasons: Array.isArray(scoreItem.reasons) ? scoreItem.reasons : [],
          });
        }
      } catch (err) {
        console.error(`[job-recommender] 批量打分失败 (batch ${currentIndex + 1}):`, err.message);
        onProgress?.({
          type: 'trace',
          message: `第 ${currentIndex + 1} 批评分失败，已跳过并继续`,
          category: 'warning',
          tool: 'smart_job_recommend',
        });
      } finally {
        completedBatches += 1;
        onProgress?.({
          type: 'trace',
          message: `评分进度：${completedBatches}/${totalBatches} 批次 (${Math.round((completedBatches / totalBatches) * 100)}%)`,
          category: 'progress',
          tool: 'smart_job_recommend',
        });
      }

      await sleep(150);
    }
  }

  const workerCount = Math.max(1, Math.min(parallelism, batches.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return scoredJobs;
}

/**
 * 延时函数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 主推荐函数
 * @param {Object} params
 * @param {string} params.userPrompt - 用户自然语言要求
 * @param {string} params.resumeMd - 简历 Markdown
 * @param {Object} params.db - better-sqlite3 数据库实例
 * @param {Object} params.llmClient - LLM 客户端
 * @param {number} [params.topN=20] - 返回前N个
 * @returns {Promise<Object>} 推荐结果
 */
async function recommendJobs({
  userPrompt,
  resumeMd,
  db,
  llmClient,
  topN = 20,
  candidateJobs = null,
  onProgress = null,
}) {
  // 步骤1: 解析用户要求为结构化条件
  let requirements;
  onProgress?.({
    type: 'phase',
    message: '正在解析筛选条件...',
  });
  try {
    requirements = await parseRequirements(llmClient, userPrompt);
  } catch (err) {
    throw new Error(`解析用户要求失败: ${err.message}`);
  }

  // 步骤2: 从简历提取候选人画像
  let profile;
  onProgress?.({
    type: 'phase',
    message: '正在分析简历画像...',
  });
  try {
    profile = await extractResumeProfile(llmClient, resumeMd);
  } catch (err) {
    throw new Error(`提取简历画像失败: ${err.message}`);
  }

  // 步骤3: 从 DB 获取所有岗位
  onProgress?.({
    type: 'trace',
    message: '正在从数据库读取岗位...',
    category: 'action',
    tool: 'smart_job_recommend',
  });
  const allJobs = Array.isArray(candidateJobs)
    ? candidateJobs
    : db.prepare(`
      SELECT id, title, company, location, salary, experience, education, keywords, raw_payload, platform
      FROM scraped_jobs
      ORDER BY id DESC
    `).all();

  if (allJobs.length === 0) {
    return {
      success: true,
      summary: {
        total_scanned: 0,
        after_hard_filter: 0,
        recommended: 0,
        filters_applied: requirements,
        resume_profile: profile,
      },
      jobs: [],
    };
  }

  // 步骤4: 硬过滤
  const filterResult = hardFilter(allJobs, {
    min_salary: requirements.min_salary || null,
    max_salary: requirements.max_salary || null,
    exclude_outsourcing: requirements.exclude_outsourcing || false,
    locations: requirements.locations || [],
    exclude_keywords: requirements.exclude_keywords || [],
    include_keywords: requirements.include_keywords || [],
    max_experience_years: requirements.max_experience_years ?? null,
    min_education: requirements.min_education || null,
    min_experience_years: requirements.min_experience_years ?? null,
  });

  const candidates = filterResult.passed;
  onProgress?.({
    type: 'trace',
    message: `硬过滤完成：${allJobs.length} → ${candidates.length} 条`,
    category: 'result',
    tool: 'smart_job_recommend',
  });

  if (candidates.length === 0) {
    return {
      success: true,
      summary: {
        total_scanned: allJobs.length,
        after_hard_filter: 0,
        recommended: 0,
        filters_applied: {
          min_salary: requirements.min_salary,
          max_salary: requirements.max_salary,
          max_experience_years: requirements.max_experience_years,
          min_education: requirements.min_education,
          min_experience_years: requirements.min_experience_years,
          exclude_outsourcing: requirements.exclude_outsourcing,
          locations: requirements.locations,
        },
        resume_profile: {
          name: profile.name,
          target_roles: profile.target_roles,
          skills: profile.skills,
        },
      },
      jobs: [],
    };
  }

  // 步骤5: LLM 批量打分（每批 5-8 个）
  const preferences = {
    role_types: requirements.role_types || [],
    experience_range: requirements.experience_range,
    other_preferences: requirements.other_preferences || [],
  };
  onProgress?.({
    type: 'phase',
    message: '正在评分匹配岗位...',
  });
  const scoredJobs = await scoreCandidatesWithParallelBatches({
    llmClient,
    profile,
    preferences,
    candidates,
    onProgress,
  });

  // 步骤6: 排序并返回 topN
  scoredJobs.sort((a, b) => b.score - a.score);
  const topJobs = scoredJobs.slice(0, topN);

  const outputJobs = topJobs.map(j => {
    const card = buildJobCard(j);
    return {
      ...card,
      score: j.score,
      reasons: j.reasons,
      keywords: j.keywords || '',
    };
  });

  return {
    success: true,
    summary: {
      total_scanned: allJobs.length,
      after_hard_filter: candidates.length,
      recommended: topJobs.length,
      filters_applied: {
        min_salary: requirements.min_salary,
        max_salary: requirements.max_salary,
        max_experience_years: requirements.max_experience_years,
        min_education: requirements.min_education,
        min_experience_years: requirements.min_experience_years,
        exclude_outsourcing: requirements.exclude_outsourcing,
        locations: requirements.locations,
      },
      resume_profile: {
        name: profile.name,
        target_roles: profile.target_roles,
        skills: profile.skills,
      },
      jobs_with_requirements: outputJobs.filter(j => j.requirements).length,
      jobs_with_bonus: outputJobs.filter(j => j.bonus).length,
      jobs_with_structured_description: outputJobs.filter(j => j.requirements || j.responsibilities).length,
    },
    jobs: outputJobs,
  };
}

module.exports = {
  OUTSOURCING_KEYWORDS,
  EDUCATION_RANK,
  parseSalary,
  normalizeEducation,
  isOutsourcing,
  hardFilter,
  extractDescription,
  parseExperienceYears,
  parseJobDescription,
  buildJobCard,
  safeParsePayload,
  safeParseLLMJson,
  recommendJobs,
};
