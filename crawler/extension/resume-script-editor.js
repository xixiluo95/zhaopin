/**
 * resume-script-editor.js
 * 简历脚本编辑工具 - 供 AI 助手调用的简历直接编辑接口
 * 
 * 工具组：17 个编辑工具 + 预览/直接执行双模式 + 操作日志 + 回滚
 */

import {
  getCurrentResumeDocument,
  initResumeDocumentFromMarkdown,
  onResumeStateChange,
} from './resume-document-model.js';

// ===================== 操作日志 =====================
const _operationLog = [];
const MAX_LOG_SIZE = 100;

function logOperation(toolName, args, result) {
  _operationLog.push({
    tool: toolName,
    args: JSON.parse(JSON.stringify(args || {})),
    result: typeof result === 'object' ? JSON.parse(JSON.stringify(result)) : result,
    timestamp: Date.now(),
  });
  if (_operationLog.length > MAX_LOG_SIZE) _operationLog.shift();
}

function getOperationLog() {
  return [..._operationLog];
}

function clearOperationLog() {
  _operationLog.length = 0;
}

// ===================== 工具注册表 =====================

const TOOL_REGISTRY = {};

function registerTool(name, description, handler) {
  TOOL_REGISTRY[name] = { name, description, handler };
}

function getToolCatalog() {
  return Object.values(TOOL_REGISTRY).map(t => ({
    name: t.name,
    description: t.description,
  }));
}

// ===================== 安全执行器 =====================

function _getDoc() {
  const doc = getCurrentResumeDocument();
  if (!doc) throw new Error('没有加载简历文档，请先上传或创建简历');
  return doc;
}

async function executeTool(toolName, args = {}, mode = 'direct') {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool) throw new Error(`未知工具: ${toolName}`);

  const doc = _getDoc();

  if (mode === 'preview') {
    // 预览模式：在克隆副本上执行，返回 diff
    const clone = doc.clone();
    const beforeMd = doc.toMarkdown();
    const result = tool.handler(clone, args);
    const afterMd = clone.toMarkdown();
    return {
      mode: 'preview',
      tool: toolName,
      result,
      before: beforeMd,
      after: afterMd,
      changed: beforeMd !== afterMd,
    };
  }

  // 直接执行模式
  const result = tool.handler(doc, args);
  logOperation(toolName, args, result);
  return {
    mode: 'direct',
    tool: toolName,
    result,
    currentMd: doc.toMarkdown(),
  };
}

// ===================== 批量执行 =====================

async function executeBatch(operations, mode = 'direct') {
  const results = [];
  for (const op of operations) {
    try {
      const r = await executeTool(op.tool, op.args || {}, mode);
      results.push({ ...r, success: true });
    } catch (e) {
      results.push({ tool: op.tool, success: false, error: e.message });
    }
  }
  return results;
}

// ===================== 注册所有工具 =====================

// 1. resume_get_document
registerTool('resume_get_document', '获取完整简历文档（内容+样式）', (doc) => {
  return doc.getDocument();
});

// 2. resume_get_structure
registerTool('resume_get_structure', '获取简历结构概览（section列表、item数量）', (doc) => {
  return doc.getStructure();
});

// 3. resume_query_nodes
registerTool('resume_query_nodes', '按关键词搜索简历节点', (doc, args) => {
  return doc.queryNodes(args.query || '');
});

// 4. resume_insert_node (section or item)
registerTool('resume_insert_node', '新增 section 或 item', (doc, args) => {
  if (args.type === 'section') {
    return doc.insertSection(args.title, args.afterSectionId, args.items || []);
  } else if (args.type === 'item') {
    return doc.insertItem(args.sectionId, args.text, args.afterItemId);
  }
  throw new Error('type 必须是 section 或 item');
});

// 5. resume_update_node
registerTool('resume_update_node', '修改 section 标题或 item 文本', (doc, args) => {
  if (args.type === 'section') {
    return doc.setField(`sections[${args.sectionIndex}].title`, args.title);
  } else if (args.type === 'item') {
    return doc.updateItem(args.sectionId, args.itemId, args.text);
  }
  throw new Error('type 必须是 section 或 item');
});

