import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  zenResponsesRequest,
  responsesObjectToChatResponse,
} from "../server.mjs";

// Digest rename (oc2api shape.Renames parity, Appendix H.3): the upstream name
// is `oc2api_<sha256(name)[:12]>` — no readable client vocabulary may leak.
const digestOf = (name) => "oc2api_" + crypto.createHash("sha256").update(name).digest("hex").slice(0, 12);

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
  const renamed = digestOf("my.tool");
  assert.ok(names.includes(renamed), `expected digest rename ${renamed}`);
  assert.ok(!names.includes("my.tool"));
  // No readable client vocabulary may leak into the tool table (H.3).
  assert.ok(!names.some((n) => n.includes("my.tool") || n.includes("my_tool")), "readable rename leaked");
  assert.ok(names.includes("read"), "official compat tool should be present");
  assert.equal(renames.reverse.get(renamed), "my.tool");
});

test("Spark sync response restores client tool names and drops official calls", () => {
  const renamed = digestOf("my.tool");
  const renames = { forward: new Map([["my.tool", renamed]]), reverse: new Map([[renamed, "my.tool"]]) };
  const out = responsesObjectToChatResponse(
    {
      id: "resp_1",
      status: "completed",
      output: [
        { type: "function_call", name: renamed, arguments: '{"x":1}', call_id: "call_1" },
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
