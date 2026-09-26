import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

for (const [code, status, completes] of [
  ["UNMAPPED_POEM_COLLISION", 409, true],
  ["SOURCE_CHANGED", 409, false],
  ["SOURCE_WRITE_UNAVAILABLE", 503, false],
]) {
  test(`collector handles ${code} without losing queue progress`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "saqi-collect-test-"));
    const actions = [];
    const server = createServer(async (request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify({ ok: true, poem: null }));
        return;
      }
      const body = JSON.parse(
        Buffer.concat(await Array.fromAsync(request)).toString(),
      );
      actions.push(body.action);
      if (body.action === "upsert-poem" && body.poem.sourcePoemId === "1") {
        response.writeHead(status);
        response.end(JSON.stringify({ ok: false, code }));
        return;
      }
      response.end(JSON.stringify({ ok: true, result: { status: "created" } }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const collector = join(
        directory,
        "packages/source-collector/dist/collection",
      );
      const adapter = join(
        directory,
        "packages/source-collector/dist/source-adapter",
      );
      await mkdir(collector, { recursive: true });
      await mkdir(adapter, { recursive: true });
      await mkdir(join(directory, "scripts"));
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      await copyFile(
        new URL("rig-collect.mjs", import.meta.url),
        join(directory, "scripts/rig-collect.mjs"),
      );
      await writeFile(
        join(adapter, "index.js"),
        `
        export const configureSource = () => {};
        export const canonicalAuthorUrl = href => ({href,slug:'author',canonicalId:'author'});
        export const parseAuthorPoemManifest = value => value;
        export const parsePoemDetail = value => value;
      `,
      );
      await writeFile(
        join(collector, "collection-source-browser.js"),
        `
        export class SourceChromeCollector {
          static async create() { return new SourceChromeCollector(); }
          async collectAuthorManifest() { return {author:{canonicalId:'author'},poems:[1,2].map(id=>({numericId:String(id),canonicalId:'p'+id,href:'https://source.invalid/poem'+id}))}; }
          async collectPoemDetail(href) { return {canonicalId:'p'+href.slice(-1),href,title:'قصيدة',lines:['بيت']}; }
          async close() {}
        }
      `,
      );
      const child = spawn(
        process.execPath,
        [
          join(directory, "scripts/rig-collect.mjs"),
          "author",
          "https://source.invalid/author",
          "شاعر",
        ],
        {
          env: {
            ...process.env,
            CF_ACCESS_CLIENT_ID: "test",
            CF_ACCESS_CLIENT_SECRET: "test",
            SAQI_RIG_ACTIVE: "1",
            SAQI_SOURCE_ORIGIN: "https://source.invalid",
            SAQI_SOURCE_ENDPOINT: `http://127.0.0.1:${server.address().port}/source`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const [exitCode] = await once(child, "close");
      assert.equal(exitCode, completes ? 0 : 1, output);
      assert.deepEqual(
        actions,
        completes
          ? ["upsert-author", "upsert-poem", "upsert-poem", "complete-author"]
          : ["upsert-author", "upsert-poem"],
      );
      if (completes)
        assert.match(output, /identity review required; not imported/u);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
