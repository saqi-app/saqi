import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import Database from "better-sqlite3";

import {
  CURRENT_SCHEMA_VERSION,
  LedgerMigrator,
} from "../../crawler-local/src/persistence/migrations.ts";

const here = import.meta.dirname;
const migrationDir = join(here, "../../operations/migrations");
const outputPath = join(here, "../src/generated/database-schema.json");

function inspect(database, id, label) {
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      name,
      columns: database
        .pragma(`table_info(${JSON.stringify(name)})`)
        .map((column) => ({
          name: column.name,
          type: column.type || "ANY",
          nullable: column.notnull === 0 && column.pk === 0,
          primaryKey: column.pk > 0,
        })),
      foreignKeys: database
        .pragma(`foreign_key_list(${JSON.stringify(name)})`)
        .map((key) => ({
          from: key.from,
          table: key.table,
          to: key.to,
        })),
    }));
  return { id, label, tables };
}

const corpus = new Database(":memory:");
const rig = new Database(":memory:");
try {
  corpus.pragma("foreign_keys = ON");
  const files = await readdir(migrationDir);
  const migrationNames = files
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .toSorted();
  const migrations = await Promise.all(
    migrationNames.map((name) => readFile(join(migrationDir, name), "utf8")),
  );
  for (const migration of migrations) corpus.exec(migration);
  const version = new LedgerMigrator(rig).migrate();
  const databases = [
    inspect(corpus, "corpus", "Public corpus · Cloudflare D1"),
    inspect(rig, "rig", "Local rig · SQLite"),
  ];
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error("LOCAL_SCHEMA_UNEXPECTED");
  }
  const output = `${JSON.stringify({ migrationNames, localVersion: version, databases }, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const existing = await readFile(outputPath, "utf8");
    if (existing !== output) throw new Error("DATABASE_SCHEMA_ARTIFACT_STALE");
  } else {
    await writeFile(outputPath, output);
  }
} finally {
  corpus.close();
  rig.close();
}
