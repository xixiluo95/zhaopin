# Boss直聘采集策略 V2 — 缓冲模式架构文档

## 问题背景

### V1 的缺陷
- **pageSize=3 + 无限翻页** 导致列表API被连续高频调用
- 为获取18条数据，需要发送7次列表请求，第7页触发反爬 (code: 37)
- 配置冲突：启动时 `MAX_LIST_PAGE_SIZE=3`，controller 同步为 `30`，实际生效为 3

### Boss API 限制（经调研确认）
- `zpData` 响应包含 `totalCount`（查询总数）和 `hasMore`（是否有下一页）
- **最大有效页数：10页**（超过10页返回空或重复数据）
- 反爬敏感度：列表API > 详情API

## V2 架构概述

### 核心改变
```
V1: pageSize=3 → 连续翻页 → 全部列表获取 → 统一详情
V2: pageSize=15~30 → 列表一页 → 详情批量3条 → 下一页列表（交错处理）
```

### 关键指标对比
| 指标 | V1 (pageSize=3) | V2 (pageSize=30) |
|------|-----------------|------------------|
| 获取200条所需列表请求 | ~67次 | ~7次 |
| 触发反爬风险 | 极高 | 低 |
| 详情处理方式 | 全部列表完成后统一处理 | 交错：列表→详情→列表 |

## 三种策略

### 策略1: `buffer-large` — 缓冲大页(30)【推荐】
- **列表 pageSize**: 30
- **列表页间延迟**: 12s + random(0~3s)
- **详情间延迟**: 8s + random(0~3s)
- **最大页数**: 10
- **模式**: 交错（列表一页→处理详情→下一页）
- **预期效果**: 最少列表请求，单次可获取 ~300 条
- **适用场景**: 网络环境正常，无反爬历史

### 策略2: `buffer-medium` — 缓冲中页(15)
- **列表 pageSize**: 15
- **列表页间延迟**: 10s + random(0~3s)
- **详情间延迟**: 8s + random(0~3s)
- **最大页数**: 10
- **模式**: 交错
- **预期效果**: 中等请求频率，单次可获取 ~150 条
- **适用场景**: 策略1被反爬后降级

### 策略3: `sequential-conservative` — 顺序保守(15)
- **列表 pageSize**: 15
- **列表页间延迟**: 15s + random(0~3s)
- **详情间延迟**: 10s + random(0~3s)
- **最大页数**: 5
- **模式**: 顺序（先列表全获取→再统一详情）
- **预期效果**: 最保守，单次可获取 ~75 条
- **适用场景**: 反爬严重时的最后手段

## 策略轮转机制

```
启动 → 使用策略1(buffer-large)
         ↓ 成功 → 完成
         ↓ 反爬 → 冷却15-25s
              ↓
         使用策略2(buffer-medium)
              ↓ 成功 → 完成
              ↓ 反爬 → 冷却15-25s
                   ↓
              使用策略3(sequential-conservative)
                   ↓ 成功 → 完成
                   ↓ 反爬 → 标记antiCrawlTriggered，返回部分数据
```

## 日志解读指南

### 正常运行日志示例
```
[JobHunter] 📋 V2 Buffer Crawl: 3 strategies available
[JobHunter] 🎯 Strategy [1/3]: 缓冲大页(30) (buffer-large)
[JobHunter] Fetching list page 1/10 (strategy: buffer-large, pageSize=30)
[JobHunter] List page 1: 30 jobs (totalCount=180, hasMore=true)
[JobHunter] 📊 Total available: 180
[JobHunter] Buffer: 30 new jobs (0 dedup)
[JobHunter] Processing 30 details from page 1
[JobHunter] [detail 1] Java后端工程师
[JobHunter]   ✓ 624 chars
...
[JobHunter] 📈 Progress: 30/180 jobs, page 1/10
[JobHunter]   ⏱️ List delay 14.2s...
[JobHunter] Fetching list page 2/10 ...
```

