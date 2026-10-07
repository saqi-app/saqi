import { readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import { wordGlossesFromMeanings } from "@saqi/precedent-iso";
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
      hidden INTEGER NOT NULL DEFAULT 0, slug TEXT NOT NULL DEFAULT 'poet');
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
  const queries: string[] = [];
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => {
      queries.push(query);
      return sqlite.prepare(query).get(numbered(values)) ?? null;
    },
    all: async () => ({ results: sqlite.prepare(query).all(numbered(values)) }),
    run: async () => {
      const result = sqlite.prepare(query).run(numbered(values));
      return { meta: { changes: result.changes } };
    },
  });
  const database = { prepare: wrap } as unknown as D1Database;
  const repository = new RigStateRepository(database);
  const publisher = new RigPublicationRepository({
    prepare: wrap,
    batch: async (statements: { run: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.run())),
  } as unknown as D1Database);
  return { publisher, repository, sqlite, database, queries };
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
    },
  });
  expect(JSON.parse(published.publicationJson).fields.insights).toBeUndefined();
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

test.each([
  "preparing a well-rope as an aid to draw from it.",
  "O garden whose roses are red!",
])(
  "a retained valid translation with ordinary poetic wording can be published: %s",
  async (line) => {
    const { publisher, sqlite } = fixture();
    const checkpoint = JSON.stringify({
      model: "gpt-6.1-sol",
      reasoningEffort: "xhigh",
      sourceHash: "a".repeat(64),
      outputs: {
        generation: {
          translation: { lines: [line] },
          wordMeanings: [["verse"]],
        },
      },
    });
    sqlite
      .prepare(
        "UPDATE poem SET rig_status = 'blocked', rig_version = 4, rig_checkpoint_json = ? WHERE id = 'poem-1'"
      )
      .run(checkpoint);
    await expect(publisher.publish("poem-1", 3)).resolves.toBe(false);
    expect(
      sqlite
        .prepare(
          "SELECT rig_version AS version, rig_checkpoint_json AS checkpoint FROM poem WHERE id = 'poem-1'"
        )
        .get()
    ).toEqual({ version: 4, checkpoint });
    await expect(publisher.publish("poem-1", 4)).resolves.toBe(true);
    const row = sqlite
      .prepare(
        "SELECT rig_status AS status, rig_version AS version, rig_checkpoint_json AS checkpoint, publication_json AS publication FROM poem WHERE id = 'poem-1'"
      )
      .get() as {
      status: string;
      version: number;
      checkpoint: null;
      publication: string;
    };
    expect(row).toMatchObject({
      status: "complete",
      version: 5,
      checkpoint: null,
    });
    expect(JSON.parse(row.publication)).toMatchObject({
      active: true,
      fields: {
        modelEnrichments: [
          { lines: [line], model: "gpt-6.1-sol", reasoningEffort: "xhigh" },
        ],
      },
    });
    await expect(publisher.publish("poem-1", 4)).resolves.toBe(false);
  }
);

test.each([
  "As an AI, I cannot interpret this poem.",
  "As an AI: here is a summary.",
])(
  "a genuine AI disclaimer stays blocked on explicit retry: %s",
  async (line) => {
    const { publisher, repository, sqlite } = fixture();
    const checkpoint = JSON.stringify({
      model: "gpt-6.1-sol",
      sourceHash: "a".repeat(64),
      outputs: {
        generation: {
          translation: { lines: [line] },
          wordMeanings: [["verse"]],
        },
      },
    });
    sqlite
      .prepare(
        "UPDATE poem SET rig_status = 'blocked', rig_version = 4, rig_checkpoint_json = ? WHERE id = 'poem-1'"
      )
      .run(checkpoint);
    await expect(publisher.publish("poem-1", 4)).resolves.toBe("blocked");
    expect(
      sqlite
        .prepare(
          "SELECT rig_status AS status, rig_checkpoint_json AS checkpoint, publication_json AS publication FROM poem WHERE id = 'poem-1'"
        )
        .get()
    ).toEqual({ status: "blocked", checkpoint, publication: null });
    await expect(
      repository.claimNextPoem("11111111-1111-4111-8111-111111111111", 100)
    ).resolves.toMatchObject({ poemId: "poem-2" });
  }
);

