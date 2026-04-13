/**
 * credential-crypto.js - 凭据加密/解密服务
 *
 * 使用 AES-256-GCM 对称加密，保护 API Key 等敏感凭据。
 * 仅依赖 Node.js 内置 crypto 模块，无额外依赖。
 *
 * 密钥从环境变量 CREDENTIAL_ENCRYPTION_KEY 读取（开发环境使用默认值）。
 * 加密格式：base64(IV(12字节) + authTag(16字节) + 密文)
 */

const crypto = require('crypto');

// ---- 常量 ----
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;   // GCM 推荐 12 字节 IV
const AUTH_TAG_LENGTH = 16;

// 加密密钥：必须通过环境变量 CREDENTIAL_ENCRYPTION_KEY 注入（32字节）
const KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || (() => {
  console.warn('[credential-crypto] 警告: 未设置 CREDENTIAL_ENCRYPTION_KEY 环境变量，使用临时开发密钥');
  return 'dev-only-insecure-key-replace-me-!!';
})();

// 确保 KEY 恰好 32 字节（AES-256 要求）
function _getKeyBuffer() {
  const buf = Buffer.from(KEY, 'utf8');
  if (buf.length !== 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes, got ${buf.length}. ` +
      'Set the environment variable to a 32-character string.'
    );
  }
  return buf;
}

/**
 * 加密明文
 *
 * @param {string} text - 待加密的明文
 * @returns {string} base64 编码的密文（格式：iv:authTag:ciphertext）
 * @throws {Error} text 不是字符串
 */
function encrypt(text) {
  if (typeof text !== 'string') {
    throw new Error('encrypt() expects a string input');
  }

  const keyBuf = _getKeyBuffer();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuf, iv);

  let encrypted = cipher.update(text, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);

  const authTag = cipher.getAuthTag();

  // 格式：iv:authTag:ciphertext，全部 base64 编码
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString('base64');
}

/**
 * 解密密文
 *
 * @param {string} encryptedText - base64 编码的密文（encrypt() 的输出）
 * @returns {string} 解密后的明文
 * @throws {Error} 密文格式错误、认证失败、密钥不匹配
 */
function decrypt(encryptedText) {
  if (typeof encryptedText !== 'string') {
    throw new Error('decrypt() expects a string input');
  }

  const keyBuf = _getKeyBuffer();
  const combined = Buffer.from(encryptedText, 'base64');

  // 验证最小长度：IV(12) + authTag(16) = 28 字节
  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted text: too short');
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuf, iv);
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
  } catch (err) {
    throw new Error(`Decryption failed: ${err.message}. The key may be wrong or data is corrupted.`);
  }

  return decrypted.toString('utf8');
}

/**
 * 对 API Key 进行脱敏处理（仅用于前端回显，不存储）
 *
 * @param {string} apiKey - 原始 API Key
 * @returns {string} 脱敏后的字符串，如 "sk-abc1...wxyz"
 * @example
 *   maskKey('sk-abcdefghijklmnopqrstuvwxyz1234')  // 'sk-abc...1234'
 *   maskKey('short')                               // '***'
 */
function maskKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length <= 8) {
    return '***';
  }
  return apiKey.slice(0, 6) + '...' + apiKey.slice(-4);
}

module.exports = { encrypt, decrypt, maskKey };