### 策略切换日志
```
[JobHunter] ⚠️ Strategy buffer-large anti-crawl at page 4: API error: 您的环境存在异常. (code: 37)
[JobHunter] 🔄 Switching to next strategy...
[JobHunter]   ⏱️ Switch cooldown 21.3s...
[JobHunter] 🎯 Strategy [2/3]: 缓冲中页(15) (buffer-medium)
```

### 策略报告（任务结束时打印）
```
[JobHunter] 📋 Strategy Report:
[JobHunter]   [buffer-large] anti_crawl | pages: 3/4 | listed: 90 | detailed: 85 | 312.5s | anti-crawl@p4
[JobHunter]   [buffer-medium] success | pages: 6/10 | listed: 90 | detailed: 88 | 845.2s
[JobHunter] Total: 173 collected / 180 available, 7 filtered
```

## 配置统一

### 修复前（冲突）
- `background.js CONFIG`: `BOSS_BATCH_SIZE=3` → `MAX_LIST_PAGE_SIZE=3`
- `controller runtime_config.json`: `MAX_LIST_PAGE_SIZE=30`

### 修复后（统一）
- `background.js RUNTIME_CONFIG_DEFAULTS`: `MAX_LIST_PAGE_SIZE=30`
- `controller DEFAULT_RUNTIME_CONFIG`: `MAX_LIST_PAGE_SIZE=30`
- 策略的 `listPageSize` 独立于 `MAX_LIST_PAGE_SIZE`，不冲突

## 关键文件变更

### `crawler/extension/content.js`
- `scrapeJobs()` 默认 `pageSize` 从 3 改为 15
- 新增提取 `zpData.totalCount` 和 `zpData.hasMore`
- 返回值增加 `totalCount`, `hasMore`, `source`, `pageSize`, `batchCount`

### `crawler/extension/background.js`
- CONFIG: 移除 `BOSS_BATCH_SIZE`，新增 `BOSS_STRATEGIES[]` 策略数组
- 新增 `executeBufferedBossCrawl()` 方法（核心缓冲模式逻辑）
- `executeCrawlTask()` 改为调用 `executeBufferedBossCrawl()`
- `scrapeJobListPages()` 新增 `totalCount` 透传

## 后续AI操作指南

### 如何确定最终使用哪套策略

1. 运行一次手动采集任务（产品经理 + 北京）
2. 查看控制台日志中的 **📋 Strategy Report**
3. 找到 `result=success` 的策略，即为当前环境最优策略

### 如何只保留一种策略

在 `background.js` 的 `CONFIG.BOSS_STRATEGIES` 数组中，删除不需要的策略对象：

```javascript
// 例如只保留 buffer-large：
BOSS_STRATEGIES: [
  {
    id: 'buffer-large',
    name: '缓冲大页(30)',
    listPageSize: 30,
    listDelayMs: 12000,
    detailDelayMs: 8000,
    detailBatchSize: 3,
    maxPages: 10,
    interleaved: true,
  },
  // 删除其他策略
],
```

### 如何调整延迟参数

如果某策略频繁触发反爬，增加其延迟：
- `listDelayMs`: 列表页间延迟（当前 10000-15000ms）
- `detailDelayMs`: 详情请求间延迟（当前 8000-10000ms）

### 如何添加新策略

在 `CONFIG.BOSS_STRATEGIES` 数组中追加新对象，字段说明：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | string | 唯一标识 |
| name | string | 显示名称 |
| listPageSize | number | 列表API每页条数 (1-30) |
| listDelayMs | number | 列表页间延迟（毫秒） |
| detailDelayMs | number | 详情请求间延迟（毫秒） |
| detailBatchSize | number | 每批处理详情数 |
| maxPages | number | 最大翻页数 (Boss限制10) |
| interleaved | boolean | true=交错模式，false=顺序模式 |