test("an unknown paid result cannot be published by the blocked-result recovery path", async () => {
  const { publisher, sqlite } = fixture();
  const checkpoint = JSON.stringify({
    model: "gpt-6.1-sol",
    sourceHash: "a".repeat(64),
    outputs: {
      generation: {
        translation: { lines: ["A verse"] },
        wordMeanings: [["verse"]],
      },
    },
  });
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'unknown', rig_version = 4, rig_checkpoint_json = ? WHERE id = 'poem-1'"
    )
    .run(checkpoint);
  await expect(publisher.publish("poem-1", 4)).resolves.toBe(false);
  expect(
    sqlite
      .prepare(
        "SELECT rig_status AS status, rig_checkpoint_json AS checkpoint, publication_json AS publication FROM poem WHERE id = 'poem-1'"
      )
      .get()
  ).toEqual({ status: "unknown", checkpoint, publication: null });
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

test("missing glosses are selected without regenerating current English", async () => {
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
    required: ["wordMeanings"],
  });
  await expect(
    publisher.readClaimedSource("poem-1", token, 101)
  ).resolves.toMatchObject({ required: ["wordMeanings"] });
  const checkpoint = {
    ...JSON.parse(claim!.checkpointJson!),
    model: "gpt-6-sol",
    reasoningEffort: "medium",
    phase: "publish",
    outputs: { generation: { wordMeanings: [["verse"]] } },
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
  expect(fields.insights).toBeUndefined();
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

test("gloss-only publication preserves English and drops legacy insights", async () => {
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
  const published = JSON.parse(row.publicationJson).fields;
  expect(published.linesEnglish).toEqual(fields.linesEnglish);
  expect(published.wordGlosses).toBeDefined();
  expect(published.insights).toBeUndefined();
  expect(published.modelEnrichments).toHaveLength(1);
});

test.each([10, 20, 40, 80])(
  "concurrent claims atomically enforce %i slots and distinct poems",
  async (maxConcurrent) => {
    const { repository, sqlite } = fixture();
    for (let index = 3; index <= maxConcurrent + 5; index += 1) {
      sqlite
        .prepare(
          `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,source_hash)
      VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?)`
        )
        .run(`poem-${String(index)}`, "c".repeat(64));
    }
    const claimed = new Set<string>();
    for (let round = 0; round < maxConcurrent + 5; round += 1) {
      const results = await Promise.all(
        Array.from({ length: maxConcurrent + 5 }, (_, index) =>
          repository.claimNextPoem(
            `11111111-1111-4111-8111-${String(round * (maxConcurrent + 5) + index).padStart(12, "0")}`,
            100,
            undefined,
            maxConcurrent
          )
        )
      );
      for (const result of results) {
        if (result) {
          expect(claimed.has(result.poemId)).toBe(false);
          claimed.add(result.poemId);
        }
      }
    }
    expect(claimed.size).toBe(maxConcurrent);
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS count FROM poem WHERE rig_status = 'claimed'"
        )
        .get()
    ).toEqual({ count: maxConcurrent });
  }
);

