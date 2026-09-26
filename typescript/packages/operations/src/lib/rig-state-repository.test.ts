import { readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { RigPublicationRepository } from "./rig-publication-repository";
import { RigStateRepository } from "./rig-state-repository";

const TEST_DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of TEST_DATABASES) database.close();
  TEST_DATABASES.length = 0;
});

function fixture() {
  const sqlite = new Database(":memory:");
  TEST_DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE author(id TEXT PRIMARY KEY, name_arabic TEXT NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE poem(id TEXT PRIMARY KEY, hidden INTEGER NOT NULL,
      publishable INTEGER NOT NULL, author_id TEXT,
      name_arabic TEXT NOT NULL, content_arabic TEXT NOT NULL);
  `);
  sqlite.exec(
    readFileSync(
      new URL(
        "../../migrations/0062_expand_canonical_rig_state.sql",
        import.meta.url
      ),
      "utf8"
    )
  );
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0065_index_rig_retry.sql", import.meta.url),
      "utf8"
    )
  );
  sqlite
    .prepare("INSERT INTO author(id,name_arabic) VALUES(?,?)")
    .run("author-1", "شاعر");
  sqlite
    .prepare(
      `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,source_hash)
       VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?)`
    )
    .run("poem-1", "a".repeat(64));
  sqlite
    .prepare(
      `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,source_hash)
       VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?)`
    )
    .run("poem-2", "b".repeat(64));
  const numbered = (values: unknown[]) =>
    Object.fromEntries(
      values.map((value, index) => [String(index + 1), value])
    );
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => sqlite.prepare(query).get(numbered(values)) ?? null,
    run: async () => {
      const result = sqlite.prepare(query).run(numbered(values));
      return { meta: { changes: result.changes } };
    },
  });
  const repository = new RigStateRepository({
    prepare: wrap,
  } as unknown as D1Database);
  const publisher = new RigPublicationRepository({
    prepare: wrap,
  } as unknown as D1Database);
  return { publisher, repository, sqlite };
}

test("hidden authors do not enter the Codex queue or expose a claimed source", async () => {
  const { publisher, repository, sqlite } = fixture();
  const owner = "11111111-1111-4111-8111-111111111111";
  sqlite.prepare("UPDATE author SET hidden = 1 WHERE id = 'author-1'").run();
  sqlite
    .prepare("UPDATE poem SET rig_status = 'retry' WHERE id = 'poem-1'")
    .run();
  await expect(repository.claimNextPoem(owner, 100)).resolves.toBeNull();

  sqlite.prepare("UPDATE author SET hidden = 0 WHERE id = 'author-1'").run();
  await expect(repository.claimNextPoem(owner, 100)).resolves.toMatchObject({
    poemId: "poem-1",
  });
  sqlite.prepare("UPDATE author SET hidden = 1 WHERE id = 'author-1'").run();
  await expect(
    publisher.readClaimedSource("poem-1", owner, 101)
  ).resolves.toBeNull();
});

test("a lost dispatch response cannot cause a second Codex invocation", async () => {
  const { publisher, repository, sqlite } = fixture();
  const owner = "11111111-1111-4111-8111-111111111111";
  const secondOwner = "22222222-2222-4222-8222-222222222222";
  const attempt = "33333333-3333-4333-8333-333333333333";
  const claimed = await repository.claimNextPoem(owner, 100);
  expect(claimed?.poemId).toBe("poem-1");
  await expect(
    publisher.readClaimedSource("poem-1", owner, 101)
  ).resolves.toMatchObject({
    linesArabic: ["بيت"],
    sourceHash: "a".repeat(64),
  });
  await expect(repository.claimNextPoem(secondOwner, 101)).resolves.toBeNull();
  const intent = {
    attemptId: attempt,
    inputHash: "c".repeat(64),
    model: "Codex Sol",
    startedAt: 102,
    deadlineAt: 200,
  };
  await expect(
    repository.beginInvocation("poem-1", owner, claimed!.version, intent)
  ).resolves.toBe(true);
  await expect(
    repository.beginInvocation("poem-1", owner, claimed!.version, intent)
  ).resolves.toBe(false);
  await expect(repository.currentEnrichment()).resolves.toMatchObject({
    poemId: "poem-1",
    status: "dispatching",
  });
  await expect(repository.claimNextPoem(secondOwner, 201)).resolves.toBeNull();
  await expect(repository.markExpiredUnknown("poem-1", 201)).resolves.toBe(
    true
  );
  await expect(repository.claimNextPoem(secondOwner, 202)).resolves.toBeNull();
  const unknown = await repository.read("poem-1");
  await expect(
    repository.acknowledgeInvocation("poem-1", attempt, unknown!.version, {
      translation: { lines: ["translated"] },
      insights: {
        summary: "A reading",
        themes: ["Memory"],
        historicalContext: "History",
        literaryDevices: ["Metaphor"],
        culturalSignificance: "Culture",
        notableLines: [{ line: "بيت", explanation: "Meaning" }],
      },
    })
  ).resolves.toBe(true);
  const recovered = await repository.claimNextPoem(secondOwner, 203);
  expect(recovered).toMatchObject({
    poemId: "poem-1",
    status: "claimed",
    checkpointJson: expect.stringContaining('"phase":"publish"'),
  });
  await expect(repository.claimNextPoem(owner, 204)).resolves.toBeNull();
  await expect(publisher.publish("poem-1", recovered!.version)).resolves.toBe(
    true
  );
  const published = sqlite
    .prepare(
      "SELECT publication_json AS publicationJson, rig_status AS rigStatus FROM poem WHERE id = ?"
    )
    .get("poem-1") as { publicationJson: string; rigStatus: string };
  expect(published).toMatchObject({
    rigStatus: "complete",
    publicationJson: expect.stringContaining('"translated"'),
  });
  expect(JSON.parse(published.publicationJson)).toMatchObject({
    schemaVersion: 2,
    active: true,
    fields: {
      modelEnrichments: [
        { lines: ["translated"], model: "Codex Sol", vendorKey: "openai" },
      ],
      insightsTrack: "model",
      insightsModel: "Codex Sol",
    },
  });
  await expect(repository.claimNextPoem(owner, 205)).resolves.toMatchObject({
    poemId: "poem-2",
  });
});

test("source changes invalidate a claim before dispatch", async () => {
  const { repository, sqlite } = fixture();
  const token = "11111111-1111-4111-8111-111111111111";
  const claimed = await repository.claimNextPoem(token, 100);
  sqlite
    .prepare("UPDATE poem SET source_hash = ? WHERE id = ?")
    .run("d".repeat(64), claimed!.poemId);
  await expect(
    repository.beginInvocation(claimed!.poemId, token, claimed!.version, {
      attemptId: "22222222-2222-4222-8222-222222222222",
      deadlineAt: 300,
      inputHash: "c".repeat(64),
      model: "Codex Sol",
      startedAt: 101,
    })
  ).resolves.toBe(false);
});

test("unknown work requires an exact manual retry decision", async () => {
  const { repository } = fixture();
  const token = "11111111-1111-4111-8111-111111111111";
  const attemptId = "22222222-2222-4222-8222-222222222222";
  const claimed = await repository.claimNextPoem(token, 100);
  await repository.beginInvocation(claimed!.poemId, token, claimed!.version, {
    attemptId,
    deadlineAt: 200,
    inputHash: "c".repeat(64),
    model: "Codex Sol",
    startedAt: 101,
  });
  await repository.markExpiredUnknown(claimed!.poemId, 201);
  const unknown = await repository.read(claimed!.poemId);
  await expect(repository.claimNextPoem(token, 202)).resolves.toBeNull();
  await expect(
    repository.retryUnknown(
      claimed!.poemId,
      "33333333-3333-4333-8333-333333333333",
      unknown!.version
    )
  ).resolves.toBe(false);
  await expect(
    repository.retryUnknown(claimed!.poemId, attemptId, unknown!.version)
  ).resolves.toBe(true);
  await expect(repository.claimNextPoem(token, 203)).resolves.toMatchObject({
    poemId: claimed!.poemId,
    status: "claimed",
  });
});

test("a manual retry runs before the unprocessed backlog", async () => {
  const { repository, sqlite } = fixture();
  sqlite
    .prepare("UPDATE poem SET rig_status = 'retry' WHERE id = 'poem-2'")
    .run();
  const claimed = await repository.claimNextPoem(
    "11111111-1111-4111-8111-111111111111",
    100
  );
  expect(claimed?.poemId).toBe("poem-2");
});

test("an expired claim is recovered before another poem", async () => {
  const { repository, sqlite } = fixture();
  sqlite
    .prepare(
      `UPDATE poem SET rig_status = 'claimed', rig_version = 1,
       rig_lease_expires_at = 90, rig_updated_at = 10,
       rig_checkpoint_json = ? WHERE id = 'poem-2'`
    )
    .run(JSON.stringify({ phase: "generation", sourceHash: "b".repeat(64) }));
  const claimed = await repository.claimNextPoem(
    "11111111-1111-4111-8111-111111111111",
    100
  );
  expect(claimed).toMatchObject({ poemId: "poem-2", version: 2 });
});

test("a changed Arabic source cannot receive an earlier Codex result", async () => {
  const { publisher, sqlite } = fixture();
  sqlite
    .prepare(
      `UPDATE poem SET rig_status = 'claimed', rig_version = 1,
       rig_checkpoint_json = ? WHERE id = 'poem-1'`
    )
    .run(
      JSON.stringify({
        model: "Codex Sol",
        sourceHash: "a".repeat(64),
        outputs: {
          generation: {
            translation: { lines: ["translated"] },
            insights: {
              summary: "A reading",
              themes: ["Memory"],
              historicalContext: "History",
              literaryDevices: ["Metaphor"],
              culturalSignificance: "Culture",
              notableLines: [{ line: "بيت", explanation: "Meaning" }],
            },
          },
        },
      })
    );
  sqlite
    .prepare("UPDATE poem SET source_hash = ? WHERE id = 'poem-1'")
    .run("d".repeat(64));
  await expect(publisher.publish("poem-1", 1)).rejects.toThrow(
    "SOURCE_CHANGED_BEFORE_PUBLICATION"
  );
  expect(
    sqlite
      .prepare(
        "SELECT publication_json AS publicationJson FROM poem WHERE id = 'poem-1'"
      )
      .get()
  ).toEqual({ publicationJson: null });
});
