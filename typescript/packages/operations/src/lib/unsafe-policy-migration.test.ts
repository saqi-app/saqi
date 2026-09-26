import { readFileSync } from "node:fs";

import Database from "better-sqlite3";
import { expect, test } from "vitest";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);
const ORIGINAL = readFileSync(
  new URL("0060_restore_catalog_publishability.sql", MIGRATIONS),
  "utf8"
);
const REPLACEMENT = readFileSync(
  new URL("0066_inline_unsafe_publishability.sql", MIGRATIONS),
  "utf8"
);
const UNSAFE_POINTS = [
  ...Array.from({ length: 9 }, (_, index) => index),
  11,
  12,
  ...Array.from({ length: 18 }, (_, index) => index + 14),
  127,
  ...Array.from({ length: 5 }, (_, index) => index + 8_234),
  ...Array.from({ length: 4 }, (_, index) => index + 8_294),
];

function fixture(inline: boolean): Database.Database {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE poem (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
      publishable INTEGER NOT NULL DEFAULT 0, verses INTEGER NOT NULL,
      name_arabic TEXT NOT NULL, content_arabic TEXT NOT NULL
    );
  `);
  database.exec(ORIGINAL);
  if (inline) database.exec(REPLACEMENT);
  return database;
}

function outcomes(database: Database.Database): number[] {
  const insert = database.prepare(
    `INSERT INTO poem(id, slug, verses, name_arabic, content_arabic)
     VALUES (?, ?, 1, ?, ?)`
  );
  const update = database.prepare(
    "UPDATE poem SET name_arabic = ? WHERE id = ?"
  );
  const flag = database.prepare("SELECT publishable FROM poem WHERE id = ?");
  const values: number[] = [];
  for (const [index, value] of [
    "شعر",
    ...UNSAFE_POINTS.map((point) => `ش${String.fromCodePoint(point)}عر`),
  ].entries()) {
    const id = `title-${String(index)}`;
    insert.run(id, id, value, '{"content":["بيت آمن"]}');
    values.push((flag.get(id) as { publishable: number }).publishable);
    const lineId = `line-${String(index)}`;
    insert.run(lineId, lineId, "شعر", JSON.stringify({ content: [value] }));
    values.push((flag.get(lineId) as { publishable: number }).publishable);
    const updateId = `update-${String(index)}`;
    insert.run(updateId, updateId, "شعر", '{"content":["بيت آمن"]}');
    update.run(value, updateId);
    values.push((flag.get(updateId) as { publishable: number }).publishable);
  }
  return values;
}

test("inline Unicode rule preserves insert and update visibility for all 39 controls", () => {
  const before = fixture(false);
  const after = fixture(true);
  try {
    const expected = outcomes(before);
    expect(outcomes(after)).toEqual(expected);
    expect(expected.slice(0, 3)).toEqual([1, 1, 1]);
    expect(expected.slice(3).every((value) => value === 0)).toBe(true);
    expect(
      after
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'catalog_unsafe_control'"
        )
        .get()
    ).toBeUndefined();
  } finally {
    before.close();
    after.close();
  }
});
