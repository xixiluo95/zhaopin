const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const GLOBAL_MEMORY_PATH = path.join(__dirname, '../../data/assistant_files/global/memory.json');
const IMPORTANCE_THRESHOLD = 0.5;

function readMemory(memoryPath = GLOBAL_MEMORY_PATH) {
  try {
    if (!fs.existsSync(memoryPath)) {
      return { version: 1, updated_at: null, entries: [] };
    }
    return JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  } catch {
    return { version: 1, updated_at: null, entries: [] };
  }
}

function writeMemoryAtomic(memory, memoryPath = GLOBAL_MEMORY_PATH) {
  const dir = path.dirname(memoryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  memory.version = (memory.version || 0) + 1;
  memory.updated_at = new Date().toISOString();

  const tmpPath = path.join(dir, `.memory_${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(memory, null, 2), 'utf-8');
  fs.renameSync(tmpPath, memoryPath);

  return memory;
}

function addMemoryEntry(entry, memoryPath = GLOBAL_MEMORY_PATH) {
  if (entry.importance !== undefined && entry.importance < IMPORTANCE_THRESHOLD) {
    return null; // Below threshold, skip
  }

  const memory = readMemory(memoryPath);
  const newEntry = {
    id: `mem_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    type: entry.type || 'insight',
    content: entry.content,
    importance: entry.importance || 0.5,
    created_at: new Date().toISOString(),
    source: entry.source || 'assistant'
  };

  memory.entries.push(newEntry);

  // Keep only last 100 entries, sorted by importance
  if (memory.entries.length > 100) {
    memory.entries.sort((a, b) => b.importance - a.importance);
    memory.entries = memory.entries.slice(0, 100);
  }

  writeMemoryAtomic(memory, memoryPath);
  return newEntry;
}

function getRelevantMemories(query, memoryPath = GLOBAL_MEMORY_PATH, limit = 10) {
  const memory = readMemory(memoryPath);
  // Simple keyword matching for now
  const queryTerms = query.toLowerCase().split(/\s+/);

  return memory.entries
    .map(entry => ({
      ...entry,
      relevance: queryTerms.filter(term =>
        entry.content.toLowerCase().includes(term)
      ).length / Math.max(queryTerms.length, 1)
    }))
    .filter(e => e.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.importance - a.importance)
    .slice(0, limit);
}

module.exports = { readMemory, writeMemoryAtomic, addMemoryEntry, getRelevantMemories, IMPORTANCE_THRESHOLD };
