import console from "node:console";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

export function finalHeaderBlock(text) {
  let current = [];
  let completed = "";
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (/^HTTP\/\S+ \d{3}(?: |$)/u.test(line)) {
      current = [line];
      completed = "";
    } else if (current.length > 0) {
      if (line === "") {
        completed = `${current.join("\n")}\n\n`;
        current = [];
      } else current.push(line);
    }
  }
  if (!completed) throw new Error("PUBLIC_ROUTE_HEADERS_INVALID");
  return completed;
}

export function publicRouteUrl(kind, value, base = "https://saqi.app/") {
  if (
    !["author", "poem", "home"].includes(kind) ||
    !value ||
    value.length > 8192 ||
    // eslint-disable-next-line no-control-regex -- Reject raw URL whitespace, controls and backslashes before URL normalization.
    /[\\\u{0000}-\u{0020}\u{007f}?#]/u.test(value) ||
    /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/iu.test(value)
  )
    throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
  const url = new URL(value, base);
  if (
    url.origin !== "https://saqi.app" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
  if (kind === "home") {
    if (url.pathname !== "/") throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
    return url.href;
  }
  const parts = url.pathname.split("/");
  if (
    (parts[1] !== "poet" && parts[1] !== "author") ||
    (kind === "author"
      ? parts.length !== 3
      : parts.length !== 5 || parts[3] !== "poem")
  )
    throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
  for (const encoded of [parts[2], ...(kind === "poem" ? [parts[4]] : [])]) {
    const segment = decodeURIComponent(encoded);
    if (
      !segment ||
      segment.length > 500 ||
      segment === "." ||
      segment === ".." ||
      // eslint-disable-next-line no-control-regex -- Match the reader's exactly-once identity decoding and unsafe routing control rejection.
      /[/\\\u{0000}-\u{001f}\u{007f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/u.test(
        segment
      )
    )
      throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
  }
  return url.href;
}

export function publicRouteLocation(kind, current, headers) {
  const block = finalHeaderBlock(headers);
  if (/^[\t ]/mu.test(block)) throw new Error("PUBLIC_ROUTE_HEADERS_INVALID");
  const values = block
    .split("\n")
    .filter((line) => /^location:/iu.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  if (values.length !== 1 || !values[0])
    throw new Error("PUBLIC_ROUTE_LOCATION_INVALID");
  return publicRouteUrl(kind, values[0], current);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [mode, kind, current, file] = process.argv.slice(2);
    if (mode === "validate" && process.argv.length === 5)
      console.log(publicRouteUrl(kind, current));
    else if (mode === "headers" && process.argv.length === 4) {
      const { size } = await stat(kind);
      if (size > 65536) throw new Error("PUBLIC_ROUTE_HEADERS_INVALID");
      process.stdout.write(finalHeaderBlock(await readFile(kind, "utf8")));
    } else if (mode === "location" && process.argv.length === 6) {
      const { size } = await stat(file);
      if (size > 65536) throw new Error("PUBLIC_ROUTE_HEADERS_INVALID");
      console.log(
        publicRouteLocation(kind, current, await readFile(file, "utf8"))
      );
    } else if (mode === "canonical" && process.argv.length === 5) {
      const { canonicalHtmlUrl } =
        await import("../packages/precedent-iso/dist/canonical-html-url.js");
      const { size } = await stat(current);
      if (
        size > 16 * 1024 * 1024 ||
        canonicalHtmlUrl(await readFile(current, "utf8")) !== kind
      )
        throw new Error("PUBLIC_ROUTE_CANONICAL_INVALID");
    } else throw new Error("PUBLIC_ROUTE_ARGUMENTS_INVALID");
  } catch {
    console.error("PUBLIC_ROUTE_CANARY_INVALID");
    process.exitCode = 1;
  }
}
