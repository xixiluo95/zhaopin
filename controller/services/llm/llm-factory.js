/**
 * llm-factory.js - LLM 工厂
 *
 * 根据 provider 配置动态实例化对应的 Provider。
 * 当前所有主流厂商（智谱AI、Kimi、OpenAI、Groq、DeepSeek、豆包、SiliconFlow）均走 OpenAI 兼容层。
 */

const { createOpenAIProvider } = require('./openai-compatible-provider');

/**
 * 根据 provider 创建 LLM 客户端
 *
 * @param {import('./llm-contracts').LLMConfig} config
 * @returns {{ chat: (messages: import('./llm-contracts').ChatMessage[]) => Promise<import('./llm-contracts').LLMResponse> }}
 */
function createLLMClient(config) {
    switch (config.provider) {
        case 'zhipu':
        case 'kimi':
        case 'openai':
        case 'groq':
        case 'deepseek':
        case 'doubao':
        case 'siliconflow':
        case 'custom':
            return createOpenAIProvider(config);
        default:
            throw new Error(`Unsupported provider: ${config.provider}`);
    }
}

/**
 * 从数据库获取当前激活的 AI 配置并创建客户端
 *
 * @param {import('better-sqlite3').Database} db - better-sqlite3 实例
 * @returns {{ chat: (messages: import('./llm-contracts').ChatMessage[]) => Promise<import('./llm-contracts').LLMResponse> } | null}
 */
function createActiveLLMClient(db) {
    const config = db.prepare(
        'SELECT * FROM ai_configs WHERE is_active = 1 ORDER BY updated_at DESC, id DESC LIMIT 1'
    ).get();

    if (!config) return null;

    // 解密 API Key
    const { decrypt } = require('../credential-crypto');
    const apiKey = decrypt(config.api_key_encrypted);

    return createLLMClient({
        provider: config.provider,
        apiKey,
        baseURL: config.base_url,
        model: config.model_name,
    });
}

module.exports = { createLLMClient, createActiveLLMClient };
