const BASE_URL = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const API_KEY = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || '';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

export const llmConfigured = () => API_KEY.length > 0;

/**
 * OpenAI 兼容的 Chat Completions 调用（DeepSeek / Kimi / GLM / 通义均可）。
 * 返回 { content, tool_calls }
 */
export async function chatLLM(messages, tools, opts = {}) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      tools,
      temperature: 0.3,
      max_tokens: 2048,
      ...opts,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM API ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message ?? {};
  return {
    content: msg.content || '',
    tool_calls: Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : null,
  };
}
