interface CatalogStatement {
  all(): Promise<{ results: unknown[] }>;
  bind(...values: unknown[]): CatalogStatement;
}

export interface CatalogDatabase {
  batch(statements: CatalogStatement[]): Promise<{ results: unknown[] }[]>;
  prepare(query: string): CatalogStatement;
}

export function catalogDatabaseFromD1(database: D1Database): CatalogDatabase {
  const session = database.withSession();
  const nativeStatements = new WeakMap<CatalogStatement, D1PreparedStatement>();
  const wrapStatement = (native: D1PreparedStatement): CatalogStatement => {
    const statement: CatalogStatement = {
      all: () => native.all<unknown>(),
      bind: (...values) => wrapStatement(native.bind(...values)),
    };
    nativeStatements.set(statement, native);
    return statement;
  };

  return {
    batch: (statements) =>
      session.batch(
        statements.map((statement) => {
          const native = nativeStatements.get(statement);
          if (!native) throw new Error("CATALOG_FOREIGN_D1_STATEMENT");
          return native;
        }),
      ),
    prepare: (query) => wrapStatement(session.prepare(query)),
  };
}
