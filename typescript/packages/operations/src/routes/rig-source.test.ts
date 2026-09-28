import Database from "better-sqlite3";
import { expect, test, vi } from "vitest";

import { parseCloudflareEnv } from "../lib/cloudflare";
import { DirectSourceRepository } from "../lib/direct-source-repository";
import { get, post } from "./rig-source";

test("fresh requests honor a durable source deadline across authors until it expires", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE d1_migrations(name TEXT PRIMARY KEY);
    INSERT INTO d1_migrations VALUES ('0064_retire_collection_dashboard.sql');
    CREATE TABLE author(id TEXT PRIMARY KEY, source_author_id TEXT,
      source_url TEXT, name_arabic TEXT, collected_at INTEGER, source_retry_after INTEGER);
    INSERT INTO author VALUES ('a', 'a', 'https://www.aldiwan.net/cat-a', 'شاعر', 1, 2000000000);
    INSERT INTO author VALUES ('b', 'b', 'https://www.aldiwan.net/cat-b', 'شاعر', NULL, NULL);
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

test("manifest reconciliation has an authenticated bounded batch contract", async () => {
  const read = vi
    .spyOn(DirectSourceRepository.prototype, "existingPoemIds")
    .mockResolvedValue(["1"]);
  const env = parseCloudflareEnv({
    DB: { prepare: vi.fn() },
    SAQI_DIRECT_SOURCE_ACTIVE: "1",
    SAQI_SOURCE_BASE_URL: "https://www.aldiwan.net",
  });
  const request = (poemIds: string[], trusted = true) =>
    new Request("https://ops.saqi.app/api/rig/source", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "ops.saqi.app",
        origin: trusted ? "https://ops.saqi.app" : "https://other.example",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
      body: JSON.stringify({
        action: "reconcile-manifest",
        sourceAuthorId: "poet-Test",
        poemIds,
      }),
    });
  try {
    const response = await post(request(["1", "2"]), env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      existingPoemIds: ["1"],
    });
    expect(read).toHaveBeenCalledWith({
      sourceAuthorId: "poet-Test",
      poemIds: ["1", "2"],
    });
    const oversized = await post(
      request(Array.from({ length: 201 }, (_, index) => String(index + 1))),
      env
    );
    expect(oversized.status).toBe(400);
    const untrusted = await post(request(["1"], false), env);
    expect(untrusted.status).toBe(403);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    read.mockRestore();
  }
});
