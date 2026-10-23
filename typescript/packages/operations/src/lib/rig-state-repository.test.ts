import { readFileSync } from "node:fs";

import type { D1Database } from "@cloudflare/workers-types";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { RigPublicationRepository } from "./rig-publication-repository";
import {
  AttemptIdSchema,
  PoemIdSchema,
  RigStateRepository,
} from "./rig-state-repository";

const TEST_DATABASES: Database.Database[] = [];
afterEach(() => {
  for (const database of TEST_DATABASES) database.close();
  TEST_DATABASES.length = 0;
});

function fixture() {
  const sqlite = new Database(":memory:");
  TEST_DATABASES.push(sqlite);
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0001_schema.sql", import.meta.url),
      "utf8"
    )
  );
  sqlite
    .prepare("INSERT INTO author(id,slug,name_arabic) VALUES(?,?,'شاعر')")
    .run("author-1", "poet");
  for (const [id, source] of [
    ["poem-1", "a"],
    ["poem-2", "b"],
  ] as const)
    sqlite
      .prepare(
        `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,source_hash)
      VALUES(?,?,1,'author-1','قصيدة','{"content":["بيت"]}',?)`
      )
      .run(id, id, source.repeat(64));
  const numbered = (values: unknown[]) =>
    Object.fromEntries(
      values.map((value, index) => [String(index + 1), value])
    );
  const statementCache = new Map<string, Database.Statement>();
  const prepared = (query: string) => {
    let statement = statementCache.get(query);
    if (!statement) {
      statement = sqlite.prepare(query);
      statementCache.set(query, statement);
    }
    return statement;
  };
  const queries: string[] = [];
  const wrap = (query: string, values: unknown[] = []) => ({
    bind: (...parameters: unknown[]) => wrap(query, parameters),
    first: async () => {
      queries.push(query);
      return prepared(query).get(numbered(values)) ?? null;
    },
    all: async () => ({ results: prepared(query).all(numbered(values)) }),
    run: async () => {
      const before = prepared("SELECT total_changes()").pluck().get() as number;
      prepared(query).run(numbered(values));
      const after = prepared("SELECT total_changes()").pluck().get() as number;
      return { meta: { changes: after - before } };
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
  sqlite.pragma("foreign_keys = OFF"); // Exercise recovery from an orphaned external import.
  sqlite.pragma("foreign_keys = OFF"); // Simulate a corrupt external import.
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
  sqlite.pragma("foreign_keys = OFF"); // Simulate a corrupt external import.
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
  sqlite.pragma("foreign_keys = OFF"); // Simulate a corrupt external import.
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
  const source = await publisher.readClaimedSource("poem-1", owner, 101);
  expect(source).toMatchObject({
    linesArabic: ["بيت"],
    sourceHash: "a".repeat(64),
  });
  expect(source).not.toHaveProperty("contentArabic");
  expect(source).not.toHaveProperty("requiredJson");
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
    repository.acknowledgeInvocation(
      PoemIdSchema.parse("poem-1"),
      AttemptIdSchema.parse(attempt),
      unknown!.version,
      {
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
      }
    )
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
      AttemptIdSchema.parse("33333333-3333-4333-8333-333333333333"),
      unknown!.version
    )
  ).resolves.toBe(false);
  await expect(
    repository.retryUnknown(
      claimed!.poemId,
      AttemptIdSchema.parse(attemptId),
      unknown!.version
    )
  ).resolves.toBe(true);
  await expect(repository.read(claimed!.poemId)).resolves.toMatchObject({
    status: "retry",
  });
});

