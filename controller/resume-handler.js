/**
 * resume-handler.js - 简历上传与读取 API Handler
 *
 * 提供 3 个 API 端点处理函数。
 * 使用 formidable 解析 multipart 上传。
 * 依赖 resume-db.js 的 CRUD 函数。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { formidable } = require('formidable');
const resumeDb = require('./resume-db');
const { parseResumeToMarkdown } = require('./services/resume-parser');
const { processResume } = require('./services/resume/resume-pipeline');

const UPLOAD_DIR = path.join(__dirname, 'uploads', 'resumes');

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

/**
 * POST /api/resume/upload - 上传简历
 */
async function handleResumeUpload(req, res) {
  ensureUploadDir();

  const form = formidable({
    multiples: false,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    uploadDir: UPLOAD_DIR,
    filename: (name) => {
      const ext = path.extname(name) || '.bin';
      return `${Date.now()}-${crypto.randomUUID()}${ext}`;
    }
  });

  try {
    const [fields, files] = await form.parse(req);

    const file = files.file?.[0] || files.file;
    if (!file || !file.filepath) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'No file provided' }));
      return;
    }

    const savedPath = file.filepath;
    const originalName = file.originalFilename || path.basename(savedPath);
    const fileSize = file.size;

    const dbResult = resumeDb.insertResume({
      fileName: originalName,
      filePath: savedPath,
      fileSize
    });

    if (!dbResult.success) {
      try { fs.unlinkSync(savedPath); } catch { /* ignore */ }
      res.writeHead(500);
      res.end(JSON.stringify({ error: dbResult.error }));
      return;
    }

    const uploadedAt = resumeDb.getLatestResume()?.upload_time || null;

    // 文件保存成功后，尝试解析为 Markdown
    try {
      const mimeType = file.mimetype || '';
      if (mimeType) {
        const contentMd = await parseResumeToMarkdown(savedPath, mimeType);
        resumeDb.updateResume({
          content_md: contentMd,
          status: 'parsed'
        });
        console.log('[ResumeHandler] 简历解析成功，status=parsed');

        // 运行 pipeline 生成三个产出物并记录版本
        try {
          const pipelineResult = await processResume(contentMd, {
            resumeId: dbResult.id,
            inputFormat: mimeType
          });

          const { getDatabase } = require('./db');
          const db = getDatabase();
          db.prepare(`
            INSERT INTO resume_versions (resume_id, version_number, md_path, meta_json_path, conversion_report_path)
            VALUES (?, ?, ?, ?, ?)
          `).run(
            dbResult.id,
            1,
            pipelineResult.paths.mdPath,
            pipelineResult.paths.metaPath,
            pipelineResult.paths.reportPath
          );
          console.log('[ResumeHandler] Pipeline 产出物已保存，版本已记录');
        } catch (pipelineErr) {
          console.error('[ResumeHandler] Pipeline 处理失败:', pipelineErr.message);
        }
      } else {
        resumeDb.updateResume({ status: 'parse_failed' });
        console.warn('[ResumeHandler] 无法解析：缺少 MIME 类型');
      }
    } catch (parseErr) {
      // 解析失败不影响文件存储，只更新状态
      resumeDb.updateResume({ status: 'parse_failed' });
      console.error('[ResumeHandler] 简历解析失败:', parseErr.message);
    }

    res.end(JSON.stringify({
      id: dbResult.id,
      filePath: savedPath,
      originalName,
      sizeBytes: fileSize,
      uploadedAt
    }));
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Upload failed: ' + err.message }));
  }
}

/**
 * GET /api/resume - 获取最新简历
 */
function handleGetResume(req, res) {
  const resume = resumeDb.getLatestResume();
  res.end(JSON.stringify({ resume }));
}

/**
 * DELETE /api/resume?id=N - 删除简历（同时清理物理文件）
 */
function handleDeleteResume(req, res) {
  const url = new URL(req.url, `http://localhost:${req.socket.localPort}`);
  const id = Number(url.searchParams.get('id'));

  if (!id) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing or invalid id parameter' }));
    return;
  }

  // 先查记录获取文件路径，再删数据库，最后删物理文件
  const { getDatabase } = require('./db');
  const db = getDatabase();
  const record = db.prepare('SELECT * FROM resumes WHERE id = ?').get(id);

  if (!record) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Resume not found' }));
    return;
  }

  const deleted = resumeDb.deleteResume(id);
  if (!deleted) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Resume not found' }));
    return;
  }

  // 清理物理文件
  try {
    if (record.file_path && fs.existsSync(record.file_path)) {
      fs.unlinkSync(record.file_path);
    }
  } catch (e) {
    console.error('[ResumeHandler] Failed to delete physical file:', e.message);
  }

  res.end(JSON.stringify({ success: true }));
}

/**
 * PATCH /api/resume - 更新简历内容（只修改 content_md 字段）
 *
 * Body: { "content_md": "# 张三\n## 教育背景\n..." }
 * Response: { "success": true, "resume": { ... } }
 */
function handlePatchResume(req, res) {
  const chunks = [];

  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());

      if (body.content_md === undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing content_md field' }));
        return;
      }

      const result = resumeDb.updateResume({ content_md: body.content_md });

      if (!result.success) {
        const statusCode = result.statusCode || 500;
        res.writeHead(statusCode);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      res.end(JSON.stringify({ success: true, resume: result.resume }));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body: ' + err.message }));
    }
  });
}

module.exports = {
  handleResumeUpload,
  handleGetResume,
  handleDeleteResume,
  handlePatchResume
};
