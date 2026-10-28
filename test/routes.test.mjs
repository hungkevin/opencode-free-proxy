import test from "node:test";
import assert from "node:assert/strict";

import { app, setApiKeys, MODELS } from "../server.mjs";

const KEY = "oc-test-key";
setApiKeys({ test: KEY });
MODELS.length = 0;
MODELS.push("mimo-v2.6-flash-free");

async function withServer(fn) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
}

test("malformed /v1/messages body returns 400 and does not crash the process", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/messages", {
      model: "mimo-v2.6-flash-free",
      max_tokens: 16,
      messages: {},
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error.message, /messages/i);
  });
});

test("null JSON body on every route returns 400 instead of throwing", async () => {
  await withServer(async (base) => {
    for (const path of ["/v1/chat/completions", "/v1/responses", "/v1/messages"]) {
      const res = await post(base, path, null);
      assert.equal(res.status, 400, path);
    }
  });
});

test("unknown model on /v1/messages returns Anthropic-shaped 400", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/v1/messages", {
      model: "does-not-exist",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.type, "error");
    assert.match(json.error.message, /Unknown model/);
  });
});
