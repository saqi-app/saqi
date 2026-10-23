import console from "node:console";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

import { publicRouteUrl } from "./public-route-location.ts";

const CANARY_POEM = "5cf197dd-692d-4024-acc5-ee081560263f";
const FIELDS = [
  "poemId",
  "legacyAuthorSlug",
  "authorSlug",
  "poemSlug",
  "poemLanguage",
  "legacyAuthorOwned",
  "legacyPoemOwned",
  "canonicalAuthorOwned",
  "canonicalPoemOwned",
] as const;
export function productionRouteExpectations(input, strict = false) {
  if (
    !Array.isArray(input) ||
    input.length !== 1 ||
    !object(input[0]) ||
    input[0].success !== true ||
    !Array.isArray(input[0].results) ||
    input[0].results.length !== 1
  )
    throw new Error("INVALID_ROUTE_METADATA");
  const row = input[0].results[0];
  if (
    !object(row) ||
    Object.keys(row).length !== FIELDS.length ||
    !FIELDS.every((field) => Object.hasOwn(row, field)) ||
    row.poemId !== CANARY_POEM ||
    row.legacyAuthorOwned !== 1 ||
    row.legacyPoemOwned !== 1
  )
    throw new Error("INVALID_ROUTE_METADATA");
  const authorAllocated = row.authorSlug !== null;
  const poemAllocated = row.poemSlug !== null;
  if (
    row.canonicalAuthorOwned !== (authorAllocated ? 1 : 0) ||
    row.canonicalPoemOwned !== (poemAllocated ? 1 : 0) ||
    (poemAllocated
      ? !authorAllocated || !["en", "ar"].includes(row.poemLanguage)
      : row.poemLanguage !== null) ||
    (strict && (!authorAllocated || !poemAllocated))
  )
    throw new Error("INVALID_ROUTE_METADATA");
  const author = segment(
    authorAllocated ? row.authorSlug : row.legacyAuthorSlug
  );
  const poem = segment(poemAllocated ? row.poemSlug : row.poemId);
  const authorUrl = publicRouteUrl("author", `https://saqi.app/poet/${author}`);
  const poemUrl = publicRouteUrl("poem", `${authorUrl}/poem/${poem}`);
  if (
    strict &&
    (authorUrl === "https://saqi.app/poet/poet-abn-rumi" ||
      poem === CANARY_POEM)
  )
    throw new Error("INVALID_ROUTE_METADATA");
  return { author: authorUrl, poem: poemUrl };
}
function object(value) {
  // eslint-disable-next-line no-restricted-syntax -- Validate the untrusted Wrangler JSON boundary without workspace runtime dependencies.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function segment(value) {
  // eslint-disable-next-line no-restricted-syntax -- D1 metadata is untrusted until its scalar type and public route encoding are checked.
  if (typeof value !== "string") throw new TypeError("INVALID_ROUTE_METADATA");
  const encoded = encodeURIComponent(value);
  publicRouteUrl("author", `https://saqi.app/poet/${encoded}`);
  return encoded;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [field, strict, file] = process.argv.slice(2);
    if (
      process.argv.length !== 5 ||
      !["author", "poem"].includes(field) ||
      !["true", "false"].includes(strict)
    )
      throw new Error("INVALID_ROUTE_METADATA");
    const { size } = await stat(file);
    if (size > 65536) throw new Error("INVALID_ROUTE_METADATA");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(file)
    );
    console.log(
      productionRouteExpectations(JSON.parse(text), strict === "true")[field]
    );
  } catch {
    console.error("PUBLIC_ROUTE_EXPECTATIONS_INVALID");
    process.exitCode = 1;
  }
}
