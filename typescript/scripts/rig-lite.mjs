import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { arabicWords } from "../packages/precedent-iso/dist/word-glosses.js";
import { generationSchema, normalizeWordMeanings } from "./rig-output.mjs";

const endpoint =
  process.env.SAQI_RIG_ENDPOINT ?? "https://ops.saqi.app/api/rig/state";
const model = process.env.SAQI_RIG_MODEL ?? "gpt-6.1-sol";
const reasoningEffort = "xhigh";
const clientId = process.env.CF_ACCESS_CLIENT_ID;
const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    "CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET are required",
  );
const schemaPath = new URL(
  "rig-publication-output.schema.json",
  import.meta.url,
).pathname;

async function main() {
  if (process.argv[2] === "retry-unknown") return retryUnknown();
  if (process.argv.length > 3)
    throw new Error(
      "Usage: rig-lite.mjs [POEM_ID | retry-unknown POEM_ID ATTEMPT_ID]",
    );
  return translateNext(process.argv[2]);
}

export async function translateNext(
  preferredPoemId,
  {
    maxConcurrent = 1,
    deferCachePurge = false,
    ownedPoemId,
    remember = async () => {
      /* The standalone runner recovers from canonical D1 state. */
    },
    generate = runCodex,
  } = {},
) {
  if (process.env.SAQI_RIG_ACTIVE !== "1")
    throw new Error(
      "Rig inactive: complete publication parity and set SAQI_RIG_ACTIVE=1",
    );
  if (!deferCachePurge) await purgeCache();
  const active =
    maxConcurrent === 1 || ownedPoemId ? await current(ownedPoemId) : null;
  if (active?.status === "dispatching") {
    await recover(active, deferCachePurge);
    await remember(null);
    return;
  }
  if (active?.status === "unknown") {
    if (await recoverIfResultExists(active, deferCachePurge)) {
      await remember(null);
      return;
    }
  }
  if (active?.status === "claimed") {
    const checkpoint = JSON.parse(active.checkpointJson ?? "{}");
    if (checkpoint.outputs?.generation) {
      await publish(active, deferCachePurge);
      await remember(null);
      return;
    }
  }
  const token = randomUUID();
  await remember(null);
  const claimRequest = { action: "claim-poem", token };
  if (maxConcurrent > 1) claimRequest.maxConcurrent = maxConcurrent;
  const targeted =
    preferredPoemId ??
    (active?.status === "claimed" ? active.poemId : undefined);
  if (targeted) claimRequest.poemId = targeted;
  const claimResponse = await request(claimRequest);
  const claim = claimResponse.state;
  if (!claim) {
    process.stdout.write("No poem ready; a prior claim may still be live.\n");
    return;
  }
  await remember(claim.poemId);
  const sourceResponse = await request({
    action: "source",
    poemId: claim.poemId,
    token,
  });
  const source = sourceResponse.poem;
  const prompt = promptFor(source);
  const attemptId = randomUUID();
  const inputHash = createHash("sha256").update(prompt).digest("hex");
  process.stdout.write(
    `Model: ${model}; reasoning: ${reasoningEffort}; fields: ${(source.required ?? ["translation", "wordMeanings"]).join(", ")}\n`,
  );
  const dispatched = await request({
    action: "dispatch",
    poemId: claim.poemId,
    token,
    expectedVersion: claim.version,
    attemptId,
    inputHash,
    model,
    reasoningEffort,
  });
  process.stdout.write(
    `Translating ${claim.poemId}: ${source.linesArabic.length} Arabic lines (${model})\n`,
  );
  const output = await generate(
    prompt,
    attemptId,
    source.linesArabic,
    source.required,
  );
  const acknowledged = await request({
    action: "acknowledge",
    poemId: claim.poemId,
    attemptId,
    expectedVersion: dispatched.state.version,
    output,
  });
  await removeOutput(attemptId);
  await publish(acknowledged.state, deferCachePurge);
  await remember(null);
}

async function retryUnknown() {
  const [poemId, attemptId] = process.argv.slice(3);
  if (!poemId || !attemptId || process.argv.length !== 5)
    throw new Error("Usage: rig-lite.mjs retry-unknown POEM_ID ATTEMPT_ID");
  const state = await current(poemId);
  const checkpoint = JSON.parse(state?.checkpointJson ?? "{}");
  if (
    state?.poemId !== poemId ||
    state.status !== "unknown" ||
    checkpoint.invocation?.attemptId !== attemptId
  )
    throw new Error("The current unknown attempt does not match");
  if (await readOutput(attemptId))
    throw new Error("A recoverable Codex result exists; run the rig normally");
  await request({
    action: "retry-unknown",
    poemId,
    attemptId,
    expectedVersion: state.version,
  });
  await removeOutput(attemptId);
  process.stdout.write(`Manual retry authorized for ${poemId}\n`);
}

const resultDirectory =
  process.env.SAQI_RIG_RESULT_DIR ??
  join(homedir(), "Library", "Application Support", "Saqi", "results");
