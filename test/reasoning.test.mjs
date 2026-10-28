import test from "node:test";
import assert from "node:assert/strict";

import {
  aggregateChatSSE,
  responsesObjectToChatResponse,
  reasoningText,
} from "../server.mjs";

test("aggregateChatSSE accepts the reasoning field (not only reasoning_content)", () => {
  const raw = [
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { reasoning: "think" } }] })}`,
    `data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
  ].join("\n");
  const out = aggregateChatSSE(raw);
  assert.equal(out.choices[0].message.reasoning_content, "think");
  assert.equal(out.choices[0].message.content, "hi");
});

test("reasoningText normalizes the known upstream field names", () => {
  assert.equal(reasoningText({ reasoning_content: "a" }), "a");
  assert.equal(reasoningText({ reasoning: "b" }), "b");
  assert.equal(reasoningText({ reasoning_text: "c" }), "c");
  assert.equal(reasoningText({ content: "x" }), "");
});

test("responsesObjectToChatResponse reads reasoning summary and content", () => {
  const out = responsesObjectToChatResponse(
    {
      id: "r",
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "S" }], content: [{ type: "reasoning_text", text: "C" }] },
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ],
    },
    "m",
  );
  assert.match(out.choices[0].message.reasoning_content, /S/);
  assert.match(out.choices[0].message.reasoning_content, /C/);
});
