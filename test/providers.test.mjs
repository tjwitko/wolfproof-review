import assert from "node:assert/strict";
import test from "node:test";

import { adapter, send, errorMessage, redactKey, ProviderError } from "../plugins/wolfproof-review/scripts/providers.mjs";
import { TOOLS } from "../plugins/wolfproof-review/scripts/agent.mjs";

const json = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test("adapter: defaults, required model, https only", () => {
  assert.equal(adapter({ provider: "anthropic", apiKey: "k" }).model, "claude-sonnet-5-5");
  assert.throws(() => adapter({ provider: "openai", apiKey: "k" }), /needs a model/);
  assert.throws(() => adapter({ provider: "gemini", apiKey: "k", model: "m" }), /unknown provider/);
  assert.throws(() => adapter({ provider: "anthropic", apiKey: "" }), /no API key/);
  assert.throws(() => adapter({ provider: "openai", apiKey: "k", model: "m", baseUrl: "http://gateway.example/v1" }), /https/);
  assert.equal(adapter({ provider: "openai", apiKey: "k", model: "m", baseUrl: "https://gw.example/v1/" }).request([], []).url, "https://gw.example/v1/chat/completions");
});

test("anthropic: request shape, tool calls back, results as tool_result blocks", () => {
  const a = adapter({ provider: "anthropic", apiKey: "sk-test", model: "claude-sonnet-5-5" });
  const req = a.request(a.initial("hi"), TOOLS);
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  assert.equal(req.headers["x-api-key"], "sk-test");
  assert.equal(req.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(req.body.messages, [{ role: "user", content: "hi" }]);
  assert.deepEqual(req.body.tools.map((t) => Object.keys(t)), TOOLS.map(() => ["name", "description", "input_schema"]));
  const r = a.parse({
    content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "tu1", name: "read_file", input: { path: "pr-head/a.py" } }],
    usage: { input_tokens: 10, output_tokens: 3 },
    stop_reason: "tool_use",
  });
  assert.deepEqual(r.toolCalls, [{ id: "tu1", name: "read_file", input: { path: "pr-head/a.py" } }]);
  assert.deepEqual(r.usage, { input: 10, output: 3 });
  assert.equal(r.assistant.content.length, 2);
  assert.deepEqual(a.results([{ id: "tu1", content: "x", isError: false }, { id: "tu2", content: "no", isError: true }]), [
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "x" }, { type: "tool_result", tool_use_id: "tu2", content: "no", is_error: true }] },
  ]);
});

test("openai: request shape, tool calls with JSON arguments, results as tool messages", () => {
  const a = adapter({ provider: "openai", apiKey: "sk-o", model: "gpt-5.1" });
  const req = a.request(a.initial("hi"), TOOLS);
  assert.equal(req.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(req.headers.authorization, "Bearer sk-o");
  assert.equal(req.body.max_completion_tokens, 32768);
  assert.deepEqual(req.body.tools[0], { type: "function", function: { name: TOOLS[0].name, description: TOOLS[0].description, parameters: TOOLS[0].schema } });
  const calls = [
    { id: "c1", type: "function", function: { name: "grep", arguments: '{"pattern":"execute"}' } },
    { id: "c2", type: "function", function: { name: "glob", arguments: "{not json" } },
  ];
  const r = a.parse({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 7, completion_tokens: 2 } });
  assert.deepEqual(r.toolCalls[0], { id: "c1", name: "grep", input: { pattern: "execute" }, inputError: null });
  assert.match(r.toolCalls[1].inputError, /not valid JSON/);
  assert.deepEqual(r.assistant, { role: "assistant", content: null, tool_calls: calls });
  assert.deepEqual(r.usage, { input: 7, output: 2 });
  assert.deepEqual(a.results([{ id: "c1", content: "ok", isError: false }, { id: "c2", content: "bad", isError: true }]), [
    { role: "tool", tool_call_id: "c1", content: "ok" },
    { role: "tool", tool_call_id: "c2", content: "Error: bad" },
  ]);
  const done = a.parse({ choices: [{ message: { content: "2 comments" }, finish_reason: "stop" }] });
  assert.deepEqual(done.toolCalls, []);
  assert.deepEqual(done.assistant, { role: "assistant", content: "2 comments" });
});