// 6. resume_delete_node
registerTool('resume_delete_node', '删除 section 或 item', (doc, args) => {
  if (args.type === 'section') {
    return doc.deleteSection(args.sectionId);
  } else if (args.type === 'item') {
    return doc.deleteItem(args.sectionId, args.itemId);
  }
  throw new Error('type 必须是 section 或 item');
});

// 7. resume_move_node
registerTool('resume_move_node', '移动 section 或 item 顺序（up/down）', (doc, args) => {
  if (args.type === 'section') {
    return doc.moveSection(args.sectionId, args.direction);
  } else if (args.type === 'item') {
    return doc.moveItem(args.sectionId, args.itemId, args.direction);
  }
  throw new Error('type 必须是 section 或 item');
});

// 8. resume_set_field
registerTool('resume_set_field', '设置字段值（name, headline, meta.*）', (doc, args) => {
  return doc.setField(args.field, args.value);
});

// 9. resume_replace_text
registerTool('resume_replace_text', '全局文本替换', (doc, args) => {
  const count = doc.replaceText(args.oldText, args.newText, { global: args.global !== false });
  return { replacedCount: count };
});

// 10. resume_set_style
registerTool('resume_set_style', '设置样式属性（fonts.family, theme.accentColor 等）', (doc, args) => {
  return doc.setStyle(args.path, args.value);
});

// 11. resume_add_tag
registerTool('resume_add_tag', '为指定 section 添加标签', (doc, args) => {
  return doc.addTag(args.sectionId, args.tag, args.style || 'pill');
});

// 12. resume_add_divider
registerTool('resume_add_divider', '在指定 section 后添加分割线', (doc, args) => {
  return doc.addDivider(args.afterSectionId, args.style || 'solid');
});

// 13. resume_add_shape
registerTool('resume_add_shape', '添加装饰图形（accent-bar, dot-grid 等）', (doc, args) => {
  return doc.addShape(args.type, args.position, args.color || '#E62B1E');
});

// 14. resume_set_template
registerTool('resume_set_template', '切换简历模板', (doc, args) => {
  return doc.setTemplate(args.templateId);
});

// 15. resume_render_preview
registerTool('resume_render_preview', '获取当前 Markdown 预览', (doc) => {
  return { markdown: doc.toMarkdown() };
});

// 16. resume_commit_changes
registerTool('resume_commit_changes', '提交所有变更（触发保存和视图刷新）', (doc) => {
  // 这个工具的实际提交逻辑在 dashboard.js 中处理
  return { markdown: doc.toMarkdown(), committed: true };
});

// 17. resume_rollback_changes
registerTool('resume_rollback_changes', '回滚上一步操作', (doc) => {
  const ok = doc.rollback();
  return { rolledBack: ok, markdown: ok ? doc.toMarkdown() : null };
});

// ===================== AI 指令解析器 =====================

/**
 * 解析 AI 回复中的工具调用指令
 * 支持格式：
 *   ```tool
 *   {"tool": "resume_set_field", "args": {"field": "name", "value": "李四"}}
 *   ```
 * 
 * 或行内格式：
 *   [TOOL:resume_set_field:{"field":"name","value":"李四"}]
 */
function parseToolCalls(aiReply) {
  const calls = [];

  // 格式1：```tool ... ```
  const blockRegex = /```tool\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = blockRegex.exec(aiReply)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool) {
        calls.push({ tool: parsed.tool, args: parsed.args || {}, raw: match[0] });
      }
    } catch (e) {
      // 静默跳过解析失败
    }
  }

  // 格式2：[TOOL:name:argsJson]
  const inlineRegex = /\[TOOL:([a-z_]+):(.*?)\]/g;
  while ((match = inlineRegex.exec(aiReply)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      calls.push({ tool: match[1], args, raw: match[0] });
    } catch (e) {
      // 静默跳过
    }
  }

  return calls;
}

/**
 * 从 AI 回复中提取纯文本（移除工具调用块）
 */
function stripToolCalls(aiReply) {
  let cleaned = aiReply.replace(/```tool\s*\n[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/\[TOOL:[a-z_]+:.*?\]/g, '');
  return cleaned.trim();
}

// ===================== 导出 =====================
export {
  executeTool,
  executeBatch,
  getToolCatalog,
  getOperationLog,
  clearOperationLog,
  parseToolCalls,
  stripToolCalls,
  TOOL_REGISTRY,
};
