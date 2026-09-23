import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import { acquireLegacyMaintenanceLock } from "../runtime/acquire-legacy-maintenance-lock.js";
import {
  LedgerMigrationEngine,
  LedgerMigrator,
  MIGRATIONS,
} from "./migrations.js";
import { queryRequired } from "./sqlite-query.js";
import { sha256 } from "./work-key.js";

const VersionSchema = z.strictObject({ version: z.int().min(30).max(34) });
const ControlsSchema = z.strictObject({
  service: z.literal(0),
  global: z.literal(1),
  paid: z.literal(1),
  pauseImported: z.literal(1),
  serviceImported: z.literal(1),
  running: z.literal(0),
});
interface StagingResult {
  readonly fromVersion: number;
  readonly mode: "applied" | "dry_run";
  readonly targetVersion: 34;
}

/** Offline schema30–34 only, in a trusted stopped runtime directory. Stop every
 * legacy runner first: no protocol can fence an arbitrary old process ignoring it.
 * This never clears locks, imports operation authority, arms budgets, or advances35. */
export async function stageLegacyOperationSchema34(options: {
  readonly stateDirectory: string;
  readonly apply?: boolean;
}): Promise<StagingResult> {
  const root = resolve(options.stateDirectory);
  const file = join(root, "ledger.sqlite3");
  const lockPath = join(root, "RUN.lock");
  await plain(root, true);
  await plain(file, false);
  if (await exists(lockPath))
    throw new Error("SCHEMA34_STAGE_REQUIRES_STOPPED_OWNER");
  await noLegacyLocks(root);
  const database = new Database(file, {
    fileMustExist: true,
    readonly: options.apply !== true,
    timeout: 5000,
  });
  try {
    const repository = new Schema34StagingRepository(database);
    const fromVersion = repository.assertStopped();
    if (options.apply !== true)
      return { mode: "dry_run", fromVersion, targetVersion: 34 };
    const lock = await acquireLegacyMaintenanceLock(
      lockPath,
      sha256("schema34-offline-staging"),
    );
    try {
      await repository.apply(fromVersion, root);
      return { mode: "applied", fromVersion, targetVersion: 34 };
    } finally {
      await lock.release();
    }
  } finally {
    database.close();
  }
}

class Schema34StagingRepository {
  readonly #database: Database.Database;
  constructor(database: Database.Database) {
    this.#database = database;
  }

  async apply(fromVersion: number, root: string): Promise<void> {
    this.#database.pragma("synchronous = FULL");
    this.#database.exec("BEGIN EXCLUSIVE");
    try {
      if (this.assertStopped() !== fromVersion)
        throw new Error("SCHEMA34_STAGE_VERSION_CHANGED");
      await noLegacyLocks(root);
      for (const migration of MIGRATIONS) {
        if (migration.version <= fromVersion || migration.version > 34)
          continue;
        new LedgerMigrationEngine(this.#database).apply(migration);
      }
      if (this.assertStopped() !== 34)
        throw new Error("SCHEMA34_STAGE_INCOMPLETE");
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  assertStopped(): number {
    const { version } = queryRequired(
      { operation: "schema34Stage.supportedVersion30Through34" },
      () =>
        this.#database
          .prepare("SELECT version FROM local_schema WHERE singleton=1")
          .get(),
      VersionSchema,
    );
    new LedgerMigrator(this.#database).assertConfiguredSourceIdentity();
    queryRequired(
      { operation: "schema34Stage.stoppedControls" },
      () =>
        this.#database
          .prepare(
            `SELECT
      (SELECT enabled FROM runtime_control WHERE control_key='service_enabled') AS service,
      (SELECT enabled FROM runtime_control WHERE control_key='global_paused') AS global,
      (SELECT enabled FROM runtime_control WHERE control_key='paid_work_paused') AS paid,
      (SELECT enabled FROM runtime_control WHERE control_key='legacy_pause_imported') AS pauseImported,
      (SELECT enabled FROM runtime_control WHERE control_key='legacy_service_imported') AS serviceImported,
      (SELECT COUNT(*) FROM work_item WHERE state='running') AS running`,
          )
          .get(),
      ControlsSchema,
    );
    return version;
  }
}

async function noLegacyLocks(root: string): Promise<void> {
  const attempts = join(root, "sol-attempts");
  if (!(await exists(attempts))) return;
  await plain(attempts, true);
  const index = join(attempts, "operation-index");
  if (!(await exists(index))) return;
  await plain(index, true);
  const directory = await opendir(index);
  let count = 0;
  for await (const entry of directory) {
    if (++count > 100_000) throw new Error("SCHEMA34_STAGE_INDEX_LIMIT");
    if (entry.name.includes(".lock") || !entry.isFile())
      throw new Error("SCHEMA34_STAGE_LEGACY_LOCK_OR_UNSAFE_ENTRY");
  }
}

async function plain(path: string, directory: boolean): Promise<void> {
  const stat = await lstat(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile())
  )
    throw new Error("SCHEMA34_STAGE_UNSAFE_PATH");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
