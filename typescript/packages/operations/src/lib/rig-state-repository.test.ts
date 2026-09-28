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
  sqlite.exec(
    readFileSync(
      new URL(
        "../../migrations/0080_drop_unused_rig_updated_at.sql",
        import.meta.url
      ),
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

test("poems without a canonical author do not enter the queue or expose a claimed source", async () => {
  const { publisher, repository, sqlite } = fixture();
  const owner = "11111111-1111-4111-8111-111111111111";
  sqlite
    .prepare("UPDATE poem SET author_id = 'missing' WHERE id = 'poem-1'")
    .run();
  sqlite
    .prepare("UPDATE poem SET rig_status = 'retry' WHERE id = 'poem-1'")
    .run();
  await expect(
    repository.claimNextPoem(owner, 100, "poem-1")
  ).resolves.toBeNull();

  sqlite
    .prepare("UPDATE poem SET author_id = 'author-1' WHERE id = 'poem-1'")
    .run();
  await expect(
    repository.claimNextPoem(owner, 100, "poem-1")
  ).resolves.toMatchObject({
    poemId: "poem-1",
  });
  sqlite
    .prepare("UPDATE poem SET author_id = 'missing' WHERE id = 'poem-1'")
    .run();
  await expect(
    publisher.readClaimedSource("poem-1", owner, 101)
  ).resolves.toBeNull();
});

test("a specific due poem can be claimed without bypassing the active-work fence", async () => {
  const { repository, sqlite } = fixture();
  const owner = "11111111-1111-4111-8111-111111111111";
  const otherOwner = "22222222-2222-4222-8222-222222222222";
  await expect(
    repository.claimNextPoem(owner, 100, "poem-2")
  ).resolves.toMatchObject({
    poemId: "poem-2",
  });
  await expect(
    repository.claimNextPoem(otherOwner, 101, "poem-1")
  ).resolves.toBeNull();
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = NULL, rig_lease_expires_at = NULL WHERE id = 'poem-2'"
    )
    .run();
  sqlite
    .prepare("UPDATE poem SET author_id = 'missing' WHERE id = 'poem-1'")
    .run();
  await expect(
    repository.claimNextPoem(otherOwner, 102, "poem-1")
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
  await expect(
    repository.claimNextPoem(secondOwner, 202, "poem-1")
  ).resolves.toBeNull();
  const unknown = await repository.read("poem-1");
  await expect(
    repository.acknowledgeInvocation("poem-1", attempt, unknown!.version, {
      translation: { lines: ["translated"] },
      wordMeanings: [["verse"]],
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
        {
          lines: ["translated"],
          model: "Codex Sol",
          vendorKey: "openai",
        },
      ],
      wordGlosses: {
        model: "Codex Sol",
        sourceHash: "a".repeat(64),
        meanings: {
          lines: [
            { segments: [{ kind: "word", surface: "بيت", meaning: "verse" }] },
          ],
        },
      },
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

test("an unknown poem cannot replay, but another poem can be claimed", async () => {
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
  await expect(
    repository.claimNextPoem(token, 202, claimed!.poemId)
  ).resolves.toBeNull();
  const other = await repository.claimNextPoem(token, 202);
  expect(other?.poemId).toBe("poem-2");
  await expect(repository.currentEnrichment()).resolves.toMatchObject({
    poemId: "poem-2",
    status: "claimed",
  });
  await expect(repository.read(claimed!.poemId)).resolves.toMatchObject({
    status: "unknown",
    checkpointJson: expect.stringContaining(attemptId),
  });
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
  await expect(repository.read(claimed!.poemId)).resolves.toMatchObject({
    status: "retry",
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
       rig_lease_expires_at = 90,
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
  const { publisher, repository, sqlite } = fixture();
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
            wordMeanings: [["verse"]],
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
  await expect(publisher.publish("poem-1", 1)).resolves.toBe(false);
  await expect(repository.currentEnrichment()).resolves.toBeNull();
  await expect(
    repository.claimNextPoem("11111111-1111-4111-8111-111111111111", 100)
  ).resolves.toMatchObject({
    poemId: "poem-1",
    checkpointJson: expect.stringContaining("d".repeat(64)),
  });
  expect(
    sqlite
      .prepare(
        "SELECT publication_json AS publicationJson FROM poem WHERE id = 'poem-1'"
      )
      .get()
  ).toEqual({ publicationJson: null });
});

test("an acknowledged invalid output is retained without starving the next poem", async () => {
  const { publisher, repository, sqlite } = fixture();
  const checkpoint = JSON.stringify({
    model: "Codex Sol",
    sourceHash: "a".repeat(64),
    outputs: {
      generation: {
        translation: { lines: ["translated"] },
        wordMeanings: [[]],
        insights: {
          summary: "Reading",
          themes: ["Memory"],
          historicalContext: "History",
          literaryDevices: ["Metaphor"],
          culturalSignificance: "Culture",
          notableLines: [{ line: "بيت", explanation: "Meaning" }],
        },
      },
    },
  });
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'claimed', rig_version = 1, rig_checkpoint_json = ? WHERE id = 'poem-1'"
    )
    .run(checkpoint);
  await expect(publisher.publish("poem-1", 1)).resolves.toBe("blocked");
  expect(
    sqlite
      .prepare(
        "SELECT rig_status AS rigStatus, rig_checkpoint_json AS checkpoint, publication_json AS publication FROM poem WHERE id = 'poem-1'"
      )
      .get()
  ).toEqual({
    rigStatus: "blocked",
    checkpoint,
    publication: null,
  });
  await expect(
    repository.claimNextPoem("11111111-1111-4111-8111-111111111111", 100)
  ).resolves.toMatchObject({ poemId: "poem-2" });
});

const INSIGHTS = {
  summary: "A reading",
  themes: ["Memory"],
  historicalContext: "History",
  literaryDevices: ["Metaphor"],
  culturalSignificance: "Culture",
  notableLines: [{ line: "بيت", explanation: "Meaning" }],
};
const PRESERVED_FIELDS = {
  linesEnglish: ["Legacy English"],
  linesEnglishModel: "claude-2",
  linesEnglishAttributionCertainty: "inferred_range",
  linesEnglishGemini: ["Gemini English"],
  linesEnglishGeminiModel: "gemini-3.5-flash",
  linesEnglishSol: ["Sol English"],
  linesEnglishSolModel: "gpt-5.6-sol",
  modelEnrichments: [
    {
      modelKey: "old",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      lines: ["Published alternative"],
    },
  ],
};

test("missing insights and glosses are selected without regenerating current English", async () => {
  const { publisher, repository, sqlite } = fixture();
  const original = JSON.stringify({
    schemaVersion: 2,
    active: true,
    fields: PRESERVED_FIELDS,
  });
  sqlite
    .prepare(
      `UPDATE poem SET publication_json = ?, publication_source_hash = source_hash,
    publication_hash = 'old' WHERE id = 'poem-1'`
    )
    .run(original);
  const token = "11111111-1111-4111-8111-111111111111";
  const claim = await repository.claimNextPoem(token, 100, "poem-1");
  expect(JSON.parse(claim!.checkpointJson!)).toMatchObject({
    required: ["insights", "wordMeanings"],
  });
  await expect(
    publisher.readClaimedSource("poem-1", token, 101)
  ).resolves.toMatchObject({ required: ["insights", "wordMeanings"] });
  const checkpoint = {
    ...JSON.parse(claim!.checkpointJson!),
    model: "gpt-6-sol",
    reasoningEffort: "medium",
    phase: "publish",
    outputs: { generation: { insights: INSIGHTS, wordMeanings: [["verse"]] } },
  };
  sqlite
    .prepare("UPDATE poem SET rig_checkpoint_json = ? WHERE id = 'poem-1'")
    .run(JSON.stringify(checkpoint));
  await expect(publisher.publish("poem-1", claim!.version)).resolves.toBe(true);
  const row = sqlite
    .prepare(
      "SELECT publication_json AS publicationJson FROM poem WHERE id = 'poem-1'"
    )
    .get() as { publicationJson: string };
  const fields = JSON.parse(row.publicationJson).fields;
  for (const [key, value] of Object.entries(PRESERVED_FIELDS))
    expect(fields[key]).toEqual(value);
  expect(fields.insights).toEqual(INSIGHTS);
  expect(fields.insightsModel).toBe("gpt-6-sol");
  expect(fields.wordGlosses.model).toBe("gpt-6-sol");
  expect(fields.modelEnrichments).toHaveLength(1);
  await expect(
    repository.claimNextPoem(token, 200, "poem-1")
  ).resolves.toBeNull();
});

test("new poems outrank incomplete publications, which outrank stale publications", async () => {
  const { repository, sqlite } = fixture();
  const token = "11111111-1111-4111-8111-111111111111";
  sqlite
    .prepare(
      `UPDATE poem SET publication_json = ?, publication_source_hash = source_hash WHERE id = 'poem-1'`
    )
    .run(
      JSON.stringify({
        schemaVersion: 2,
        active: true,
        fields: PRESERVED_FIELDS,
      })
    );
  await expect(repository.claimNextPoem(token, 100)).resolves.toMatchObject({
    poemId: "poem-2",
  });
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = NULL, rig_lease_token = NULL, rig_lease_expires_at = NULL"
    )
    .run();
  sqlite
    .prepare(
      `UPDATE poem SET publication_json = ?, publication_source_hash = 'stale' WHERE id = 'poem-2'`
    )
    .run(
      JSON.stringify({
        schemaVersion: 2,
        active: true,
        fields: PRESERVED_FIELDS,
      })
    );
  await expect(repository.claimNextPoem(token, 200)).resolves.toMatchObject({
    poemId: "poem-1",
  });
});

test("gloss-only publication preserves English and existing insights without an extra translation track", async () => {
  const { publisher, repository, sqlite } = fixture();
  const fields = {
    ...PRESERVED_FIELDS,
    insights: INSIGHTS,
    insightsModel: "Historical attribution",
    insightsTrack: "model",
  };
  sqlite
    .prepare(
      `UPDATE poem SET publication_json = ?, publication_source_hash = source_hash WHERE id = 'poem-1'`
    )
    .run(JSON.stringify({ schemaVersion: 2, active: true, fields }));
  const claim = await repository.claimNextPoem(
    "11111111-1111-4111-8111-111111111111",
    100,
    "poem-1"
  );
  const checkpoint = JSON.parse(claim!.checkpointJson!);
  expect(checkpoint.required).toEqual(["wordMeanings"]);
  sqlite
    .prepare("UPDATE poem SET rig_checkpoint_json = ? WHERE id = 'poem-1'")
    .run(
      JSON.stringify({
        ...checkpoint,
        model: "gpt-6-sol",
        outputs: { generation: { wordMeanings: [["verse"]] } },
      })
    );
  await expect(publisher.publish("poem-1", claim!.version)).resolves.toBe(true);
  const row = sqlite
    .prepare(
      "SELECT publication_json AS publicationJson FROM poem WHERE id = 'poem-1'"
    )
    .get() as { publicationJson: string };
  expect(JSON.parse(row.publicationJson).fields).toMatchObject(fields);
  expect(JSON.parse(row.publicationJson).fields.modelEnrichments).toHaveLength(
    1
  );
});