test("ten-worker mode cannot duplicate a targeted poem or reclaim dispatched work", async () => {
  const { repository, sqlite } = fixture();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      repository.claimNextPoem(
        `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        100,
        "poem-1",
        10
      )
    )
  );
  expect(results.filter((result) => result !== null)).toHaveLength(1);
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'dispatching', rig_lease_expires_at = 200 WHERE id = 'poem-1'"
    )
    .run();
  await expect(
    repository.claimNextPoem(
      "22222222-2222-4222-8222-222222222222",
      201,
      "poem-1",
      10
    )
  ).resolves.toBeNull();
  await expect(
    repository.claimNextPoem(
      "22222222-2222-4222-8222-222222222222",
      201,
      undefined,
      10
    )
  ).resolves.toMatchObject({ poemId: "poem-2" });
});

test("concurrent claims leave acknowledged output with its publisher", async () => {
  const { publisher, repository, sqlite } = fixture();
  const checkpoint = JSON.stringify({
    phase: "publish",
    sourceHash: "a".repeat(64),
    model: "gpt-6.1-sol",
    outputs: {
      generation: {
        translation: { lines: ["A verse"] },
        wordMeanings: [["verse"]],
      },
    },
  });
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'claimed', rig_version = 3, rig_lease_expires_at = NULL, rig_checkpoint_json = ? WHERE id = 'poem-1'"
    )
    .run(checkpoint);
  const owner = "11111111-1111-4111-8111-111111111111";
  await expect(
    repository.claimNextPoem(owner, 100, "poem-1", 10)
  ).resolves.toBeNull();
  await expect(
    repository.claimNextPoem(owner, 100, undefined, 10)
  ).resolves.toMatchObject({ poemId: "poem-2" });
  await expect(repository.read("poem-1")).resolves.toMatchObject({
    version: 3,
    checkpointJson: checkpoint,
  });
  await expect(publisher.publish("poem-1", 3)).resolves.toBe(true);
});

test("publication verification reads the actual snapshot and cache state", async () => {
  const { publisher, sqlite } = fixture();
  await expect(publisher.readPublication("poem-1")).resolves.toBeNull();
  const checkpoint = JSON.stringify({
    phase: "publish",
    sourceHash: "a".repeat(64),
    model: "gpt-6.1-sol",
    reasoningEffort: "xhigh",
    outputs: {
      generation: {
        translation: { lines: ["A verse"] },
        wordMeanings: [["verse"]],
      },
    },
  });
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'claimed', rig_version = 3, rig_checkpoint_json = ? WHERE id = 'poem-1'"
    )
    .run(checkpoint);
  await expect(publisher.publish("poem-1", 3)).resolves.toBe(true);
  const published = await publisher.readPublication("poem-1");
  expect(published).toMatchObject({
    authorSlug: "poet",
    sourceHash: "a".repeat(64),
    publicationSourceHash: "a".repeat(64),
    cacheDirty: 1,
    snapshot: {
      active: true,
      fields: {
        modelEnrichments: [
          {
            modelKey: "saqi-current",
            model: "gpt-6.1-sol",
            reasoningEffort: "xhigh",
            lines: ["A verse"],
          },
        ],
        wordGlosses: {
          sourceHash: "a".repeat(64),
          meanings: {
            lines: [
              { lineIndex: 0, segments: [{ kind: "word", meaning: "verse" }] },
            ],
          },
        },
      },
    },
  });
  expect(published?.publicationHash).toMatch(/^[a-f0-9]{64}$/);
  await expect(
    publisher.clearCacheDirty(
      "poem-1",
      published!.publicationHash,
      "a".repeat(64)
    )
  ).resolves.toBe(true);
  await expect(publisher.readPublication("poem-1")).resolves.toMatchObject({
    cacheDirty: 0,
  });
});

test("cache batches are bounded and never clear republished or source-changed rows", async () => {
  const { publisher, sqlite } = fixture();
  for (let index = 3; index <= 60; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,source_hash)
      VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?)`
      )
      .run(`batch-${String(index).padStart(3, "0")}`, "a".repeat(64));
  }
  sqlite
    .prepare(
      "UPDATE poem SET publication_cache_dirty = 1, publication_hash = ?"
    )
    .run("a".repeat(64));
  const rows = await publisher.pendingPurges();
  expect(rows).toHaveLength(50);
  sqlite
    .prepare("UPDATE poem SET publication_hash = ? WHERE id = ?")
    .run("b".repeat(64), rows[0]?.poemId);
  sqlite
    .prepare("UPDATE poem SET source_hash = ? WHERE id = ?")
    .run("c".repeat(64), rows[1]?.poemId);
  await publisher.clearCacheDirtyBatch(rows);
  expect(
    sqlite
      .prepare(
        "SELECT count(*) AS count FROM poem WHERE publication_cache_dirty = 1"
      )
      .get()
  ).toEqual({ count: 12 });
  const remaining = await publisher.pendingPurges();
  expect(remaining.map((row) => row.poemId)).toEqual(
    expect.arrayContaining([rows[0]?.poemId, rows[1]?.poemId])
  );
});

const ElegyId = "b2d4eaf2-6345-4049-8132-a489b785dad7";
const ElegyCorrection = readFileSync(
  new URL("../../migrations/0095_correct_elegy_adjective.sql", import.meta.url),
  "utf8"
);

