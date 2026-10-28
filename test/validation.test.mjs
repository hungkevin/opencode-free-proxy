import test from "node:test";
import assert from "node:assert/strict";

import {
  anthropicToOpenAI,
  validateAnthropicBody,
  validateGenParams,
} from "../server.mjs";

test("validateAnthropicBody rejects non-array messages without throwing", () => {
  assert.match(validateAnthropicBody({ messages: {} }) || "", /messages/i);
});

test("validateAnthropicBody rejects empty messages", () => {
  assert.match(validateAnthropicBody({ messages: [] }) || "", /messages/i);
});

test("validateAnthropicBody rejects null message entries", () => {
  assert.match(validateAnthropicBody({ messages: [null] }) || "", /message/i);
});

test("anthropicToOpenAI returns an error for non-array messages", () => {
  const out = anthropicToOpenAI({ messages: {} });
  assert.equal(typeof out.error, "string");
  assert.equal(out.messages, undefined);
});

test("anthropicToOpenAI rejects unsupported content blocks", () => {
  const out = anthropicToOpenAI({
    messages: [{ role: "user", content: [{ type: "image", source: {} }] }],
  });
  assert.match(out.error || "", /Unsupported content block/i);
});

test("validateGenParams rejects invalid max_completion_tokens", () => {
  assert.match(validateGenParams({ max_completion_tokens: 0 }) || "", /max_completion_tokens/i);
  assert.match(validateGenParams({ max_completion_tokens: "8" }) || "", /max_completion_tokens/i);
  assert.equal(validateGenParams({ max_completion_tokens: 8 }), null);
});
