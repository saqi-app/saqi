#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const endpoint =
  process.env.SAQI_RIG_ENDPOINT ?? "https://ops.saqi.app/api/rig/state";
const model = process.env.SAQI_RIG_MODEL ?? "gpt-5.6-sol";
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
  );
const schemaPath = new URL(
  "./rig-publication-output.schema.json",
  import.meta.url,
).pathname;

function outputPath(attemptId) {
  return join(tmpdir(), `saqi-rig-${attemptId}.json`);
}

async function request(body) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
      Origin: new URL(endpoint).origin,
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Rig API ${response.status}: ${text.slice(0, 300)}`);
  }
  const result = await response.json();
  if (!result?.ok) throw new Error("Rig API returned an invalid response");
  return result;
}

async function current() {
  const response = await fetch(endpoint, {
    headers: {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
  });
  if (!response.ok) throw new Error(`Rig API GET ${response.status}`);
  const result = await response.json();
  if (!result?.ok) throw new Error("Rig API returned an invalid state");
  return result.state;
}

async function readOutput(attemptId) {
  const path = outputPath(attemptId);
  let size;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (size < 1 || size > 1_048_576)
    throw new Error(`Invalid Codex output size for ${attemptId}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function recover(state) {
  const checkpoint = JSON.parse(state.checkpointJson ?? "{}");
  const attemptId = checkpoint.invocation?.attemptId;
  if (!attemptId) throw new Error("Active invocation has no attempt ID");
  const output = await readOutput(attemptId);
  if (output) {
    const acknowledged = await request({
      action: "acknowledge",
      poemId: state.poemId,
      attemptId,
      expectedVersion: state.version,
      output,
    });
    await publish(acknowledged.state);
    await unlink(outputPath(attemptId)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  }
  if (
    state.status === "dispatching" &&
    state.leaseExpiresAt !== null &&
    state.leaseExpiresAt <= Math.floor(Date.now() / 1000)
  ) {
    await request({ action: "mark-unknown", poemId: state.poemId });
  }
  throw new Error(
    `Codex attempt ${attemptId} has no durable result; inspect it before an explicit retry`,
  );
}

async function publish(state) {
  if (state?.status !== "claimed")
    throw new Error("Publication requires an acknowledged result");
  const result = await request({
    action: "publish",
    poemId: state.poemId,
    expectedVersion: state.version,
  });
  process.stdout.write(
    `Published ${state.poemId}${result.cachePending ? " (cache purge pending)" : ""}\n`,
  );
}

function promptFor(poem) {
  return [
    "Translate this Arabic poem into English and write concise, source-grounded insights.",
    "Output one English line for each Arabic line, in exactly the same order.",
    "Keep names and imagery faithful. Do not invent historical facts or cite sources you did not read.",
    "Every insight field and array must be nonempty. notableLines must quote actual Arabic lines.",
    "Return only the JSON object required by the supplied schema.",
    `Author: ${poem.authorName}`,
    `Title: ${poem.titleArabic}`,
    "Arabic lines:",
    ...poem.linesArabic.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

async function runCodex(prompt, attemptId) {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--json",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath(attemptId),
    "-c",
    'approval_policy="never"',
    "-c",
    'web_search="disabled"',
    "--disable",
    "multi_agent",
    "--disable",
    "shell_tool",
    "--disable",
    "standalone_web_search",
    "--disable",
    "apps",
    "-",
  ];
  const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
  let outputBytes = 0;
  let diagnostic = "";
  const capture = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 2_097_152) child.kill("SIGTERM");
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", (chunk) => {
    capture(chunk);
    if (diagnostic.length < 1_000)
      diagnostic += chunk.toString("utf8").slice(0, 1_000 - diagnostic.length);
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (exitCode !== 0)
    throw new Error(`Codex exited ${exitCode}: ${diagnostic.trim()}`);
  const output = await readOutput(attemptId);
  if (!output) throw new Error("Codex completed without a final output");
  return output;
}

async function main() {
  if (process.argv[2] === "retry-unknown") {
    const [poemId, attemptId] = process.argv.slice(3);
    if (!poemId || !attemptId || process.argv.length !== 5)
      throw new Error("Usage: rig-lite.mjs retry-unknown POEM_ID ATTEMPT_ID");
    const state = await current();
    const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
    if (
      state?.poemId !== poemId ||
      state.status !== "unknown" ||
      checkpoint.invocation?.attemptId !== attemptId
    )
      throw new Error("The current unknown attempt does not match");
    if (await readOutput(attemptId))
      throw new Error(
        "A recoverable Codex result exists; run the rig normally",
      );
    await request({
      action: "retry-unknown",
      poemId,
      attemptId,
      expectedVersion: state.version,
    });
    process.stdout.write(`Manual retry authorized for ${poemId}\n`);
    return;
  }
  if (process.argv.length > 2)
    throw new Error("Usage: rig-lite.mjs [retry-unknown POEM_ID ATTEMPT_ID]");
  if (process.env.SAQI_RIG_ACTIVE !== "1")
    throw new Error(
      "Rig inactive: complete publication parity and set SAQI_RIG_ACTIVE=1",
    );
  await request({ action: "purge-cache" });
  const active = await current();
  if (active?.status === "dispatching" || active?.status === "unknown") {
    await recover(active);
    return;
  }
  if (active?.status === "claimed") {
    const checkpoint = JSON.parse(active.checkpointJson ?? "{}");
    if (checkpoint.outputs?.generation) {
      await publish(active);
      return;
    }
  }
  const token = randomUUID();
  const claim = (await request({ action: "claim-poem", token })).state;
  if (!claim) {
    process.stdout.write("No poem ready; a prior claim may still be live.\n");
    return;
  }
  const source = (
    await request({
      action: "source",
      poemId: claim.poemId,
      token,
    })
  ).poem;
  const prompt = promptFor(source);
  const attemptId = randomUUID();
  const inputHash = createHash("sha256").update(prompt).digest("hex");
  const dispatched = await request({
    action: "dispatch",
    poemId: claim.poemId,
    token,
    expectedVersion: claim.version,
    attemptId,
    inputHash,
    model,
  });
  const output = await runCodex(prompt, attemptId);
  const acknowledged = await request({
    action: "acknowledge",
    poemId: claim.poemId,
    attemptId,
    expectedVersion: dispatched.state.version,
    output,
  });
  await publish(acknowledged.state);
  await unlink(outputPath(attemptId));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
