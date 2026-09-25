#!/usr/bin/env node

// Resume migration 0063 in bounded, idempotent batches. This command prints
// aggregate counts only; it never exports corpus rows.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageDir = fileURLToPath(
  new URL("../packages/operations/", import.meta.url),
);
const migration = fileURLToPath(
  new URL(
    "../packages/operations/migrations/0063_backfill_known_source_identity.sql",
    import.meta.url,
  ),
);
const apply = process.argv.includes("--apply");
const pendingSql = `
SELECT
  (SELECT count(*) FROM source_author_identity s JOIN author a
    ON a.id = s.canonical_author_id WHERE a.source_name IS NULL) AS authors,
  (SELECT count(*) FROM source_poem_identity s JOIN poem p
    ON p.id = s.canonical_poem_id WHERE p.source_name IS NULL) AS poems,
  (SELECT count(*) FROM source_poem_identity s JOIN poem p
    ON p.id = s.canonical_poem_id
    WHERE p.source_hash IS NULL
      AND p.active_source_revision_id = s.current_revision_id) AS hashes`;

function wrangler(args) {
  try {
    const output = execFileSync(
      "yarn",
      [
        "wrangler",
        "d1",
        "execute",
        "saqi-db",
        "--remote",
        "--yes",
        "--json",
        ...args,
      ],
      { cwd: packageDir, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    // Wrangler prefixes --file JSON with a human-readable upload progress
    // line. The SQL result remains the final JSON array.
    const jsonStart = output.indexOf("[");
    if (jsonStart < 0) throw new Error("Wrangler omitted its JSON result");
    return JSON.parse(output.slice(jsonStart));
  } catch (error) {
    throw new Error("Wrangler D1 command failed", { cause: error });
  }
}

const schemaCheck = wrangler([
  "--command",
  `
  SELECT
    (SELECT count(*) FROM pragma_table_info('author') WHERE name='source_name') AS author_ready,
    (SELECT count(*) FROM pragma_table_info('poem') WHERE name='source_hash') AS poem_ready
`,
])?.[0]?.results?.[0];
if (schemaCheck?.author_ready !== 1 || schemaCheck?.poem_ready !== 1) {
  throw new Error("Migration 0062 must be applied before this backfill");
}

function pending() {
  const response = wrangler(["--command", pendingSql]);
  const row = response?.[0]?.results?.[0];
  if (
    !row ||
    !["authors", "poems", "hashes"].every((key) =>
      Number.isSafeInteger(row[key]),
    )
  ) {
    throw new Error(
      "Unexpected Wrangler aggregate response; refusing to continue",
    );
  }
  return row;
}

let remaining = pending();
process.stdout.write(
  `${JSON.stringify({ remaining, mode: apply ? "apply" : "read-only" })}\n`,
);
if (!apply) {
  process.stdout.write(
    "Take and verify a production restore point, then rerun with --apply.\n",
  );
  process.exit(0);
}

for (
  let batch = 1;
  Object.values(remaining).some((count) => count > 0);
  batch += 1
) {
  if (batch > 1000)
    throw new Error("Backfill exceeded 1000 batches; inspect manually");
  wrangler(["--file", migration]);
  const next = pending();
  process.stdout.write(`${JSON.stringify({ batch, remaining: next })}\n`);
  if (Object.keys(next).some((key) => next[key] > remaining[key])) {
    throw new Error(
      "Pending count increased; an old writer may still be active",
    );
  }
  if (Object.keys(next).every((key) => next[key] === remaining[key])) {
    throw new Error("Backfill stalled; inspect D1 before retrying");
  }
  remaining = next;
}
