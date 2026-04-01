const fs = require('fs');
const path = require('path');

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&thinsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return num > 0 && num < 65536 ? String.fromCharCode(num) : '';
    })
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) => {
      const num = Number.parseInt(hex, 16);
      return num > 0 && num < 65536 ? String.fromCharCode(num) : '';
    })
    .trim();
}
const {
  initDatabase,
  getCompanyProfileCacheByLookupFingerprint,
  getCompanyProfileCacheByNormalizedName,
  upsertCompanyProfileCache,
  updateDeliveryPayloadCompanyFieldsByNormalizedName
} = require('./db');
const { initFeishuClient, listTargets, listRecords, updateRecord } = require('./feishu-client');
const { ensureSourceDecision, fetchCompanyProfile, buildLookupContext, inferCompanyTypeFromIndustry } = require('./company-profile-fetcher');

async function main() {
  initDatabase();
  initFeishuClient();

  const targetName = process.env.FEISHU_TARGET || (listTargets().find((item) => item.isDefault)?.name || null);
  if (!targetName) {
    throw new Error('No Feishu target configured');
  }

  await ensureSourceDecision();

  const maxRecords = Number(process.env.BACKFILL_MAX_RECORDS || 0);
  const highQualityOnly = process.env.BACKFILL_HIGH_QUALITY_ONLY === '1';
  const ignoreNotFoundCache = process.env.BACKFILL_IGNORE_NOT_FOUND_CACHE === '1';
  const forceReplace = process.env.BACKFILL_FORCE_REPLACE === '1';
  const autoApproveScore = Number(process.env.BACKFILL_AUTO_APPROVE_SCORE || 85);
  const reviewScore = Number(process.env.BACKFILL_REVIEW_SCORE || 60);
  const reviewOutputPath = process.env.BACKFILL_REVIEW_FILE
    || path.join(__dirname, 'data', 'company_backfill_review.json');
  const reviewJsonlPath = reviewOutputPath.replace(/\.json$/i, '.jsonl');
  const reviewPromptPath = reviewOutputPath.replace(/\.json$/i, '.prompt.md');
  let processed = 0;
  let updated = 0;
  let skippedLowQuality = 0;
  let syncedLocalQueue = 0;
  let reviewCount = 0;
  const reviewItems = [];
  ensureDirectory(path.dirname(reviewOutputPath));
  fs.writeFileSync(reviewJsonlPath, '');
  let pageToken = null;

  do {
    const page = await listRecords(targetName, { pageToken, pageSize: 100 });
    for (const item of page.items) {
      if (maxRecords > 0 && processed >= maxRecords) {
        pageToken = null;
        break;
      }

      processed += 1;
      const fields = item.fields || {};
      const lookupContext = buildLookupContext({
        companyNameRaw: fields['公司名称'],
        industry: fields['行业领域'],
        scale: fields['公司规模'],
        location: fields['工作地点']
      });
      const companyNameRaw = lookupContext.companyNameRaw;
      const companyNameNormalized = lookupContext.companyNameNormalized;
      if (!companyNameNormalized) {
        continue;
      }

      if (highQualityOnly && !isHighQualityCompanyCandidate(lookupContext)) {
        skippedLowQuality += 1;
        continue;
      }

      const currentType = cleanString(fields['公司类型']);
      const currentDescription = cleanString(fields['公司简介']);
      if (currentType || currentDescription) {
        syncedLocalQueue += updateDeliveryPayloadCompanyFieldsByNormalizedName(companyNameNormalized, {
          companyType: currentType,
          companyDescription: currentDescription
        });
      }

      // 已有内容保护：非 FORCE 模式下，已有非脏内容则跳过
      if (!forceReplace) {
        const descIsDirty = currentDescription && isDirtySearchSnippet(currentDescription);
        const descIsTooShort = currentDescription && currentDescription.length < 20;
        const descIsGood = currentDescription && !descIsDirty && !descIsTooShort;
        const typeIsGood = Boolean(currentType);
        // 有干净简介就跳过（不重抓）
        if (descIsGood && typeIsGood) {
          continue;
        }
        // 有干净简介（即使无类型），也跳过简介的重抓
        if (descIsGood) {
          // 仍然尝试补类型，但只补类型不碰简介
          if (typeIsGood) {
            continue;
          }
        }
      }

      let cache = getCompanyProfileCacheByLookupFingerprint(lookupContext.companyLookupFingerprint)
        || getCompanyProfileCacheByNormalizedName(companyNameNormalized);
      let evaluatedProfile = cache ? hydrateProfileForDecision(cache) : null;
      // 飞书中两列都空或只有类型缺简介时，忽略 partial 缓存重新抓取
      const bothEmptyInFeishu = !currentType && !currentDescription;
      const descMissingInFeishu = currentType && !currentDescription;
      const forceRefetch = (bothEmptyInFeishu || descMissingInFeishu) && (!cache || cache.status === 'partial' || cache.status === 'not_found');
      if (!cache || forceRefetch || !isReusableCache(cache, { ignoreNotFoundCache })) {
        const fetchResult = await fetchCompanyProfile(lookupContext);
        evaluatedProfile = fetchResult;
        if (fetchResult.status !== 'failed') {
          upsertCompanyProfileCache({
            companyNameRaw,
            companyNameNormalized,
            companyLookupFingerprint: lookupContext.companyLookupFingerprint,
            companyIdentifier: null,
            companyType: fetchResult.companyType || '',
            companyDescription: fetchResult.companyDescription || '',
            source: fetchResult.source || null,
            sourceUrl: fetchResult.sourceUrl || null,
            status: fetchResult.status,
            attemptCount: Number(cache?.attemptCount || 0) + 1,
            lastError: null,
            nextRetryAt: null,
            resolvedAt: fetchResult.status === 'not_found' ? null : new Date().toISOString()
          });
          cache = {
            ...fetchResult,
            companyType: fetchResult.companyType || '',
            companyDescription: fetchResult.companyDescription || ''
          };
        }
      }

      if (!cache || !evaluatedProfile) {
        continue;
      }

      // 脏内容前置拦截——在分类前直接 skip，避免污染 review 池
      // 同时检查原始文本和解码后文本（缓存中可能存有 HTML entity）
      const candidateDescriptionRaw = cleanString(cache.companyDescription) || cleanString(evaluatedProfile.companyDescription);
      const candidateDescriptionDecoded = decodeHtmlEntities(candidateDescriptionRaw);
      if (candidateDescriptionRaw && isDirtySearchSnippet(candidateDescriptionRaw)) {
        continue;
      }
      if (candidateDescriptionDecoded && isDirtySearchSnippet(candidateDescriptionDecoded)) {
        continue;
      }
      // HTML entity 残留本身就是脏内容标志
      if (candidateDescriptionRaw && /&ensp;|&emsp;|&#\d+;|&#[xX][0-9a-fA-F]+;/.test(candidateDescriptionRaw)) {
        continue;
      }

      const decision = classifyProfileDecision(evaluatedProfile, {
        autoApproveScore,
        reviewScore
      });
      if (decision === 'review') {
        const reviewItem = {
          recordId: item.record_id,
          companyName: companyNameNormalized,
          industry: lookupContext.industry,
          scale: lookupContext.scale,
          location: lookupContext.location,
          companyType: cleanString(cache.companyType),
          companyDescription: cleanString(cache.companyDescription),
          source: cache.source || evaluatedProfile.source || null,
          sourceUrl: cache.sourceUrl || evaluatedProfile.sourceUrl || null,
          confidenceScore: Number(evaluatedProfile.confidenceScore || 0),
          matchedName: evaluatedProfile.matchedName || '',
          reason: evaluatedProfile.reason || ''
        };
        reviewItems.push(reviewItem);
        fs.appendFileSync(reviewJsonlPath, `${JSON.stringify(reviewItem)}\n`);
        reviewCount += 1;
        continue;
      }
      if (decision !== 'auto') {
        // 即使整体不是 auto，如果缓存有有效类型且飞书缺类型，仍尝试补类型
        const cachedType = cleanString(cache.companyType) || cleanString(evaluatedProfile?.companyType);
        // 对 typeEmpty 和 bothEmpty 记录：从行业推断类型
        const inferredType = (!cachedType && !currentType)
          ? inferCompanyTypeFromIndustry(lookupContext.industry)
          : '';
        const finalType = cachedType || inferredType;
        if (!currentType && finalType) {
          const decodedDescription = decodeHtmlEntities(cache.companyDescription);
          const descIsDirty = decodedDescription && isDirtySearchSnippet(decodedDescription);
          if (!descIsDirty) {
            try {
              await updateRecord(targetName, item.record_id, { '公司类型': finalType });
              updated += 1;
              console.log(`[BackfillCompanyFields] Type-only updated record=${item.record_id} company=${companyNameNormalized} type=${finalType}`);
            } catch (e) {
              // 写入失败则跳过
            }
          }
        }
        continue;
      }

      const decodedDescription = decodeHtmlEntities(cache.companyDescription);
      const patch = {};
      // 补类型：无类型或 FORCE 模式才写入
      if ((forceReplace || !currentType) && cleanString(cache.companyType)) {
        patch['公司类型'] = cleanString(cache.companyType);
      }
      // 补简介：无简介 或 FORCE 模式 或 当前简介是脏内容/过短 才写入
      const currentDescIsDirty = currentDescription && isDirtySearchSnippet(currentDescription);
      const currentDescIsTooShort = currentDescription && currentDescription.length < 20;
      const shouldReplaceDesc = forceReplace || !currentDescription || currentDescIsDirty || currentDescIsTooShort;
      if (shouldReplaceDesc && cleanString(decodedDescription)) {
        // 写入前拦截脏内容
        if (isDirtySearchSnippet(decodedDescription)) {
          continue;
        }
        // 新内容也必须过短检查门槛
        if (decodedDescription.length < 20) {
          continue;
        }
        // 截断片段检测：以"天之前"、"天之后"等搜索残留开头
        if (/^(天之前|天之后|天\s*前|天\s*后)\s/u.test(decodedDescription)) {
          continue;
        }
        // 导航词列表检测：多个"解决方案"并列无业务实质
        if (/解决方案\s+解决方案/u.test(decodedDescription) && !/主要|提供|专注|从事/u.test(decodedDescription)) {
          continue;
        }
        // 非业务新闻稿检测：以"据天眼查"、"据企查查"开头
        if (/^据(天眼查|企查查|爱企查)/u.test(decodedDescription)) {
          continue;
        }
        patch['公司简介'] = decodedDescription;
      }

      if (Object.keys(patch).length === 0) {
        continue;
      }

      await updateRecord(targetName, item.record_id, patch);
      syncedLocalQueue += updateDeliveryPayloadCompanyFieldsByNormalizedName(companyNameNormalized, {
        companyType: patch['公司类型'] || '',
        companyDescription: patch['公司简介'] || ''
      });
      updated += 1;
      console.log(`[BackfillCompanyFields] Updated record=${item.record_id} company=${companyNameNormalized}`);
    }
    pageToken = page.hasMore ? page.pageToken : null;
  } while (pageToken);

  fs.writeFileSync(reviewOutputPath, JSON.stringify(reviewItems, null, 2));
  fs.writeFileSync(reviewPromptPath, buildReviewPrompt(reviewItems));
  console.log(`[BackfillCompanyFields] Done target=${targetName} processed=${processed} updated=${updated} reviewCount=${reviewCount} reviewFile=${reviewOutputPath} syncedLocalQueue=${syncedLocalQueue} skippedLowQuality=${skippedLowQuality} highQualityOnly=${highQualityOnly} ignoreNotFoundCache=${ignoreNotFoundCache} forceReplace=${forceReplace} autoApproveScore=${autoApproveScore} reviewScore=${reviewScore}`);
}