function outputPath(attemptId) {
  return join(resultDirectory, `saqi-rig-${attemptId}.json`);
}
function outputPaths(attemptId) {
  return [outputPath(attemptId), join(tmpdir(), `saqi-rig-${attemptId}.json`)];
}
async function removeOutput(attemptId) {
  await Promise.all(
    outputPaths(attemptId).map((path) =>
      unlink(path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
}

export async function purgeCache() {
  return request({ action: "purge-cache" });
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Rig API ${response.status}: ${text.slice(0, 300)}`);
  }
  const result = await response.json();
  if (!result?.ok) throw new Error("Rig API returned an invalid response");
  return result;
}

async function current(poemId) {
  const url = new URL(endpoint);
  if (poemId) url.searchParams.set("poemId", poemId);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
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
  const [durable, legacy] = outputPaths(attemptId);
  return (
    (await readOutputFile(durable, attemptId)) ??
    readOutputFile(legacy, attemptId)
  );
}

async function readOutputFile(path, attemptId) {
  let size;
  try {
    const file = await stat(path);
    size = file.size;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (size === 0) return null;
  if (size > 1_048_576)
    throw new Error(`Invalid Codex output size for ${attemptId}`);
  return normalizeWordMeanings(JSON.parse(await readFile(path, "utf8")));
}

async function recover(state, deferCachePurge = false) {
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
    await removeOutput(attemptId);
    await publish(acknowledged.state, deferCachePurge);
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

async function recoverIfResultExists(state, deferCachePurge = false) {
  const attemptId = JSON.parse(state.checkpointJson ?? "{}").invocation
    ?.attemptId;
  if (!attemptId) throw new Error("Unknown invocation has no attempt ID");
  if (await readOutput(attemptId)) {
    await recover(state, deferCachePurge);
    return true;
  }
  process.stdout.write(
    `Codex attempt ${attemptId} remains unresolved; continuing with another poem.\n`,
  );
  return false;
}

async function publish(state, deferCachePurge = false) {
  if (state?.status !== "claimed")
    throw new Error("Publication requires an acknowledged result");
  const body = {
    action: "publish",
    poemId: state.poemId,
    expectedVersion: state.version,
  };
  if (deferCachePurge) body.deferCachePurge = true;
  const result = await request(body);
  process.stdout.write(
    `Published ${state.poemId}${result.cachePending ? " (cache purge pending)" : ""}\n`,
  );
}

function promptFor(poem) {
  const required = poem.required ?? ["translation", "wordMeanings"];
  return [
    `Generate only these missing fields: ${required.join(", ")}. Existing fields must not be regenerated.`,
    "For requested fields, translate this Arabic poem into English and provide concise word-by-word meanings.",
    "Output one English line for each Arabic line, in exactly the same order.",
    "Keep names and imagery faithful. Do not invent historical facts or cite sources you did not read.",
    "For wordMeanings, return the required line_1, line_2, etc. properties, each containing one concise English meaning per listed token in exactly the given order. Preserve attached conjunctions/pronouns in the meaning. Empty token lists require an empty array. Do not merge, skip, or add words.",
    "Return only the JSON object required by the supplied schema.",
    `Author: ${poem.authorName}`,
    `Title: ${poem.titleArabic}`,
    ...(required.includes("wordMeanings")
      ? [`Tokens by line: ${JSON.stringify(poem.linesArabic.map(arabicWords))}`]
      : []),
    "Arabic lines:",
    ...poem.linesArabic.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

async function runCodex(prompt, attemptId, lines, required) {
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  await writeFile(outputPath(attemptId), "", { mode: 0o600, flag: "wx" });
  const invocationSchema = join(tmpdir(), `saqi-schema-${attemptId}.json`);
  await writeFile(
    invocationSchema,
    JSON.stringify(
      generationSchema(
        JSON.parse(await readFile(schemaPath, "utf8")),
        lines,
        required,
      ),
    ),
    { mode: 0o600 },
  );
  try {
    return await runWithSchema(prompt, attemptId, invocationSchema);
  } finally {
    await unlink(invocationSchema);
  }
}

async function runWithSchema(prompt, attemptId, invocationSchema) {
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--model",
    model,
    "--json",
    "--output-schema",
    invocationSchema,
    "--output-last-message",
    outputPath(attemptId),
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-c",
    'service_tier="default"',
    "-c",
    'web_search="disabled"',
    "--disable",
    "fast_mode",
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
  let diagnostic = "";
  const events = createInterface({ input: child.stdout });
  events.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) {
        const usage = Object.fromEntries(
          [
            "input_tokens",
            "cached_input_tokens",
            "output_tokens",
            "reasoning_output_tokens",
          ].map((key) => [key, event.usage[key]]),
        );
        process.stdout.write(`Codex usage: ${JSON.stringify(usage)}\n`);
      }
    } catch {
      // Non-JSON diagnostics must never expose prompt or generated content.
    }
  });
  child.stderr.on("data", (chunk) => {
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