async function elegyFixture() {
  const setup = fixture();
  const arabic = [
    "عطية إن صادفت روح محمد",
    "أخيك وصنويك العليين من قبل",
    ...Array.from({ length: 16 }, () => "بيت"),
  ];
  const output = {
    translation: {
      lines: [
        "Atiyya, if you meet the soul of Muhammad,",
        "your brother, and your two brothers, the two Alis, who went before,",
        ...Array.from({ length: 16 }, () => "A verse."),
      ],
    },
    wordMeanings: [
      ["Atiyya", "if", "you meet", "soul", "Muhammad"],
      [
        "your brother",
        "and your two brothers",
        "the two Alis",
        "from",
        "before",
      ],
      ...Array.from({ length: 16 }, () => ["verse"]),
    ],
  };
  setup.sqlite
    .prepare("UPDATE poem SET id = ?, content_arabic = ? WHERE id = 'poem-1'")
    .run(ElegyId, JSON.stringify({ content: arabic }));
  const owner = "11111111-1111-4111-8111-111111111111";
  const attemptId = "33333333-3333-4333-8333-333333333333";
  const claimed = await setup.repository.claimNextPoem(owner, 100, ElegyId);
  await expect(
    setup.repository.beginInvocation(ElegyId, owner, claimed!.version, {
      attemptId,
      inputHash: "c".repeat(64),
      model: "gpt-6.1-sol",
      reasoningEffort: "xhigh",
      startedAt: 101,
      deadlineAt: 200,
    })
  ).resolves.toBe(true);
  const dispatched = await setup.repository.read(ElegyId);
  await expect(
    setup.repository.acknowledgeInvocation(
      ElegyId,
      attemptId,
      dispatched!.version,
      output
    )
  ).resolves.toBe(true);
  const acknowledged = await setup.repository.read(ElegyId);
  await expect(
    setup.publisher.publish(ElegyId, acknowledged!.version)
  ).resolves.toBe(true);
  return { ...setup, arabic, output };
}

test("elegy correction reuses paid output, preserves the public snapshot until publishing, and is idempotent", async () => {
  const { sqlite, repository, publisher, arabic, output } =
    await elegyFixture();
  const prior = await publisher.readPublication(ElegyId);
  const unrelated = sqlite
    .prepare("SELECT * FROM poem WHERE id = 'poem-2'")
    .get();
  sqlite.exec(ElegyCorrection);
  const staged = await repository.read(ElegyId);
  expect(staged).toMatchObject({
    status: "blocked",
    version: 5,
    leaseToken: null,
  });
  const corrected = structuredClone(output);
  corrected.translation.lines[1] =
    "your brother, and your two noble brothers who went before,";
  corrected.wordMeanings[1]![2] = "the two noble ones";
  expect(JSON.parse(staged!.checkpointJson!)).toEqual({
    phase: "publish",
    sourceHash: "a".repeat(64),
    required: ["translation", "wordMeanings"],
    model: "gpt-6.1-sol",
    reasoningEffort: "xhigh",
    outputs: { generation: corrected },
  });
  await expect(publisher.readPublication(ElegyId)).resolves.toEqual(prior);
  sqlite.exec(ElegyCorrection);
  await expect(repository.read(ElegyId)).resolves.toEqual(staged);
  await expect(publisher.publish(ElegyId, staged!.version)).resolves.toBe(true);
  const published = await publisher.readPublication(ElegyId);
  const expectedSnapshot = structuredClone(prior!.snapshot);
  expectedSnapshot.fields.modelEnrichments![0]!.lines =
    corrected.translation.lines;
  expectedSnapshot.fields.wordGlosses!.meanings = wordGlossesFromMeanings(
    arabic,
    corrected.wordMeanings
  );
  expect(published!.snapshot).toEqual(expectedSnapshot);
  expect(published!.publicationHash).not.toBe(prior!.publicationHash);
  expect(published!.cacheDirty).toBe(1);
  await expect(repository.read(ElegyId)).resolves.toMatchObject({
    status: "complete",
    version: 6,
    checkpointJson: null,
  });
  sqlite.exec(ElegyCorrection);
  await expect(publisher.readPublication(ElegyId)).resolves.toEqual(published);
  expect(
    sqlite.prepare("SELECT * FROM poem WHERE id = 'poem-2'").get()
  ).toEqual(unrelated);
});

test.each([
  "rig_status = 'dispatching'",
  "rig_status = 'unknown'",
  "rig_version = 5",
  "rig_lease_token = 'another-owner'",
  "source_hash = 'different-source'",
  "content_arabic = json_set(content_arabic, '$.content[1]', 'changed Arabic')",
  "publication_json = json_set(publication_json, '$.fields.modelEnrichments[0].lines[1]', 'An editorial correction')",
  "publication_json = json_set(publication_json, '$.fields.modelEnrichments[0].reasoningEffort', 'medium')",
  "publication_json = json_set(publication_json, '$.fields.wordGlosses.meanings.lines[1].segments[4].meaning', 'an editorial gloss')",
])(
  "elegy correction refuses changed or in-flight state: %s",
  async (change) => {
    const { sqlite } = await elegyFixture();
    sqlite.prepare(`UPDATE poem SET ${change} WHERE id = ?`).run(ElegyId);
    const before = sqlite
      .prepare("SELECT * FROM poem WHERE id = ?")
      .get(ElegyId);
    sqlite.exec(ElegyCorrection);
    expect(
      sqlite.prepare("SELECT * FROM poem WHERE id = ?").get(ElegyId)
    ).toEqual(before);
  }
);

