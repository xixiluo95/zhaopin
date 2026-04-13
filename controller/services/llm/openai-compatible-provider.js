/**
 * openai-compatible-provider.js - OpenAI 兼容 Provider
 *
 * 基于 OpenAI SDK 实现统一调用层，覆盖 90% AI 厂商。
 * 覆盖厂商：智谱AI、Kimi、OpenAI、Groq 等。
 *
 * 类型定义参考：./llm-contracts.js（LLMConfig, ChatMessage, LLMResponse）
 */

const OpenAI = require('openai');

/**
 * 创建 OpenAI 兼容 Provider 实例
 *
 * @param {import('./llm-contracts').LLMConfig} config - LLM 配置
 * @returns {{ chat, chatStream }}
 */
function createOpenAIProvider(config) {
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
    });

    function supportsNativeTools() {
        return true;
    }

    function normalizeMessages(messages) {
        return (messages || []).map((message) => {
            const normalized = {
                role: message.role,
            };
            if (message.content !== undefined) normalized.content = message.content;
            if (message.name !== undefined) normalized.name = message.name;
            if (message.tool_call_id !== undefined) normalized.tool_call_id = message.tool_call_id;
            return normalized;
        });
    }

    return {
        /**
         * 发送聊天请求（非流式）
         *
         * @param {import('./llm-contracts').ChatMessage[]} messages
         * @param {import('./llm-contracts').ChatOptions} [options]
         * @returns {Promise<import('./llm-contracts').LLMResponse>}
         */
        async chat(messages, options = {}) {
            try {
                const payload = {
                    model: config.model,
                    messages: normalizeMessages(messages),
                };
                if (Array.isArray(options.tools) && options.tools.length > 0) {
                    payload.tools = options.tools;
                    payload.tool_choice = options.toolChoice || 'auto';
                }

                const response = await client.chat.completions.create(payload);
                const choice = response.choices[0] || {};
                const message = choice.message || {};
                return {
                    content: message.content || '',
                    usage: response.usage,
                    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
                    finishReason: choice.finish_reason,
                };
            } catch (err) {
                if (options?.tools?.length) {
                    try {
                        const fallbackResponse = await client.chat.completions.create({
                            model: config.model,
                            messages: normalizeMessages(messages),
                        });
                        const choice = fallbackResponse.choices[0] || {};
                        const message = choice.message || {};
                        return {
                            content: message.content || '',
                            usage: fallbackResponse.usage,
                            toolCalls: [],
                            finishReason: choice.finish_reason,
                        };
                    } catch {
                        // ignore fallback error, return original err
                    }
                }
                return { content: '', error: err };
            }
        },

        /**
         * 流式聊天请求 — 逐 chunk 回调
         *
         * @param {import('./llm-contracts').ChatMessage[]} messages
         * @param {(chunk: string) => void} onChunk - 每收到一段内容时回调
         * @returns {Promise<import('./llm-contracts').LLMResponse>}
         */
        async chatStream(messages, onChunk) {
            let fullContent = '';
            let usage = null;
            try {
                const stream = await client.chat.completions.create({
                    model: config.model,
                    messages,
                    stream: true,
                });
                for await (const chunk of stream) {
                    const delta = chunk.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        fullContent += delta;
                        if (onChunk) onChunk(delta);
                    }
                    if (chunk.usage) usage = chunk.usage;
                }
                return { content: fullContent, usage };
            } catch (err) {
                return { content: fullContent || '', error: err };
            }
        },

        supportsNativeTools,
    };
}

module.exports = { createOpenAIProvider };