function cleanString(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isReusableCache(cache, options = {}) {
  const ignoreNotFoundCache = options.ignoreNotFoundCache === true;
  if (!cache || !cache.updatedAt) {
    return false;
  }

  // Historical known-site cache rows have been polluted before. Re-fetch these
  // every time so bad old mappings cannot keep propagating.
  if (cache.source === 'known_official_site') {
    return false;
  }

  const updatedAt = new Date(cache.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  const ageMs = Date.now() - updatedAt;
  if (cache.status === 'resolved' || cache.status === 'partial') {
    return ageMs <= 7 * 24 * 60 * 60 * 1000;
  }
  if (cache.status === 'not_found') {
    if (ignoreNotFoundCache) {
      return false;
    }
    return ageMs <= 24 * 60 * 60 * 1000;
  }
  return false;
}

function isHighQualityCompanyCandidate(lookupContext) {
  const name = cleanString(lookupContext.companyNameNormalized);
  if (!name) {
    return false;
  }
  if (/某|某知名|某中型|某大型|某小型/.test(name)) {
    return false;
  }
  if (/\.\.\.|…/.test(name)) {
    return false;
  }
  if (name.length <= 3) {
    return false;
  }

  const hasStrongSuffix = /(公司|集团|科技|信息|股份|教育|创新|能源|物流|电子|数字|智能|医疗|网络|传媒|器械|电气)$/u.test(name);
  const hasContext = Boolean(cleanString(lookupContext.industry) || cleanString(lookupContext.scale) || cleanString(lookupContext.location));

  return hasStrongSuffix || (name.length >= 4 && hasContext);
}

function classifyProfileDecision(profile, thresholds) {
  const confidenceScore = Number(profile?.confidenceScore || 0);
  const source = cleanString(profile?.source);
  const hasType = Boolean(cleanString(profile?.companyType));
  const hasDescription = Boolean(cleanString(profile?.companyDescription));
  const hasBusinessDescription = isBusinessStyleDescription(profile?.companyDescription);
  const isTrustedPublicSource = /^(known_official_site|baidu_baike_direct|public_search_bing|gsxt_search_bing|aiqicha_search_bing)$/u.test(source)
    && /(gsxt|公示系统|国家企业信用信息公示系统|baike|百度百科|qcc|企查查|aiqicha|爱企查|official|官网)/iu.test(
      `${source} ${cleanString(profile?.sourceUrl)} ${cleanString(profile?.evidenceSnippet)}`
    );

  const sourceUrl = cleanString(profile?.sourceUrl);

  if (!hasType && !hasDescription) {
    return 'skip';
  }
  if (source === 'masked_headhunter_name' && hasType) {
    return 'auto';
  }
  // known_official_site：有简介就自动通过
  if (source === 'known_official_site' && hasDescription) {
    return 'auto';
  }
  // gsxt 来源：sourceUrl 必须真正属于 gsxt.gov.cn + 有业务风格简介
  if (/^gsxt_search_/u.test(source) && hasDescription && /gsxt\.gov\.cn/u.test(sourceUrl)) {
    return 'auto';
  }
  // 百度百科：sourceUrl 必须属于 baike.baidu.com + 简介必须包含公司实体特征
  if (source === 'baidu_baike_direct' && hasDescription && /baike\.baidu\.com/u.test(sourceUrl) && confidenceScore >= 50) {
    return 'auto';
  }
  // 可信公共源：有业务风格描述 + sourceUrl 匹配可信域名
  if (isTrustedPublicSource && hasBusinessDescription && isTrustedDomain(sourceUrl)) {
    return 'auto';
  }
  // gsxt_search_bing / public_search_bing 来源 + 有业务风格描述 + 非招聘/问答域名
  if (/^(gsxt_search_bing|public_search_bing)$/u.test(source) && hasBusinessDescription && sourceUrl) {
    const isBadHost = /zhihu\.com|zhidao\.baidu\.com|51job\.com|zhipin\.com|liepin\.com|58\.com|ganji\.com/iu.test(sourceUrl);
    if (isBadHost) {
      return 'skip';
    }
    return 'auto';
  }
  // resolved 状态 + 有类型或简介 + 业务风格描述
  if (confidenceScore >= 80 && hasBusinessDescription && (hasType || hasDescription)) {
    return 'auto';
  }
  // 有业务描述 + 置信度达标自动通过
  if (confidenceScore >= thresholds.autoApproveScore && hasBusinessDescription) {
    return 'auto';
  }
  // review 区间：必须有业务风格描述或有类型
  if (confidenceScore >= thresholds.reviewScore && (hasType || hasBusinessDescription)) {
    return 'review';
  }
  if (hasBusinessDescription && confidenceScore >= 40) {
    return 'review';
  }
  return 'skip';
}

function hydrateProfileForDecision(cache) {
  if (!cache) {
    return null;
  }
  let confidenceScore = 0;
  if (cache.source === 'known_official_site') {
    confidenceScore = 95;
  } else if (cache.status === 'resolved') {
    confidenceScore = 85;
  } else if (cache.status === 'partial') {
    confidenceScore = 72;
  }

  return {
    ...cache,
    confidenceScore
  };
}

function isTrustedDomain(url) {
  const value = cleanString(url);
  if (!value) return false;
  return /baike\.baidu\.com|gsxt\.gov\.cn|wikipedia\.org|aiqicha\.baidu\.com|qcc\.com|tianyancha\.com/.test(value);
}

function isBusinessStyleDescription(value) {
  const text = cleanString(value);
  if (!text) {
    return false;
  }
  // 标点开头截断片段
  if (/^[、，,．.·：:？?""「\u201c\u201d【\[《〈（(\-]/u.test(text)) {
    return false;
  }
  // HTML注释残句
  if (/-->$/u.test(text)) {
    return false;
  }
  // 已有拦截
  if (/成立于|位于|开业状态|企业概况|工商信息|团队信息|acw_sc__v2|arg1=/u.test(text)) {
    return false;
  }
  // 非业务内容硬拦截：搜索平台导航、问答页、泛词百科、地名词条
  if (/百度百科\s*网页|百度百科$|网页\s*新闻|贴吧|知道$|文库|文心|更多 翻译|学术|百科/u.test(text)) {
    return false;
  }
  if (/百度知道|知乎|百度首页|hao123|map|设置 登录|你就知道|票根网官网登录|登录票根网/u.test(text)) {
    return false;
  }
  if (/这个公司怎么样|我要提问|欢迎.*新老员工|官网登录|Shenzhen City|深圳市/u.test(text)) {
    return false;
  }
  // 工商表格残句拦截
  if (/经营范围包括|一般经营项目是|公司已于.*年.*月.*日|法定代表人/u.test(text)) {
    return false;
  }
  // 网站页脚/导航残句拦截
  if (/网站地图|在线客服|版权所有|Copyright|ICP备|公众号二维码|扫扫微信|粤ICP备|旺铺管理入口|免责声明|客服中心|阿里巴巴集团/u.test(text)) {
    return false;
  }
  // 知乎问答页残句拦截
  if (/关注.*推荐|热榜|专栏|圈子|付费咨询|知学堂|登录\/注册|被浏览|被收录|活动时间/u.test(text)) {
    return false;
  }
  // 天眼查/企查查表格残句拦截
  if (/参保人数|注册资本|统一社会信用代码|企业注册地址|小微企业|科技型中小企业|瞪羚企业/u.test(text)) {
    return false;
  }
  // 个人信息误匹配拦截
  if (/男.*\d{4}年.*月出生|城市管理委员会|科员/u.test(text)) {
    return false;
  }
  // 非公司实体词条拦截（希腊字母、地名、泛词等）
  if (/希腊字母|音译|第十八个|求和符号|数学/u.test(text)) {
    return false;
  }
  // 论坛帖子残句拦截
  if (/回帖提示|反政府|封锁ID|提交前|amobbs|电子技术论坛/u.test(text)) {
    return false;
  }
  // 公司简介截断不完整拦截（只有前缀没有实质内容）
  if (/^·\s*简介[：:]\s*\d+、|^·\s*\d+、\s*.{0,10}是一/u.test(text)) {
    return false;
  }
  // 版权声明/备案号残句
  if (/版权所有|备案号|粤ICP|ICP备|官网.*版权/u.test(text)) {
    return false;
  }
  // 截断片段检测：以"天之前"等搜索残留开头
  if (/^(天之前|天之后|天\s*前|天\s*后)\s/u.test(text)) {
    return false;
  }
  // 非业务新闻稿检测：以"据天眼查"等开头
  if (/^据(天眼查|企查查|爱企查)/u.test(text)) {
    return false;
  }
  if (/据天眼查|据企查查|据爱企查/u.test(text)) {
    return false;
  }
  // 导航词列表检测：多个"解决方案"并列
  if (/解决方案\s+解决方案/u.test(text) && !/主要|提供|专注|从事/u.test(text)) {
    return false;
  }
  // 过短内容拦截
  if (text.length < 20) {
    return false;
  }
  // 英文导航残句拦截
  if (/GROUP PROFILE|COMPANY PROFILE|ABOUT US|CONTACT US|NEWS CENTER|JOIN US/u.test(text)) {
    return false;
  }
  // 纯枚举列表拦截：多个顿号分隔且无业务主体描述
  if ((text.match(/、/g) || []).length >= 3 && !/公司|专注|提供|从事|主要|业务|致力于|是一家|总部/u.test(text)) {
    return false;
  }
  return /主要|提供|专注于|从事|产品|服务|解决方案|业务|研发|平台|品牌|技术|智能|硬件|软件|物流|数据|互联网|消费|医疗|教育|新能源|电子|通信|金融|设计|制造|销售|运营|管理|咨询|外包|内包/u.test(text);
}

function isDirtySearchSnippet(value) {
  const text = cleanString(value);
  if (!text) {
    return true;
  }
  // 标点开头截断片段（不限长度，任何标点开头的非完整句子都是截断残留）
  if (/^[、，,．.·：:？?""「\u201c\u201d【\[《〈（(\-]/u.test(text)) {
    return true;
  }
  // HTML注释残句
  if (/-->$/u.test(text)) {
    return true;
  }
  // 纯头衔/荣誉（无业务描述）
  if (/^["""「].*[""」]$/u.test(text.trim()) || /工程技术研究中心/u.test(text.trim()) && text.trim().length < 50) {
    return true;
  }
  // 简介内容就是搜索引擎导航页/问答页/百科页
  const dirtyPatterns = [
    /百度百科\s*网页|百度百科$|网页\s*新闻|贴吧|知道$|文库|文心|更多 翻译|学术|百科/u,
    /百度知道|知乎|百度首页|hao123|设置 登录|你就知道|票根网官网登录/u,
    /这个公司怎么样|员工怎么样|怎么样\?|我要提问|欢迎.*新老员工|官网登录|Shenzhen City|深圳市/u,
    /经营范围包括|一般经营项目是|公司已于.*年.*月.*日|法定代表人/u,
    /网站地图|在线客服|版权所有|Copyright|ICP备|公众号二维码|粤ICP备/u,
    /关注.*推荐|热榜|专栏|圈子|付费咨询|知学堂|登录\/注册|被浏览|被收录/u,
    /参保人数|注册资本|统一社会信用代码|企业注册地址|小微企业|科技型中小企业|瞪羚企业/u,
    /男.*\d{4}年.*月出生|城市管理委员会|科员/u,
    /希腊字母|音译|第十八个|求和符号/u,
    /回帖提示|反政府|封锁ID|提交前|amobbs|电子技术论坛/u,
    /备案号|粤ICP|ICP备|官网.*版权/u,
    /成立于\d{4}年.*月|位于[^，。]{2,40}[，。]/u,
    /一般经营项目是[^。]{4,}/u,
    /^·\s*简介[：:]\s*\d+、|^·\s*\d+、\s*.{0,10}是一/u,
    /^(天之前|天之后|天\s*前|天\s*后)\s/u,
    /^据(天眼查|企查查|爱企查)/u,
    /据天眼查|据企查查|据爱企查/u,
    /解决方案\s+解决方案/u,
    /GROUP PROFILE|COMPANY PROFILE|ABOUT US|CONTACT US|NEWS CENTER|JOIN US/u
  ];
  return dirtyPatterns.some(function(p) { return p.test(text); });
}

function ensureDirectory(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildReviewPrompt(items) {
  const header = [
    '# Company Backfill Review',
    '',
    '请逐条审核以下公司介绍候选，只保留“公司做什么、主要产品/服务是什么”的业务摘要。',
    '忽略成立时间、地址、融资、企业概况、团队信息、导航词。',
    '输出格式：`recordId | 公司名称 | 是否通过 | 修正后的公司简介 | 公司类型(可空)`',
    ''
  ];

  const body = items.map((item, index) => (
    `${index + 1}. recordId=${item.recordId}\n`
    + `公司名称：${item.companyName}\n`
    + `行业：${item.industry || '-'}\n`
    + `规模：${item.scale || '-'}\n`
    + `地点：${item.location || '-'}\n`
    + `候选简介：${item.companyDescription || '-'}\n`
    + `候选类型：${item.companyType || '-'}\n`
    + `来源：${item.source || '-'}\n`
    + `来源链接：${item.sourceUrl || '-'}\n`
    + `置信分：${item.confidenceScore}\n`
    + `匹配名：${item.matchedName || '-'}\n`
    + `原因：${item.reason || '-'}\n`
  ));

  return header.concat(body).join('\n');
}

main().catch((error) => {
  console.error(`[BackfillCompanyFields] Failed: ${error.message}`);
  process.exitCode = 1;
});
