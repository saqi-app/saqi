#!/usr/bin/env node
/* global fetch, AbortSignal -- Node provides fetch and cancellation globally. */
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { collectorStates, statusStore } from "./rig-chrome-status.mjs";

const healthOnly = process.argv.includes("--health");
const store = statusStore(join(homedir(), "Library/Application Support/Saqi"));
let headers, session;
const messages = Object.freeze({
  NATIVE_CREDENTIALS_MISSING:
    "Saqi credentials are missing or locked in Keychain. Run the collector doctor.",
  NATIVE_AUTH_REQUIRED:
    "Saqi authentication failed. Run the collector doctor to check credentials.",
  NATIVE_BUILD_REQUIRED:
    "Build the source collector, then rerun the collector installer.",
  SOURCE_NETWORK_ERROR:
    "Cannot reach Saqi. Check the network; collection will retry.",
  SOURCE_COOLDOWN:
    "The source is cooling down. Collection will wait until the retry time.",
});
async function api(query, body) {
  let response;
  const auth = credentials();
  try {
    response = await fetch(`https://ops.saqi.app/api/rig/source${query}`, {
      headers: auth,
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
      redirect: "error",
    });
  } catch {
    throw new Error("SOURCE_NETWORK_ERROR");
  }
  if ([401, 403].includes(response.status))
    throw new Error("NATIVE_AUTH_REQUIRED");
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      response.status >= 500 ? "SOURCE_NETWORK_ERROR" : "NATIVE_AUTH_REQUIRED",
    );
  }
  if (!response.ok || !data.ok) {
    const error = new Error(data.code || "SOURCE_NETWORK_ERROR");
    if (Number.isSafeInteger(data.retryAfter))
      error.retryAfter = data.retryAfter;
    throw error;
  }
  return data;
}
function credentials() {
  if (headers) return headers;

  headers = {
    "CF-Access-Client-Id": key("saqi-cf-access-client-id"),
    "CF-Access-Client-Secret": key("saqi-cf-access-client-secret"),
    "Content-Type": "application/json",
    Origin: "https://ops.saqi.app",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  };
  return headers;
}
function key(service) {
  try {
    return execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-a",
        "saqi-publication-access-v2",
        "-s",
        service,
        "-w",
      ],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    throw new Error("NATIVE_CREDENTIALS_MISSING");
  }
}
async function loadSession() {
  if (!session) {
    let adapter, module;
    try {
      adapter =
        await import("../packages/source-collector/dist/source-adapter/index.js");
      module = await import("./rig-chrome-session.mjs");
    } catch {
      throw new Error("NATIVE_BUILD_REQUIRED");
    }
    adapter.configureSource({
      name: "aldiwan",
      origin: "https://www.aldiwan.net",
    });
    session = module.collectorSession(api, (patch) => store.update(patch));
  }
  return session;
}
function errorDetail(error) {
  const code = /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "SOURCE_OPERATION_FAILED";

  return {
    code,
    message: messages[code] || code.replaceAll("_", " "),
    retryAfter: error.retryAfter ?? null,
  };
}
function reply(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > 1_048_576) throw new Error("NATIVE_RESPONSE_TOO_LARGE");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([prefix, body]));
}
// eslint-disable-next-line @sarj/no-excessive-cognitive-complexity -- Bounded framed input, sequential handling and per-message recovery belong to one protocol loop.
async function serve() {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 1_048_576) throw new Error("NATIVE_MESSAGE_TOO_LARGE");
      if (buffer.length < length + 4) break;
      let input;
      try {
        input = JSON.parse(buffer.subarray(4, length + 4).toString());
        // eslint-disable-next-line no-await-in-loop -- One native session owns pre-fetch hashes; commands must execute serially.
        const result = await handle(input);
        reply({ id: input.id, ok: true, ...result });
      } catch (error) {
        const detail = errorDetail(error);
        if (input?.action !== "admit-author")
          store.update({
            state: detail.code === "SOURCE_COOLDOWN" ? "cooldown" : "error",
            error: detail,
            retryAt: detail.retryAfter
              ? new Date(detail.retryAfter * 1000).toISOString()
              : null,
          });
        reply({
          id: input?.id ?? null,
          ok: false,
          error: detail,
          status: store.get(),
        });
      }
      buffer = buffer.subarray(length + 4);
    }
  }
  if (store.get().state === "collecting")
    store.update({
      state: "error",
      error: {
        code: "COLLECTOR_DISCONNECTED",
        message:
          "Chrome disconnected before this author finished. D1 will safely resume it.",
      },
    });
}
async function handle(input) {
  if (!input || !Number.isSafeInteger(input.id))
    throw new Error("INVALID_NATIVE_REQUEST");
  let result = {};
  switch (input.action) {
    case "hello":
    case "heartbeat":
      store.update();
      break;
    case "status": {
      const patch = {};
      if (input.state) {
        if (!collectorStates.has(input.state))
          throw new Error("INVALID_COLLECTOR_STATE");
        patch.state = input.state;
        if (["idle", "paused"].includes(input.state)) {
          patch.error = null;
          patch.retryAt = null;
        }
      }
      store.update(patch);
      break;
    }
    case "set-control": {
      if (!collectorStates.has(input.state))
        throw new Error("INVALID_COLLECTOR_STATE");
      const error = input.error
        ? {
            code: String(input.error.code).slice(0, 100),
            message: String(input.error.message).slice(0, 500),
          }
        : null;
      const retryAt =
        input.retryAt && Number.isFinite(Date.parse(input.retryAt))
          ? new Date(input.retryAt).toISOString()
          : null;
      store.update({ state: input.state, error, retryAt });
      break;
    }
    case "acknowledge-review":
      store.update({ reviewWarning: null });
      break;
    default:
      result = await (await loadSession())(input);
  }
  return { ...result, protocol: 1, status: store.get() };
}
if (healthOnly) {
  try {
    await loadSession();
    await api("?action=origin");
    reply({ id: 0, ok: true, protocol: 1, ready: true });
  } catch (error) {
    const detail = errorDetail(error);
    const ready = detail.code === "SOURCE_COOLDOWN";
    reply({
      id: 0,
      ok: ready,
      protocol: 1,
      ready,
      error: ready ? null : detail,
    });
    process.exitCode = ready ? 0 : 1;
  }
} else {
  try {
    await serve();
  } catch (error) {
    store.update({ state: "error", error: errorDetail(error) });
    process.exitCode = 1;
  }
}
