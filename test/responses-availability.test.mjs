import test from "node:test";
import assert from "node:assert/strict";

import { app, setApiKeys, MODELS } from "../server.mjs";

const KEY = "oc-test-key";
setApiKeys({ test: KEY });
MODELS.length = 0;
MODELS.push("mimo-v2.6-flash-free", "flint-40b-free");

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

test("Spark model with no free Spark available returns 503 no_free_spark", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "muse-spark-1.3-contributor-free", input: "hi" }),
    });
    assert.equal(res.status, 503);
    const json = await res.json();
    assert.equal(json.error.code, "no_free_spark");
    assert.match(json.error.message, /\/v1\/chat\/completions/);
  });
});

test("health reports whether a free Spark model is available", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.responses_available, false);
  });
});
