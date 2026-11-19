// The model APIs the GitHub review can call, as plain HTTPS requests: Anthropic's Messages API and
// any OpenAI-compatible chat completions endpoint (OpenAI, Azure OpenAI, OpenRouter, vLLM, Ollama).
// Each adapter turns the loop's messages and tools into its API's shape and back. No SDKs, no
// dependencies. The loop itself, and the tools, are in agent.mjs.

const DEFAULTS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  openai: { baseUrl: "https://api.openai.com/v1", model: null },
};
export const PROVIDER_NAMES = Object.keys(DEFAULTS);
const MAX_TOKENS = 16000;
// OpenAI's cap also counts a reasoning model's hidden reasoning, so it needs room for that as well as
// the reply; a turn that runs out stops with "length", which fails the review. Billing is per token
// used, not per token allowed.
const OPENAI_MAX_TOKENS = 32768;

export class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * An adapter for one provider.
 * @param {{provider: string, apiKey: string, model?: string, baseUrl?: string}} o
 */
export function adapter({ provider, apiKey, model, baseUrl }) {
  const d = DEFAULTS[provider];
  if (!d) throw new ProviderError(`unknown provider "${provider}"; use ${PROVIDER_NAMES.join(" or ")}`);
  if (!apiKey) throw new ProviderError("no API key");
  const m = model || d.model;
  if (!m) throw new ProviderError(`the ${provider} provider needs a model`);
  const base = (baseUrl || d.baseUrl).replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/]+/.test(base)) throw new ProviderError("base-url must be an https:// URL");
  const a = provider === "anthropic" ? anthropic(apiKey, m, base) : openai(apiKey, m, base);
  // An error message goes to run.json and the public summary, so the key, or any long piece of it,
  // never does.
  a.redact = (text) => redactKey(text, apiKey);
  return a;
}

function anthropic(apiKey, model, base) {
  return {
    provider: "anthropic",
    model,
    initial: (prompt) => [{ role: "user", content: prompt }],
    request: (messages, tools) => ({
      url: `${base}/v1/messages`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: {
        model,
        max_tokens: MAX_TOKENS,
        // Automatic prompt caching: the breakpoint moves to the end of the conversation each turn, so
        // every turn reads the turns before it from the cache instead of paying for them again.
        cache_control: { type: "ephemeral" },
        messages,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
      },
    }),
    parse(json) {
      const content = Array.isArray(json?.content) ? json.content : [];
      return {
        assistant: { role: "assistant", content },
        toolCalls: content.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} })),
        // input_tokens is only the part not read from or written to the cache.
        usage: {
          input: json?.usage?.input_tokens || 0,
          cacheRead: json?.usage?.cache_read_input_tokens || 0,
          cacheWrite: json?.usage?.cache_creation_input_tokens || 0,
          output: json?.usage?.output_tokens || 0,
        },
        stop: json?.stop_reason || null,
      };
    },
    results: (results) => [
      {
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
      },
    ],
  };
}

function openai(apiKey, model, base) {
  return {
    provider: "openai",
    model,
    initial: (prompt) => [{ role: "user", content: prompt }],
    request: (messages, tools) => ({
      url: `${base}/chat/completions`,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: {
        model,
        max_completion_tokens: OPENAI_MAX_TOKENS,
        messages,
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
      },
    }),
    parse(json) {
      const choice = json?.choices?.[0] || {};
      const msg = choice.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      return {
        assistant: { role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) },
        toolCalls: calls.map((c) => {
          let input;
          let inputError = null;
          try {
            input = JSON.parse(c.function?.arguments || "{}");
          } catch {
            inputError = "the arguments are not valid JSON";
          }
          return { id: c.id, name: c.function?.name, input, inputError };
        }),
        // prompt_tokens includes the cached part, which OpenAI caches on its own; split it out so the
        // fields mean the same as Anthropic's.
        usage: openaiUsage(json?.usage),
        stop: choice.finish_reason || null,
      };
    },
    // Chat completions has no error flag on a tool result, so an error says so in its text.
    results: (results) => results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.isError ? `Error: ${r.content}` : r.content })),
  };
}

function openaiUsage(u) {
  const prompt = u?.prompt_tokens || 0;
  const cached = Math.min(u?.prompt_tokens_details?.cached_tokens || 0, prompt);
  return { input: prompt - cached, cacheRead: cached, cacheWrite: 0, output: u?.completion_tokens || 0 };
}

/** The text with the key, and every run of 8 or more characters taken from it, replaced. */
export function redactKey(text, key) {
  const t = String(text).slice(0, 2000);
  // Real keys are far longer; a very short one would match ordinary words.
  if (!key || key.length < 4) return t;
  if (key.length < 8) return t.split(key).join("[redacted]");
  const n = 8;
  const hit = new Array(t.length).fill(false);
  for (let i = 0; i + n <= t.length; i++) if (key.includes(t.slice(i, i + n))) hit.fill(true, i, i + n);
  let out = "";
  for (let i = 0; i < t.length; i++) {
    if (!hit[i]) out += t[i];
    else if (i === 0 || !hit[i - 1]) out += "[redacted]";
  }
  return out;
}

const RETRY = (status) => status === 408 || status === 409 || status === 429 || status >= 500;

/** The error message a provider put in its response body, else the start of the body. */
export function errorMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || (typeof j?.error === "string" ? j.error : null);
    if (m) return String(m);
  } catch {
    /* not JSON */
  }
  return String(text || "").slice(0, 300) || "no response body";
}

/**
 * One model turn, with retries on rate limits, overload and server errors.
 * @returns {Promise<{assistant: object, toolCalls: Array<{id, name, input, inputError?}>, usage: {input, cacheRead, cacheWrite, output}, stop: string|null}>}
 */
export async function send(a, messages, tools, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 3, timeoutMs = 120000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { url, headers, body } = a.request(messages, tools);
    let res;
    try {
      // No redirects: fetch drops Authorization on a cross-origin redirect but keeps x-api-key, so a
      // redirecting base-url would pass the key on.
      res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt < retries) {
        await sleep(backoff(attempt));
        continue;
      }
      throw new ProviderError(`the request to ${a.provider} failed (${err.name === "TimeoutError" ? "timed out" : err.name || "network error"})`);
    }
    if (res.ok) {
      let json;
      try {
        json = await res.json();
      } catch {
        // A parse error quotes the body, which a gateway could fill with anything, the key included.
        throw new ProviderError(`${a.provider}'s response was not valid JSON`, res.status);
      }
      return a.parse(json);
    }
    // A 401 or 403 body can echo part of the key ("Incorrect API key provided: sk-…abcd").
    if (res.status === 401 || res.status === 403) throw new ProviderError(`${a.provider} rejected the API key (${res.status})`, res.status);
    const message = (a.redact || String)(errorMessage(await res.text()));
    if (RETRY(res.status) && attempt < retries) {
      const after = Number(res.headers?.get?.("retry-after"));
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : backoff(attempt));
      continue;
    }
    throw new ProviderError(`${a.provider} answered ${res.status}: ${message}`, res.status);
  }
}

const backoff = (attempt) => 2000 * 2 ** attempt;
