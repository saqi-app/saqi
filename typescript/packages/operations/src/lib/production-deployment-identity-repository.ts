import type { D1Database } from "@cloudflare/workers-types";
import { z } from "zod";

interface ProductionDeploymentIdentityReader {
  matchesProduction(): Promise<boolean>;
}

const ProductionSchemaRowSchema = z.object({ name: z.string() });
const REQUIRED_MIGRATION = "0064_retire_collection_dashboard.sql";

// Deployment verifies the remote D1 UUID through `wrangler d1 info`; this
// runtime check only rejects an outdated schema without reading a source-writer
// singleton. Remove it with the legacy Operations endpoints after cutover.
export class ProductionDeploymentIdentityRepository implements ProductionDeploymentIdentityReader {
  readonly #database: D1Database;

  constructor(database: D1Database) {
    this.#database = database;
  }

  async matchesProduction(): Promise<boolean> {
    try {
      const row = await this.#database
        .prepare("SELECT name FROM d1_migrations WHERE name = ?1")
        .bind(REQUIRED_MIGRATION)
        .first<unknown>();
      return ProductionSchemaRowSchema.parse(row).name === REQUIRED_MIGRATION;
    } catch {
      return false;
    }
  }
}
