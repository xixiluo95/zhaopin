/**
 * keyword-score-tool.js - 关键词匹配打分工具
 *
 * 输入: 岗位关键词列表 + 简历关键词列表
 * 输出: 0-100 分及分项得分明细
 */

function normalizeKeyword(kw) {
  return String(kw).toLowerCase().replace(/\s+/g, '').replace(/[（(）)]/g, '');
}

function calculateKeywordScore(jobKeywords, resumeKeywords) {
  if (!jobKeywords || !jobKeywords.length) {
    return { total_score: 0, detail: { error: '无岗位关键词' } };
  }

  const normalizedJob = jobKeywords.map(normalizeKeyword).filter(Boolean);
  const normalizedResume = resumeKeywords.map(normalizeKeyword).filter(Boolean);

  if (!normalizedJob.length) {
    return { total_score: 0, detail: { error: '岗位关键词为空' } };
  }

  const matched = [];
  const missing = [];
  const partial = [];

  for (const jk of normalizedJob) {
    const exactMatch = normalizedResume.some(rk => rk === jk || rk.includes(jk) || jk.includes(rk));
    if (exactMatch) {
      matched.push(jk);
    } else {
      // Check partial matches (at least 2 common characters for Chinese)
      const partialMatch = normalizedResume.some(rk => {
        const common = [...jk].filter(ch => rk.includes(ch));
        return common.length >= Math.min(2, jk.length * 0.5);
      });
      if (partialMatch) {
        partial.push(jk);
      } else {
        missing.push(jk);
      }
    }
  }

  const exactScore = (matched.length / normalizedJob.length) * 70;
  const partialScore = (partial.length / normalizedJob.length) * 20;
  const coverageBonus = normalizedResume.length >= normalizedJob.length ? 10 :
    (normalizedResume.length / normalizedJob.length) * 10;

  const totalScore = Math.round(Math.min(100, exactScore + partialScore + coverageBonus));

  return {
    total_score: totalScore,
    detail: {
      job_keywords_count: normalizedJob.length,
      resume_keywords_count: normalizedResume.length,
      matched: matched,
      partial_match: partial,
      missing: missing,
      exact_match_rate: matched.length / normalizedJob.length,
      breakdown: {
        exact_match_score: Math.round(exactScore),
        partial_match_score: Math.round(partialScore),
        coverage_bonus: Math.round(coverageBonus)
      }
    }
  };
}

function extractKeywordsFromText(text) {
  const keywords = new Set();

  // Extract from common patterns
  const patterns = [
    /(?:技能|技术|专长|擅长)[：:]\s*(.+?)(?:\n|$)/g,
    /(?:关键词)[：:]\s*(.+?)(?:\n|$)/g,
    /(?:要求|任职要求|岗位要求)[：:]\s*(.+?)(?:\n|$)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      match[1].split(/[,，、;；\s\/\\|]+/).forEach(kw => {
        const trimmed = kw.trim();
        if (trimmed.length >= 2 && trimmed.length <= 20) {
          keywords.add(trimmed);
        }
      });
    }
  }

  // Extract common technical terms
  const techTerms = [
    'javascript', 'python', 'java', 'react', 'vue', 'angular', 'node',
    'typescript', 'go', 'rust', 'sql', 'mysql', 'postgresql', 'mongodb',
    'docker', 'kubernetes', 'aws', 'linux', 'git',
    '产品经理', '项目管理', '数据分析', '机器学习', '深度学习',
    '前端', '后端', '全栈', '运维', '测试', 'UI设计', 'UX',
  ];

  const lowerText = text.toLowerCase();
  for (const term of techTerms) {
    if (lowerText.includes(term.toLowerCase())) {
      keywords.add(term);
    }
  }

  return [...keywords];
}

module.exports = { calculateKeywordScore, extractKeywordsFromText, normalizeKeyword };
