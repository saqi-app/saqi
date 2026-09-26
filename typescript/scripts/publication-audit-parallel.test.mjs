import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";

const script = new URL("publication-audit-parallel.mjs", import.meta.url);

test("four bounded lanes audit every range without a local corpus", async () => {
  const seen = [];
  const server = createServer(async (request, response) => {
    const chunks = await Array.fromAsync(request);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    const next = { "": "4a", "4": "8a", "8": "ca", c: "ff" }[body.afterId];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      afterId: next,
      complete: body.afterId === "c",
      scanned: 1,
      eligible: 1,
      shadowed: 1,
      skipped: [],
      mismatched: [],
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = server.address()?.port;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script.pathname], {
        env: {
          ...process.env,
          CF_ACCESS_CLIENT_ID: "test-id",
          CF_ACCESS_CLIENT_SECRET: "test-secret",
          SAQI_PROJECTION_ENDPOINT: `http://127.0.0.1:${port}/projection`,
          SAQI_PROJECTION_EXPECTED_PUBLICATIONS: "4",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(seen.map((item) => item.afterId).toSorted(), ["", "4", "8", "c"]);
    assert.ok(seen.every((item) => item.action === "audit"));
    assert.match(result.stdout, /"lanes":4,"scanned":4,"eligible":4,"shadowed":4/u);
    assert.doesNotMatch(result.stdout, /test-secret/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
