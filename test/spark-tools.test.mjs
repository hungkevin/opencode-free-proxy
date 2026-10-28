import test from "node:test";
import assert from "node:assert/strict";

import {
  zenResponsesRequest,
  responsesObjectToChatResponse,
} from "../server.mjs";

test("Spark request renames client tools and keeps official compat tools", () => {
  const { body, renames } = zenResponsesRequest(
    {
      model: "muse-spark-test-free",
      input: "hi",
      tools: [
        {
          type: "function",
          name: "my.tool",
          description: "demo",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
    "session",
    { renameTools: true },
  );
  const parsed = JSON.parse(body);
  const names = parsed.tools.map((t) => t.name);
  assert.ok(names.includes("oc2api_my_tool"));
  assert.ok(!names.includes("my.tool"));
  assert.ok(names.includes("read"), "official compat tool should be present");
  assert.equal(renames.reverse.get("oc2api_my_tool"), "my.tool");
});

test("Spark sync response restores client tool names and drops official calls", () => {
  const renames = { forward: new Map([["my.tool", "oc2api_my_tool"]]), reverse: new Map([["oc2api_my_tool", "my.tool"]]) };
  const out = responsesObjectToChatResponse(
    {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "function_call", name: "oc2api_my_tool", arguments: '{"x":1}', call_id: "call_1" },
        { type: "function_call", name: "read", arguments: "{}", call_id: "call_2" },
      ],
    },
    "muse-spark-test-free",
    renames,
  );
  const calls = out.choices[0].message.tool_calls || [];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "my.tool");
  assert.equal(calls[0].id, "call_1");
});

test("Spark sync response with only official calls finishes with stop", () => {
  const out = responsesObjectToChatResponse(
    {
      id: "resp_2",
      status: "completed",
      output: [{ type: "function_call", name: "read", arguments: "{}", call_id: "call_2" }],
    },
    "muse-spark-test-free",
    { forward: new Map(), reverse: new Map() },
  );
  assert.equal(out.choices[0].message.tool_calls, undefined);
  assert.equal(out.choices[0].finish_reason, "stop");
});
