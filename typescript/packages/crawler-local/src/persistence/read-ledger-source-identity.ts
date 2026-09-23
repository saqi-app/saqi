import { SourceConfigurationSchema } from "@saqi/precedent-iso";
import type { SourceConfiguration } from "@saqi/source-adapter";
import Database from "better-sqlite3";

/** Reads the ledger's own source fence for source-independent diagnostics. */
export function readLedgerSourceIdentity(path: string): SourceConfiguration {
  const database = new Database(path, { fileMustExist: true, readonly: true });
  try {
    // eslint-disable-next-line @sarj/require-sql-access-class -- This bounded read bootstraps the diagnostic connection's source fence before Ledger can be opened.
    const row = database
      .prepare(
        `SELECT source_name AS name, source_origin AS origin
           FROM local_source_identity WHERE singleton = 1`,
      )
      .get();
    return SourceConfigurationSchema.parse(row);
  } finally {
    database.close();
  }
}
