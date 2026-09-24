import { z } from "zod";

export const SolImportReceiptSchema = z.strictObject({
  sourceDigest: z.string().regex(/^[a-f\d]{64}$/),
  records: z.int().nonnegative(),
  sourceBytes: z.int().nonnegative(),
  importedAt: z.int().nonnegative(),
});
export type SolImportReceipt = z.infer<typeof SolImportReceiptSchema>;

const SOL_IMPORT_RECEIPT_LEGACY_SQL = `SELECT source_digest AS sourceDigest,
  record_count AS records, source_bytes AS sourceBytes, imported_at AS importedAt
  FROM sol_operation_import_receipt WHERE singleton = 1`;
const SOL_IMPORT_RECEIPT_SQL = `SELECT sol_import_source_digest AS sourceDigest,
  sol_import_record_count AS records, sol_import_source_bytes AS sourceBytes,
  sol_imported_at AS importedAt FROM local_schema
  WHERE singleton = 1 AND sol_import_source_digest IS NOT NULL`;

export function solImportReceiptQuery(version: number): string {
  return version < 44 ? SOL_IMPORT_RECEIPT_LEGACY_SQL : SOL_IMPORT_RECEIPT_SQL;
}