test("send retries a rate limit and overload, honouring retry-after, then succeeds", async () => {
  const a = adapter({ provider: "anthropic", apiKey: "k" });
  const replies = [json(429, { error: { message: "slow down" } }, { "retry-after": "3" }), json(529, { error: { message: "overloaded" } }), json(200, { content: [], usage: {} })];
  const waits = [];
  const r = await send(a, a.initial("x"), TOOLS, { fetchImpl: async () => replies.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(waits, [3000, 4000]);
});

test("send reports a billing error with the provider's message and no retry", async () => {
  const a = adapter({ provider: "anthropic", apiKey: "secret-key-value" });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return json(400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  };
  await assert.rejects(send(a, a.initial("x"), TOOLS, { fetchImpl, sleep: async () => {} }), (err) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.status, 400);
    assert.match(err.message, /anthropic answered 400: Your credit balance is too low/);
    assert.doesNotMatch(err.message, /secret-key-value/);
    return true;
  });
  assert.equal(calls, 1);
});

test("send gives up after the retries on network errors", async () => {
  const a = adapter({ provider: "openai", apiKey: "k", model: "m" });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    throw Object.assign(new Error("boom"), { name: "TypeError" });
  };
  await assert.rejects(send(a, a.initial("x"), TOOLS, { fetchImpl, sleep: async () => {}, retries: 2 }), /request to openai failed/);
  assert.equal(calls, 3);
});

test("errorMessage reads both providers' error bodies", () => {
  assert.equal(errorMessage('{"error":{"message":"bad key"}}'), "bad key");
  assert.equal(errorMessage('{"error":"nope"}'), "nope");
  assert.equal(errorMessage("<html>502</html>"), "<html>502</html>");
  assert.equal(errorMessage(""), "no response body");
});

test("send never follows a redirect, so a gateway cannot pass the key on", async () => {
  const a = adapter({ provider: "anthropic", apiKey: "k" });
  let init;
  await send(a, a.initial("x"), TOOLS, { fetchImpl: async (u, i) => ((init = i), json(200, { content: [] })) });
  assert.equal(init.redirect, "error");
});

test("a rejected key gets a fixed message, and no error carries the key", async () => {
  // Built at runtime, so the secret scanners do not take the made-up key for a real one.
  const key = ["sk", "proj", "0123456789abcdef" + "WXYZ"].join("-");
  const a = adapter({ provider: "openai", apiKey: key, model: "m" });
  const fail = (status, message) => send(a, a.initial("x"), TOOLS, { fetchImpl: async () => json(status, { error: { message } }), sleep: async () => {}, retries: 0 });
  await assert.rejects(fail(401, `Incorrect API key provided: ${key.slice(0, 3)}************${key.slice(-4)}.`), (err) => {
    assert.equal(err.message, "openai rejected the API key (401)");
    return true;
  });
  await assert.rejects(fail(403, "forbidden"), /rejected the API key \(403\)/);
  await assert.rejects(fail(400, `bad request for key ${key} and ${key.slice(4, 20)}`), (err) => {
    assert.doesNotMatch(err.message, /0123456789|abcdef|WXYZ/);
    assert.match(err.message, /openai answered 400: bad request for key \[redacted\] and \[redacted\]/);
    return true;
  });
});

test("redactKey removes the key and any long piece of it, and leaves other text", () => {
  assert.equal(redactKey("key=sk-abcdefghijkl end", "sk-abcdefghijkl"), "key=[redacted] end");
  assert.equal(redactKey("tail ghijkl..., head sk-abcd", "sk-abcdefghijkl"), "tail ghijkl..., head sk-abcd");
  assert.equal(redactKey("head sk-abcde", "sk-abcdefghijkl"), "head [redacted]");
  assert.equal(redactKey("piece cdefghij here", "sk-abcdefghijkl"), "piece [redacted] here");
  assert.equal(redactKey("nothing", ""), "nothing");
  assert.equal(redactKey("max_tokens", "k"), "max_tokens");
  assert.equal(redactKey("a short abc12 key", "abc12"), "a short [redacted] key");
});
