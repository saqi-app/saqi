#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configureSource } from "../packages/source-collector/dist/source-adapter/index.js";
import { collectorSession } from "./rig-chrome-session.mjs";
configureSource({ name: "aldiwan", origin: "https://www.aldiwan.net" });
const directory = join(homedir(), "Library/Application Support/Saqi");
mkdirSync(directory, { recursive: true, mode: 0o700 });
let message = "Connected to personal Chrome";
let phase = "running";
function status() {
  writeFileSync(
    join(directory, "collect.log"),
    `PERSONAL_CHROME ${phase}\n${new Date().toISOString()}\n${message}\n`,
    { mode: 0o600 },
  );
}
const key = (service) =>
  execFileSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-a",
      "saqi-publication-access-v2",
      "-s",
      service,
      "-w",
    ],
    { encoding: "utf8", timeout: 10000 },
  ).trim();
const headers = {
  "CF-Access-Client-Id": key("saqi-cf-access-client-id"),
  "CF-Access-Client-Secret": key("saqi-cf-access-client-secret"),
  "Content-Type": "application/json",
  Origin: "https://ops.saqi.app",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};
async function api(query = "", body) {
  const r = await fetch("https://ops.saqi.app/api/rig/source" + query, {
    headers,
    method: body ? "POST" : "GET",
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json();
  if (!r.ok || !data.ok) throw new Error(data.code || `Source API ${r.status}`);
  return data;
}
const handle = collectorSession(api, (text, state = "running") => {
  message = text;
  phase = state;
  status();
});
let buffer = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0);
    if (length > 1_048_576) throw new Error("Native message too large");
    if (buffer.length < length + 4) break;
    const input = JSON.parse(buffer.subarray(4, length + 4).toString());
    buffer = buffer.subarray(length + 4);
    let reply;
    try {
      let result = {};
      if (input.action === "heartbeat") status();
      else if (input.action === "error") {
        phase = "attention";
        message = String(input.message).slice(0, 500);
        status();
      } else result = await handle(input);
      reply = { id: input.id, ok: true, ...result };
    } catch (error) {
      phase = "attention";
      message = error.message;
      status();
      reply = { id: input.id, ok: false, error: message };
    }
    const body = Buffer.from(JSON.stringify(reply));
    if (body.length > 1_048_576) throw new Error("Native response too large");
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(body.length);
    process.stdout.write(Buffer.concat([prefix, body]));
  }
}
if (phase === "running") {
  phase = "attention";
  message = "Personal Chrome disconnected before collection completed; the author remains due in D1";
  status();
}
