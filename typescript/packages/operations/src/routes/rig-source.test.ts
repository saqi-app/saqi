import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/cloudflare";
import { get } from "./rig-source";

test("fresh requests honor a durable source deadline across authors until it expires", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE d1_migrations(name TEXT PRIMARY KEY);
    INSERT INTO d1_migrations VALUES ('0064_retire_collection_dashboard.sql');
    CREATE TABLE author(id TEXT PRIMARY KEY, source_name TEXT, source_author_id TEXT,
      source_url TEXT, name_arabic TEXT, collected_at INTEGER, source_retry_after INTEGER);
    INSERT INTO author VALUES ('a', 'aldiwan', 'a', 'https://www.aldiwan.net/cat-a', 'شاعر', 1, 2000000000);
    INSERT INTO author VALUES ('b', 'aldiwan', 'b', 'https://www.aldiwan.net/cat-b', 'شاعر', NULL, NULL);
    INSERT INTO author VALUES ('c', 'other', 'c', NULL, 'شاعر', NULL, 2100000000);
  `);
  const wrap = (sql: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(sql, parameters),
    first: async () =>
      sqlite
        .prepare(sql)
        .get(
          Object.fromEntries(
            values.map((value, index) => [String(index + 1), value])
          )
        ) ?? null,
  });
  const env = parseCloudflareEnv({
    DB: { prepare: wrap },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_SOURCE_NAME: "aldiwan",
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
  });
  const now = vi.spyOn(Date, "now").mockReturnValue(1999999900000);
  try {
    const blocked = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=next-author"),
      env
    );
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("100");
    await expect(blocked.json()).resolves.toMatchObject({
      code: "SOURCE_COOLDOWN",
    });
    const manual = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=origin"),
      env
    );
    expect(manual.status).toBe(429);
    now.mockReturnValue(2000000000000);
    const resumed = await get(
      new Request("https://ops.saqi.app/api/rig/source?action=next-author"),
      env
    );
    expect(resumed.status).toBe(200);
    await expect(resumed.json()).resolves.toMatchObject({
      author: { id: "b" },
    });
  } finally {
    now.mockRestore();
    sqlite.close();
  }
});
