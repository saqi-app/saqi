import type {
  D1Database,
  D1PreparedStatement,
} from "@cloudflare/workers-types";
import { describe, expect, it, vi } from "vitest";

import { ProductionDeploymentIdentityRepository } from "../production-deployment-identity-repository";

function identityReader() {
  const first = vi.fn<D1PreparedStatement["first"]>();
  const bind = vi.fn<D1PreparedStatement["bind"]>();
  function unexpected(): never {
    throw new Error("Unexpected database operation");
  }
  const statement: D1PreparedStatement = {
    all: unexpected,
    bind,
    first,
    raw: unexpected,
    run: unexpected,
  };
  const prepare = vi.fn<D1Database["prepare"]>().mockReturnValue(statement);
  bind.mockReturnValue(statement);
  const database: D1Database = {
    batch: unexpected,
    dump: unexpected,
    exec: unexpected,
    prepare,
    withSession: unexpected,
  };
  return {
    bind,
    first,
    prepare,
    repository: new ProductionDeploymentIdentityRepository(database),
  };
}

describe("production deployment identity", () => {
  it.each([
    ["missing row", null],
    ["missing migration", {}],
    ["malformed migration", { name: 42 }],
    ["wrong migration", { name: "another_migration.sql" }],
    ["wrong alias", { migration_name: "0064_retire_collection_dashboard.sql" }],
  ])("fails closed for %s", async (_label, row) => {
    const { first, repository } = identityReader();
    first.mockResolvedValue(row);
    await expect(repository.matchesProduction()).resolves.toBe(false);
  });

  it("fails closed when the identity query fails", async () => {
    const { first, repository } = identityReader();
    first.mockRejectedValue(new Error("D1 unavailable"));
    await expect(repository.matchesProduction()).resolves.toBe(false);
  });

  it("accepts only the applied current schema migration", async () => {
    const { bind, first, prepare, repository } = identityReader();
    first.mockResolvedValue({ name: "0064_retire_collection_dashboard.sql" });
    await expect(repository.matchesProduction()).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      "SELECT name FROM d1_migrations WHERE name = ?1"
    );
    expect(bind).toHaveBeenCalledExactlyOnceWith(
      "0064_retire_collection_dashboard.sql"
    );
    expect(first).toHaveBeenCalledExactlyOnceWith();
  });
});
