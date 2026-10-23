import { Buffer } from "node:buffer";
import { error } from "node:console";
import process from "node:process";
import { TextDecoder } from "node:util";

const MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024;
const SUCCESS_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["sitemap", "PUBLIC_SITEMAP_OK: live XML fetched from public Worker"],
  ["state", "RIG_STATE_OK: canonical D1 queue is readable"],
  ["cache", "RIG_CACHE_PURGE_OK: production write path verified"],
  [
    "bootstrap",
    "AUTHOR_INDEX_BOOTSTRAP_OK: public cache compatibility verified; concurrent work remains queued",
  ],
]);

try {
  const mode = process.argv[2];
  const successMessage = SUCCESS_MESSAGES.get(mode);
  if (process.argv.length !== 3 || !successMessage)
    throw new Error("Invalid canary mode");
  const response = JSON.parse(await readResponse());
  if (!validResponse(mode, response))
    throw new Error("Invalid canary response");
  error(successMessage);
} catch {
  // A rig response can contain private paid checkpoints. Never print the body,
  // parsed response, transport error or JSON parser's response excerpt.
  error("PRODUCTION_CANARY_FAILED: authenticated response was invalid");
  process.exitCode = 1;
}

async function readResponse() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAXIMUM_RESPONSE_BYTES)
      throw new Error("Canary response exceeded its byte limit");
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks, bytes)
  );
}

function validResponse(mode, response) {
  if (!isObject(response)) return false;
  // The sitemap proxy's existing wire contract is {xml}, without an ok field.
  if (mode === "sitemap")
    return (
      // eslint-disable-next-line no-restricted-syntax -- Validate untrusted JSON at this stdlib-only CI boundary before workspace dependencies are installed.
      typeof response.xml === "string" &&
      response.xml.includes("<sitemapindex") &&
      response.xml.includes("https://saqi.app/sitemaps/poets-1.xml") &&
      !response.xml.includes("https://saqi.app/sitemaps/authors-1.xml")
    );
  if (response.ok !== true) return false;
  if (mode === "state")
    return (
      Object.hasOwn(response, "state") &&
      (response.state === null || isObject(response.state))
    );
  return mode === "cache" || mode === "bootstrap";
}

function isObject(value) {
  // eslint-disable-next-line no-restricted-syntax -- Validate untrusted JSON at this stdlib-only CI boundary before workspace dependencies are installed.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
