/**
 * resume-document-model.js
 * 简历双层数据模型：内容层(Content) + 表现层(Presentation)
 * 
 * 设计理念：
 * - 内容层只存储文本结构（sections, items, fields）
 * - 表现层只存储样式参数（template, fonts, theme, decorations）
 * - AI 可以独立修改内容或样式
 * - 导出/渲染统一从此模型读取
 */

// ===================== 默认值 =====================
const DEFAULT_PRESENTATION = {
  templateId: 'structured',
  fonts: {
    family: 'default',   // default | heiti | kaiti | songti | yahei
    sizeBase: 14,         // px
    headingScale: 1.6,    // heading = sizeBase * headingScale
  },
  theme: {
    accentColor: '#E62B1E',
    textColor: '#1A1A1A',
    bgColor: '#FFFFFF',
    lineHeight: 1.7,
    paragraphSpacing: 12,
  },
  decorations: {
    dividers: [],        // [{afterSection: 'education', style: 'solid'}]
    tags: [],            // [{sectionId: 'skills', items: ['Python','JS'], style: 'pill'}]
    shapes: [],          // [{type: 'accent-bar', position: 'header-left', color: '#E62B1E'}]
    emphasisBoxes: [],   // [{sectionId: 'summary', style: 'highlight'}]
  },
};

const DEFAULT_CONTENT = {
  name: '',
  headline: '',
  meta: {},          // phone, email, school, major, birthDate, gender, location, ...
  sections: [],      // [{id, title, items: [{id, text, subItems: [...]}]}]
};

// ===================== ResumeDocument 类 =====================
class ResumeDocument {
  constructor(content = null, presentation = null) {
    this.content = content ? JSON.parse(JSON.stringify(content)) : JSON.parse(JSON.stringify(DEFAULT_CONTENT));
    this.presentation = presentation ? JSON.parse(JSON.stringify(presentation)) : JSON.parse(JSON.stringify(DEFAULT_PRESENTATION));
    this._history = [];       // 操作历史（用于回滚）
    this._maxHistory = 50;
  }