test("a manual retry runs before the unprocessed backlog", async () => {
  const { repository, sqlite, queries } = fixture();
  sqlite
    .prepare("UPDATE poem SET rig_status = 'retry' WHERE id = 'poem-2'")
    .run();
  const claimed = await repository.claimNextPoem(
    "11111111-1111-4111-8111-111111111111",
    100
  );
  expect(claimed?.poemId).toBe("poem-2");
  const retryQuery = queries.find((query) =>
    query.includes("FROM poem p INDEXED BY poem_rig_retry")
  );
  if (!retryQuery) throw new Error("Retry query was not executed");
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${retryQuery}`).all() as {
    detail: string;
  }[];
  expect(plan.some(({ detail }) => detail.includes("poem_rig_retry"))).toBe(
    true
  );
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
          `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,source_hash)
      VALUES(?,lower(hex(randomblob(16))),1,'author-1','قصيدة','{"content":["بيت"]}',?)`
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
  const { repository, sqlite, queries } = fixture();
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
  const occupancyQuery = queries.find((query) =>
    query.includes("FROM poem active INDEXED BY poem_rig_active")
  );
  if (!occupancyQuery)
    throw new Error("Atomic occupancy query was not executed");
  const plan = sqlite.prepare(`EXPLAIN QUERY PLAN ${occupancyQuery}`).all({
    1: "11111111-1111-4111-8111-000000000000",
    2: 100,
    3: "poem-1",
    4: 10,
  }) as { detail: string }[];
  expect(
    plan.some(
      ({ detail }) =>
        detail.includes("active") && detail.includes("poem_rig_active")
    )
  ).toBe(true);
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
  sqlite.exec(`
    CREATE TABLE publication_test_audit(poem_id TEXT PRIMARY KEY);
    CREATE TRIGGER publication_test_after_dirty
    AFTER UPDATE OF publication_cache_dirty ON poem
    WHEN NEW.publication_cache_dirty = 1
    BEGIN
      INSERT INTO publication_test_audit(poem_id) VALUES (NEW.id);
    END;
  `);
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
  expect(
    sqlite.prepare("SELECT poem_id AS poemId FROM publication_test_audit").all()
  ).toEqual([{ poemId: "poem-1" }]);
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
    publisher.clearCacheDirty((await publisher.pendingPurge("poem-1"))!)
  ).resolves.toBe(true);
  await expect(publisher.readPublication("poem-1")).resolves.toMatchObject({
    cacheDirty: 0,
  });
});

test("dirty marks and captured acknowledgements advance cache ownership while recovery metadata preserves it", async () => {
  const { publisher, sqlite } = fixture();
  const readGeneration = sqlite.prepare(
    "SELECT publication_cache_generation AS cacheGeneration FROM poem WHERE id = 'poem-1'"
  );
  expect(readGeneration.get()).toEqual({ cacheGeneration: 2 });
  const publication = JSON.stringify({
    active: true,
    fields: { linesEnglish: ["Saved translation"] },
  });
  const checkpoint = JSON.stringify({
    outputs: { generation: { translation: { lines: ["Paid output"] } } },
  });
  sqlite
    .prepare(
      "UPDATE poem SET publication_json = ?, rig_checkpoint_json = ?, rig_status = 'unknown', rig_version = 7 WHERE id = 'poem-1'"
    )
    .run(publication, checkpoint);
  expect(readGeneration.get()).toEqual({ cacheGeneration: 2 });
  const markDirty = sqlite.prepare(
    "UPDATE poem SET publication_cache_dirty = 1 WHERE id = 'poem-1'"
  );
  markDirty.run();
  const captured = await publisher.pendingPurge("poem-1");
  if (!captured)
    throw new Error("Expected a marked poem to have a pending purge");
  expect(captured.cacheGeneration).toBe(3);
  markDirty.run();
  const current = await publisher.pendingPurge("poem-1");
  if (!current)
    throw new Error("Expected an already-dirty mark to retain pending work");
  expect(current.cacheGeneration).toBe(4);
  await expect(publisher.clearCacheDirty(captured)).resolves.toBe(false);
  sqlite
    .prepare(
      "UPDATE poem SET rig_version = 8, rig_lease_expires_at = 200 WHERE id = 'poem-1'"
    )
    .run();
  await expect(publisher.clearCacheDirty(current)).resolves.toBe(true);
  expect(
    sqlite
      .prepare(
        "SELECT publication_cache_generation AS cacheGeneration, publication_cache_dirty AS cacheDirty, publication_json AS publicationJson, rig_checkpoint_json AS checkpointJson, rig_version AS version FROM poem WHERE id = 'poem-1'"
      )
      .get()
  ).toEqual({
    cacheGeneration: 5,
    cacheDirty: 0,
    checkpointJson: checkpoint,
    publicationJson: publication,
    version: 8,
  });
});

test.each([false, true])(
  "legacy scalar acknowledgements cannot consume newer cache work (recursive triggers %s)",
  async (recursive) => {
    const { publisher, sqlite } = fixture();
    if (recursive) sqlite.pragma("recursive_triggers=ON");
    else sqlite.pragma("recursive_triggers=OFF");
    sqlite
      .prepare(
        "UPDATE poem SET publication_cache_dirty=1, publication_hash=? WHERE id='poem-1'"
      )
      .run("c".repeat(64));
    const captured = await publisher.pendingPurge("poem-1");
    if (!captured) throw new Error("Expected pending cache work");
    sqlite
      .prepare("UPDATE poem SET publication_cache_dirty=1 WHERE id='poem-1'")
      .run();
    const current = await publisher.pendingPurge("poem-1");
    if (!current) throw new Error("Expected the newer dirty mark");
    // This is the actual pre-0098 acknowledgement: every historical fence
    // matches, but it carries no captured cache generation.
    sqlite
      .prepare(
        `UPDATE poem SET publication_cache_dirty=0
       WHERE id=?1 AND publication_hash IS ?2 AND source_hash IS ?3
         AND EXISTS (SELECT 1 FROM author a WHERE a.id=poem.author_id
           AND a.name_arabic=?4 AND a.slug=?5)`
      )
      .run({
        1: captured.poemId,
        2: captured.publicationHash,
        3: captured.sourceHash,
        4: captured.authorName,
        5: captured.authorSlug,
      });
    const retained = await publisher.pendingPurge("poem-1");
    if (!retained)
      throw new Error("Legacy acknowledgement consumed newer work");
    expect(retained.cacheGeneration).toBe(current.cacheGeneration + 1);
    await expect(publisher.clearCacheDirty(current)).resolves.toBe(false);
    await expect(publisher.clearCacheDirty(retained)).resolves.toBe(true);
    await expect(publisher.clearCacheDirty(retained)).resolves.toBe(false);
    expect(
      sqlite
        .prepare(
          "SELECT publication_cache_dirty AS dirty, publication_cache_generation AS generation FROM poem WHERE id='poem-1'"
        )
        .get()
    ).toEqual({ dirty: 0, generation: retained.cacheGeneration + 1 });
  }
);

test.each([false, true])(
  "legacy dirty clears preserve every paid/source/publication column in the same update (recursive triggers %s)",
  async (recursive) => {
    const { publisher, sqlite } = fixture();
    if (recursive) sqlite.pragma("recursive_triggers=ON");
    else sqlite.pragma("recursive_triggers=OFF");
    sqlite
      .prepare("UPDATE poem SET publication_cache_dirty=1 WHERE id='poem-1'")
      .run();
    const captured = await publisher.pendingPurge("poem-1");
    if (!captured) throw new Error("Expected pending cache work");
    const publication =
      '{"active":true,"fields":{"linesEnglish":["Saved publication"]}}';
    const checkpoint =
      '{"outputs":{"generation":{"translation":{"lines":["Paid result"]}}}}';
    const sourceHash = "d".repeat(64);
    const publicationHash = "e".repeat(64);
    sqlite
      .prepare(
        `UPDATE poem SET publication_cache_dirty=0, publication_json=?1,
       publication_hash=?2, publication_source_hash=?3, source_hash=?3,
       rig_checkpoint_json=?4, rig_version=7, rig_status='unknown',
       rig_lease_token=?5, rig_lease_expires_at=200 WHERE id='poem-1'`
      )
      .run({
        1: publication,
        2: publicationHash,
        3: sourceHash,
        4: checkpoint,
        5: "11111111-1111-4111-8111-111111111111",
      });
    expect(
      sqlite
        .prepare(
          `SELECT publication_cache_dirty AS dirty, publication_cache_generation AS generation,
       publication_json AS publicationJson, publication_hash AS publicationHash,
       publication_source_hash AS publicationSourceHash, source_hash AS sourceHash,
       rig_checkpoint_json AS checkpointJson, rig_version AS version, rig_status AS status,
       rig_lease_token AS token, rig_lease_expires_at AS expiresAt FROM poem WHERE id='poem-1'`
        )
        .get()
    ).toEqual({
      dirty: 1,
      generation: captured.cacheGeneration + 1,
      publicationJson: publication,
      publicationHash,
      publicationSourceHash: sourceHash,
      sourceHash,
      checkpointJson: checkpoint,
      version: 7,
      status: "unknown",
      token: "11111111-1111-4111-8111-111111111111",
      expiresAt: 200,
    });
    await expect(publisher.clearCacheDirty(captured)).resolves.toBe(false);
    const retained = await publisher.pendingPurge("poem-1");
    if (!retained) throw new Error("Expected the mixed update to retain work");
    await expect(publisher.clearCacheDirty(retained)).resolves.toBe(true);
  }
);

test.each([false, true])(
  "legacy migration bulk clears retain dirty null-hash rows for captured batch acknowledgement (recursive triggers %s)",
  async (recursive) => {
    const { publisher, sqlite } = fixture();
    if (recursive) sqlite.pragma("recursive_triggers=ON");
    else sqlite.pragma("recursive_triggers=OFF");
    sqlite
      .prepare(
        "UPDATE poem SET publication_cache_dirty=1, publication_hash=NULL, publication_source_hash=source_hash"
      )
      .run();
    const captured = await publisher.pendingPurges();
    sqlite
      .prepare(
        `UPDATE poem SET publication_cache_dirty=0
       WHERE publication_cache_dirty=1 AND publication_hash IS NULL
         AND publication_source_hash IS source_hash`
      )
      .run();
    const retained = await publisher.pendingPurges();
    expect(retained).toHaveLength(2);
    expect(retained.map((row) => row.cacheGeneration)).toEqual(
      captured.map((row) => row.cacheGeneration + 1)
    );
    await expect(publisher.clearCacheDirtyBatch(captured)).resolves.toBe(0);
    await expect(publisher.clearCacheDirtyBatch(retained)).resolves.toBe(2);
    await expect(publisher.pendingPurges()).resolves.toEqual([]);
  }
);

test("cache batches are bounded and never clear republished or source-changed rows", async () => {
  const { publisher, sqlite } = fixture();
  for (let index = 3; index <= 60; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,source_hash)
      VALUES(?,lower(hex(randomblob(16))),1,'author-1','قصيدة','{"content":["بيت"]}',?)`
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
  await expect(publisher.clearCacheDirtyBatch(rows)).resolves.toBe(48);
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

test("targeted dirty publication lookup uses the poem identity index instead of scanning the dirty backlog", async () => {
  const { publisher, sqlite, queries } = fixture();
  sqlite.prepare("UPDATE poem SET publication_cache_dirty = 1").run();
  await expect(publisher.pendingPurge("poem-2")).resolves.toMatchObject({
    poemId: "poem-2",
  });
  const explainedQuery = `EXPLAIN QUERY PLAN ${queries.at(-1)!}`;
  const plan = sqlite.prepare(explainedQuery).all({ "1": "poem-2" }) as {
    detail: string;
  }[];
  expect(
    plan.some(({ detail }) => detail.includes("sqlite_autoindex_poem_1 (id=?)"))
  ).toBe(true);
  await expect(publisher.pendingPurge()).resolves.toMatchObject({
    poemId: "poem-1",
  });
});

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
    `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,
       source_hash,publication_source_hash,publication_json,rig_status)
     VALUES(?,lower(hex(randomblob(16))),1,'author-1','قصيدة','{"content":["بيت"]}',?,?,?,'complete')`
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
    `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,
       source_hash,publication_source_hash,publication_json)
     VALUES(?,lower(hex(randomblob(16))),1,'author-1','قصيدة','{"content":["بيت"]}',?,?,?)`
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
        "INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic) VALUES(?,lower(hex(randomblob(16))),1,'author-1','poem','{\"content\":[\"verse\"]}')"
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
    "INSERT INTO poem(id,slug,verses,name_arabic,content_arabic,rig_status,rig_lease_expires_at) VALUES(?,lower(hex(randomblob(16))),1,'poem','{\"content\":[\"بيت\"]}','dispatching',90)"
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

test("publication metadata uses the actual author's canonical namespace and stable poem slug", async () => {
  const { sqlite, publisher } = fixture();
  sqlite.exec(
    `UPDATE poem SET publication_json='{"schemaVersion":2,"active":false,"fields":{}}' WHERE id='poem-1'`
  );
  const prior = await publisher.readPublication("poem-1");
  expect(prior).toMatchObject({
    canonicalAuthorSlug: "poet",
    canonicalPoemSlug: "poem-1",
  });
  sqlite.exec(`INSERT INTO public_author_segment(segment,namespace_id) SELECT 'clean-author',id FROM public_author_namespace WHERE author_id='author-1';
    UPDATE public_author_namespace SET canonical_slug='clean-author' WHERE author_id='author-1';
    UPDATE poem SET public_slug='first-line-0123456789abcdef',public_slug_language='en' WHERE id='poem-1'`);
  const current = await publisher.readPublication("poem-1");
  expect(current).toMatchObject({
    authorSlug: "poet",
    canonicalAuthorSlug: "clean-author",
    canonicalPoemSlug: "first-line-0123456789abcdef",
  });
  expect(current?.snapshot).toEqual(prior?.snapshot);
});

test("new poems after author identity replacement use the current canonical namespace", async () => {
  const { sqlite, publisher } = fixture();
  sqlite.pragma("foreign_keys = OFF"); // Simulate an imported author identity replacement.
  sqlite.exec(`UPDATE author SET id='replacement' WHERE id='author-1';
    UPDATE public_author_namespace SET author_id=NULL WHERE author_id='author-1';
    INSERT INTO public_author_segment(segment,namespace_id) SELECT 'replacement-author',id FROM public_author_namespace WHERE author_id='replacement';
    UPDATE public_author_namespace SET canonical_slug='replacement-author' WHERE author_id='replacement'`);
  sqlite
    .prepare(
      `INSERT INTO poem(id,slug,verses,author_id,name_arabic,content_arabic,source_hash,publication_json)
      VALUES('new-poem','new-poem',1,'replacement','قصيدة','{"content":["بيت"]}',?,'{"schemaVersion":2,"active":false,"fields":{}}')`
    )
    .run("c".repeat(64));
  sqlite.exec(
    "UPDATE poem SET public_slug='new-first-line',public_slug_language='ar' WHERE id='new-poem'"
  );
  await expect(publisher.readPublication("new-poem")).resolves.toMatchObject({
    authorSlug: "poet",
    canonicalAuthorSlug: "replacement-author",
    canonicalPoemSlug: "new-first-line",
  });
  expect(
    sqlite
      .prepare(
        `SELECT n.author_id AS authorId FROM public_author_segment s JOIN public_author_namespace n ON n.id=s.namespace_id WHERE s.segment='poet'`
      )
      .get()
  ).toEqual({ authorId: null });
  expect(
    sqlite
      .prepare(
        `SELECT a.poem_id AS poemId FROM public_poem_alias a JOIN public_author_namespace n ON n.id=a.author_namespace_id WHERE n.author_id='replacement' AND a.segment='new-poem'`
      )
      .get()
  ).toEqual({ poemId: "new-poem" });
});