test("bounded discovery advances across completed pages and shares its hint across requests", async () => {
  const { sqlite, database, queries } = fixture();
  const hash = "a".repeat(64);
  const publication = JSON.stringify({
    active: true,
    fields: {
      linesEnglish: ["A verse"],
      wordGlosses: { sourceHash: hash, meanings: { lines: [{}] } },
    },
  });
  sqlite.exec("UPDATE poem SET rig_status = 'unknown'");
  const insert = sqlite.prepare(
    `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,
       source_hash,publication_source_hash,publication_json,rig_status)
     VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?,?,?,'complete')`
  );
  sqlite.transaction(() => {
    for (let index = 0; index < 1_200; index += 1)
      insert.run(`a${String(index).padStart(5, "0")}`, hash, hash, publication);
  })();
  sqlite.prepare("UPDATE poem SET rig_status = NULL WHERE id = 'poem-2'").run();
  const cursor = { afterPoemId: "", priority: 0 };
  const token = "11111111-1111-4111-8111-111111111111";
  await expect(
    new RigStateRepository(database, cursor).claimNextPoem(
      token,
      100,
      undefined,
      80
    )
  ).resolves.toBeNull();
  const pages = queries.filter((query) => query.includes("AS MATERIALIZED"));
  expect(pages).toHaveLength(8);
  expect(cursor.afterPoemId).not.toBe("");
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${pages[0]!}`)
    .all({ 1: "", 2: 100, 3: 80, 4: 0 }) as { detail: string }[];
  expect(plan.some(({ detail }) => detail === "MATERIALIZE candidates")).toBe(
    true
  );
  expect(
    plan.some(({ detail }) =>
      /SEARCH poem USING (?:COVERING )?INDEX .*\(id>\?\)/u.test(detail)
    )
  ).toBe(true);
  await expect(
    new RigStateRepository(database, cursor).claimNextPoem(
      token,
      100,
      undefined,
      80
    )
  ).resolves.toMatchObject({ poemId: "poem-2" });
  expect(
    sqlite
      .prepare(
        "SELECT count(*) AS count FROM poem WHERE rig_status = 'complete'"
      )
      .get()
  ).toEqual({ count: 1_200 });
});

test("bounded discovery preserves untranslated priority across page boundaries", async () => {
  const { sqlite, repository } = fixture();
  const hash = "a".repeat(64);
  const publication = JSON.stringify({
    active: true,
    fields: { linesEnglish: ["Keep this English"] },
  });
  sqlite.exec("UPDATE poem SET rig_status = 'blocked'");
  const insert = sqlite.prepare(
    `INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic,
       source_hash,publication_source_hash,publication_json)
     VALUES(?,0,1,'author-1','قصيدة','{"content":["بيت"]}',?,?,?)`
  );
  sqlite.transaction(() => {
    for (let index = 0; index < 130; index += 1)
      insert.run(`a${String(index).padStart(5, "0")}`, hash, hash, publication);
    insert.run("z-untranslated", hash, null, null);
  })();
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  await expect(
    repository.claimNextPoem(first, 100, undefined, 80)
  ).resolves.toMatchObject({ poemId: "z-untranslated" });
  await expect(
    repository.claimNextPoem(second, 100, undefined, 80)
  ).resolves.toMatchObject({
    poemId: "a00000",
    checkpointJson: expect.stringContaining('"required":["wordMeanings"]'),
  });
});

test("a completed scan wraps to newly due work before the old hint", async () => {
  const { database } = fixture();
  const cursor = { afterPoemId: "z", priority: 2 };
  const repository = new RigStateRepository(database, cursor);
  const token = "11111111-1111-4111-8111-111111111111";
  await expect(
    repository.claimNextPoem(token, 100, undefined, 80)
  ).resolves.toBeNull();
  await expect(
    repository.claimNextPoem(token, 100, undefined, 80)
  ).resolves.toMatchObject({ poemId: "poem-1" });
});

test("saved-attempt lookup finds only the exact fenced unknown attempt through the active index", async () => {
  const { repository, sqlite, queries } = fixture();
  const attemptId = "11111111-1111-4111-8111-111111111111";
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'dispatching', rig_checkpoint_json = ? WHERE id = 'poem-1'"
    )
    .run(JSON.stringify({ invocation: { attemptId } }));
  await expect(repository.readUnknownAttempt(attemptId)).resolves.toBeNull();
  sqlite
    .prepare(
      "UPDATE poem SET rig_status = 'unknown', rig_lease_token = NULL, rig_lease_expires_at = NULL WHERE id = 'poem-1'"
    )
    .run();
  await expect(repository.readUnknownAttempt(attemptId)).resolves.toMatchObject(
    {
      poemId: "poem-1",
      status: "unknown",
      checkpointJson: expect.stringContaining(attemptId),
    }
  );
  await expect(
    repository.readUnknownAttempt("22222222-2222-4222-8222-222222222222")
  ).resolves.toBeNull();
  const lookup = queries.find(
    (query) =>
      query.includes("INDEXED BY poem_rig_active") &&
      query.includes("attemptId")
  );
  expect(lookup).toBeDefined();
  const plan = sqlite
    .prepare(`EXPLAIN QUERY PLAN ${lookup!}`)
    .all({ 1: attemptId }) as { detail: string }[];
  expect(
    plan.some(({ detail }) => detail.includes("USING INDEX poem_rig_active"))
  ).toBe(true);
  sqlite
    .prepare("UPDATE poem SET rig_status = 'complete' WHERE id = 'poem-1'")
    .run();
  await expect(repository.readUnknownAttempt(attemptId)).resolves.toBeNull();
});

test("queue diagnostics count canonical slots without expiring or changing paid work", async () => {
  const { repository, sqlite } = fixture();
  for (let index = 3; index <= 6; index += 1)
    sqlite
      .prepare(
        "INSERT INTO poem(id,hidden,publishable,author_id,name_arabic,content_arabic) VALUES(?,0,1,'author-1','poem','{\"content\":[\"verse\"]}')"
      )
      .run(`poem-${String(index)}`);
  const update = sqlite.prepare(
    "UPDATE poem SET rig_status=?,rig_lease_expires_at=?,rig_version=2 WHERE id=?"
  );
  update.run("dispatching", 90, "poem-1");
  update.run("claimed", 200, "poem-2");
  update.run("claimed", 90, "poem-3");
  update.run("unknown", 200, "poem-4");
  update.run("dispatching", 200, "poem-5");
  update.run("complete", 200, "poem-6");
  sqlite.prepare("UPDATE poem SET rig_checkpoint_json=? WHERE id='poem-1'").run(
    JSON.stringify({
      invocation: { attemptId: "11111111-1111-4111-8111-111111111111" },
    })
  );
  const rows = () =>
    sqlite
      .prepare(
        "SELECT id,rig_status,rig_version,rig_checkpoint_json FROM poem ORDER BY id"
      )
      .all();
  const before = rows();
  await expect(repository.queueDiagnostics(100)).resolves.toEqual({
    checkedAt: 100,
    activeSlots: 3,
    states: [
      { status: "claimed", poems: 2, activeSlots: 1 },
      { status: "dispatching", poems: 2, activeSlots: 2 },
      { status: "unknown", poems: 1, activeSlots: 0 },
    ],
    expiredDispatches: [
      {
        poemId: "poem-1",
        version: 2,
        leaseExpiresAt: 90,
        attemptId: "11111111-1111-4111-8111-111111111111",
      },
    ],
  });
  expect(rows()).toEqual(before);
});

test("queue diagnostics bound expired previews and read the active-state index", async () => {
  const { sqlite, database } = fixture();
  const insert = sqlite.prepare(
    "INSERT INTO poem(id,hidden,publishable,name_arabic,content_arabic,rig_status,rig_lease_expires_at) VALUES(?,0,1,'poem','{}','dispatching',90)"
  );
  for (let index = 0; index < 81; index += 1)
    insert.run(`old-${String(index).padStart(3, "0")}`);
  const queries: string[] = [];
  const repository = new RigStateRepository({
    prepare: (query: string) => {
      queries.push(query);
      return database.prepare(query);
    },
  } as unknown as D1Database);
  const diagnostic = await repository.queueDiagnostics(100);
  expect(diagnostic.activeSlots).toBe(81);
  expect(diagnostic.expiredDispatches).toHaveLength(80);
  expect(diagnostic.expiredDispatches.at(-1)?.poemId).toBe("old-079");
  for (const query of queries) {
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${query}`)
      .all({ 1: 100 }) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("poem_rig_active"))).toBe(
      true
    );
  }
});