  // ===================== 快照与回滚 =====================
  _snapshot() {
    this._history.push({
      content: JSON.parse(JSON.stringify(this.content)),
      presentation: JSON.parse(JSON.stringify(this.presentation)),
      timestamp: Date.now(),
    });
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }
  }

  rollback() {
    if (this._history.length === 0) return false;
    const prev = this._history.pop();
    this.content = prev.content;
    this.presentation = prev.presentation;
    return true;
  }

  canRollback() {
    return this._history.length > 0;
  }

  getHistoryLength() {
    return this._history.length;
  }

  // ===================== 内容层 CRUD =====================

  // --- 查询 ---
  getDocument() {
    return { content: this.content, presentation: this.presentation };
  }

  getStructure() {
    return {
      name: this.content.name,
      headline: this.content.headline,
      metaKeys: Object.keys(this.content.meta),
      sections: this.content.sections.map(s => ({
        id: s.id,
        title: s.title,
        itemCount: (s.items || []).length,
      })),
    };
  }

  queryNodes(query) {
    const results = [];
    const q = (query || '').toLowerCase();
    // 搜索 sections
    for (const sec of this.content.sections) {
      if (sec.title.toLowerCase().includes(q) || sec.id.toLowerCase().includes(q)) {
        results.push({ type: 'section', id: sec.id, title: sec.title });
      }
      for (const item of (sec.items || [])) {
        if ((item.text || '').toLowerCase().includes(q)) {
          results.push({ type: 'item', sectionId: sec.id, id: item.id, text: item.text.substring(0, 80) });
        }
      }
    }
    // 搜索 meta
    for (const [k, v] of Object.entries(this.content.meta)) {
      if (String(v).toLowerCase().includes(q) || k.toLowerCase().includes(q)) {
        results.push({ type: 'meta', key: k, value: v });
      }
    }
    return results;
  }

  // --- Section CRUD ---
  insertSection(title, afterSectionId = null, items = []) {
    this._snapshot();
    const id = 'sec-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const section = { id, title, items: items.map((text, i) => ({ id: `item-${id}-${i}`, text })) };
    if (afterSectionId) {
      const idx = this.content.sections.findIndex(s => s.id === afterSectionId);
      if (idx >= 0) {
        this.content.sections.splice(idx + 1, 0, section);
      } else {
        this.content.sections.push(section);
      }
    } else {
      this.content.sections.push(section);
    }
    return section;
  }

  deleteSection(sectionId) {
    this._snapshot();
    const idx = this.content.sections.findIndex(s => s.id === sectionId);
    if (idx < 0) return false;
    this.content.sections.splice(idx, 1);
    return true;
  }

  moveSection(sectionId, direction) {
    this._snapshot();
    const idx = this.content.sections.findIndex(s => s.id === sectionId);
    if (idx < 0) return false;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= this.content.sections.length) return false;
    const tmp = this.content.sections[idx];
    this.content.sections[idx] = this.content.sections[newIdx];
    this.content.sections[newIdx] = tmp;
    return true;
  }

  // --- Item CRUD ---
  insertItem(sectionId, text, afterItemId = null) {
    this._snapshot();
    const sec = this.content.sections.find(s => s.id === sectionId);
    if (!sec) return null;
    if (!sec.items) sec.items = [];
    const item = { id: 'item-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), text };
    if (afterItemId) {
      const idx = sec.items.findIndex(i => i.id === afterItemId);
      if (idx >= 0) {
        sec.items.splice(idx + 1, 0, item);
      } else {
        sec.items.push(item);
      }
    } else {
      sec.items.push(item);
    }
    return item;
  }

  updateItem(sectionId, itemId, newText) {
    this._snapshot();
    const sec = this.content.sections.find(s => s.id === sectionId);
    if (!sec) return false;
    const item = (sec.items || []).find(i => i.id === itemId);
    if (!item) return false;
    item.text = newText;
    return true;
  }

  deleteItem(sectionId, itemId) {
    this._snapshot();
    const sec = this.content.sections.find(s => s.id === sectionId);
    if (!sec || !sec.items) return false;
    const idx = sec.items.findIndex(i => i.id === itemId);
    if (idx < 0) return false;
    sec.items.splice(idx, 1);
    return true;
  }

  moveItem(sectionId, itemId, direction) {
    this._snapshot();
    const sec = this.content.sections.find(s => s.id === sectionId);
    if (!sec || !sec.items) return false;
    const idx = sec.items.findIndex(i => i.id === itemId);
    if (idx < 0) return false;
    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= sec.items.length) return false;
    const tmp = sec.items[idx];
    sec.items[idx] = sec.items[newIdx];
    sec.items[newIdx] = tmp;
    return true;
  }

  // --- 字段级修改 ---
  setField(fieldPath, value) {
    this._snapshot();
    if (fieldPath === 'name') { this.content.name = value; return true; }
    if (fieldPath === 'headline') { this.content.headline = value; return true; }
    if (fieldPath.startsWith('meta.')) {
      const key = fieldPath.slice(5);
      this.content.meta[key] = value;
      return true;
    }
    // section.title
    const m = fieldPath.match(/^sections\[(\d+)\]\.title$/);
    if (m) {
      const idx = parseInt(m[1]);
      if (this.content.sections[idx]) {
        this.content.sections[idx].title = value;
        return true;
      }
    }
    return false;
  }

  // --- 文本操作 ---
  replaceText(oldText, newText, options = {}) {
    this._snapshot();
    let count = 0;
    const global = options.global !== false; // 默认全局替换
    const replaceInStr = (s) => {
      if (!s || typeof s !== 'string') return s;
      if (s.includes(oldText)) {
        count++;
        return global ? s.split(oldText).join(newText) : s.replace(oldText, newText);
      }
      return s;
    };
    this.content.name = replaceInStr(this.content.name);
    this.content.headline = replaceInStr(this.content.headline);
    for (const k of Object.keys(this.content.meta)) {
      this.content.meta[k] = replaceInStr(String(this.content.meta[k]));
    }
    for (const sec of this.content.sections) {
      sec.title = replaceInStr(sec.title);
      for (const item of (sec.items || [])) {
        item.text = replaceInStr(item.text);
      }
    }
    return count;
  }

  appendToSection(sectionId, text) {
    return this.insertItem(sectionId, text);
  }

  // ===================== 表现层操作 =====================

  setStyle(stylePath, value) {
    this._snapshot();
    const parts = stylePath.split('.');
    let target = this.presentation;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;
    return true;
  }

  setTemplate(templateId) {
    this._snapshot();
    this.presentation.templateId = templateId;
    return true;
  }

  addTag(sectionId, tagText, style = 'pill') {
    this._snapshot();
    if (!this.presentation.decorations.tags) this.presentation.decorations.tags = [];
    let tagGroup = this.presentation.decorations.tags.find(t => t.sectionId === sectionId);
    if (!tagGroup) {
      tagGroup = { sectionId, items: [], style };
      this.presentation.decorations.tags.push(tagGroup);
    }
    tagGroup.items.push(tagText);
    return true;
  }

  addDivider(afterSectionId, style = 'solid') {
    this._snapshot();
    if (!this.presentation.decorations.dividers) this.presentation.decorations.dividers = [];
    this.presentation.decorations.dividers.push({ afterSection: afterSectionId, style });
    return true;
  }

  addShape(type, position, color = '#E62B1E') {
    this._snapshot();
    if (!this.presentation.decorations.shapes) this.presentation.decorations.shapes = [];
    this.presentation.decorations.shapes.push({ type, position, color });
    return true;
  }

  // ===================== Markdown 双向转换 =====================

  static fromMarkdown(md) {
    const doc = new ResumeDocument();
    if (!md || !md.trim()) return doc;

    const lines = md.split('\n');
    let currentSection = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // H1 = 姓名
      if (trimmed.startsWith('# ')) {
        doc.content.name = trimmed.slice(2).trim();
        continue;
      }

      // H2 = Section 标题
      if (trimmed.startsWith('## ')) {
        const title = trimmed.slice(3).trim();
        currentSection = {
          id: 'sec-' + doc.content.sections.length,
          title,
          items: [],
        };
        doc.content.sections.push(currentSection);
        continue;
      }

      // H3 = 子标题（作为 item）
      if (trimmed.startsWith('### ')) {
        if (currentSection) {
          currentSection.items.push({
            id: `item-${currentSection.id}-${currentSection.items.length}`,
            text: '**' + trimmed.slice(4).trim() + '**',
          });
        }
        continue;
      }

      // 列表项 (- 或 *)
      if (/^[-*]\s+/.test(trimmed)) {
        const text = trimmed.replace(/^[-*]\s+/, '');
        if (currentSection) {
          currentSection.items.push({
            id: `item-${currentSection.id}-${currentSection.items.length}`,
            text,
          });
        }
        continue;
      }

      // 普通文本行（非空）
      if (trimmed && currentSection) {
        // 检查是否是 key: value 格式
        const kvMatch = trimmed.match(/^(.+?)[:：]\s*(.+)$/);
        if (kvMatch && !currentSection.items.length && doc.content.sections.length <= 2) {
          // 可能是 meta 信息
          doc.content.meta[kvMatch[1].trim()] = kvMatch[2].trim();
        } else {
          currentSection.items.push({
            id: `item-${currentSection.id}-${currentSection.items.length}`,
            text: trimmed,
          });
        }
      } else if (trimmed && !currentSection) {
        // 在第一个 section 之前的文本
        if (!doc.content.headline) {
          doc.content.headline = trimmed;
        } else {
          // 解析 meta
          const kvMatch = trimmed.match(/^(.+?)[:：]\s*(.+)$/);
          if (kvMatch) {
            doc.content.meta[kvMatch[1].trim()] = kvMatch[2].trim();
          }
        }
      }
    }

    return doc;
  }

  toMarkdown() {
    const lines = [];

    // 姓名
    if (this.content.name) {
      lines.push(`# ${this.content.name}`);
      lines.push('');
    }

    // Headline
    if (this.content.headline) {
      lines.push(this.content.headline);
      lines.push('');
    }

    // Meta
    const metaEntries = Object.entries(this.content.meta);
    if (metaEntries.length > 0) {
      for (const [k, v] of metaEntries) {
        lines.push(`${k}：${v}`);
      }
      lines.push('');
    }

    // Sections
    for (const sec of this.content.sections) {
      lines.push(`## ${sec.title}`);
      lines.push('');
      for (const item of (sec.items || [])) {
        // 如果 item.text 以 ** 开头结尾，则作为 H3
        if (item.text.startsWith('**') && item.text.endsWith('**')) {
          lines.push(`### ${item.text.slice(2, -2)}`);
        } else {
          lines.push(`- ${item.text}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n').trim();
  }

  // ===================== 序列化 =====================

  toJSON() {
    return {
      content: this.content,
      presentation: this.presentation,
    };
  }

  static fromJSON(json) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    return new ResumeDocument(data.content, data.presentation);
  }

  clone() {
    return ResumeDocument.fromJSON(this.toJSON());
  }
}

// ===================== 全局状态管理 =====================

// 单例简历文档
let _resumeDoc = null;
// 状态变更监听器
const _stateListeners = [];

function getCurrentResumeDocument() {
  return _resumeDoc;
}

function setResumeDocument(doc) {
  _resumeDoc = doc;
  _notifyListeners('set');
}

function initResumeDocumentFromMarkdown(md) {
  _resumeDoc = ResumeDocument.fromMarkdown(md);
  _notifyListeners('init');
  return _resumeDoc;
}

function onResumeStateChange(listener) {
  _stateListeners.push(listener);
  return () => {
    const idx = _stateListeners.indexOf(listener);
    if (idx >= 0) _stateListeners.splice(idx, 1);
  };
}

function _notifyListeners(eventType) {
  for (const fn of _stateListeners) {
    try { fn(eventType, _resumeDoc); } catch (e) { console.error('[ResumeDoc] listener error:', e); }
  }
}

// ===================== 统一状态入口 =====================

function getCurrentResumeState() {
  if (!_resumeDoc) return null;
  return {
    contentMd: _resumeDoc.toMarkdown(),
    document: _resumeDoc.toJSON(),
    templateId: _resumeDoc.presentation.templateId,
  };
}

async function commitResumeState(updateFn) {
  if (!_resumeDoc) return false;
  // updateFn 可以是同步或异步函数，接收 doc 并修改它
  if (typeof updateFn === 'function') {
    await updateFn(_resumeDoc);
  }
  _notifyListeners('commit');
  return true;
}

// ===================== 导出 =====================
export {
  ResumeDocument,
  DEFAULT_CONTENT,
  DEFAULT_PRESENTATION,
  getCurrentResumeDocument,
  setResumeDocument,
  initResumeDocumentFromMarkdown,
  onResumeStateChange,
  getCurrentResumeState,
  commitResumeState,
};
