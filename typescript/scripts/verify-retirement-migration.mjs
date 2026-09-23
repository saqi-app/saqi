import { Buffer } from "node:buffer";
import process from "node:process";

const chunks = await Array.fromAsync(process.stdin);
const executions = JSON.parse(Buffer.concat(chunks).toString("utf8"));
if (
  !Array.isArray(executions) ||
  executions.length !== 1 ||
  executions[0]?.success !== true
) {
  throw new Error("RETIREMENT_MIGRATION_QUERY_FAILED");
}
const rows = executions[0].results;
if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.applied !== 1) {
  throw new Error(
    "RETIREMENT_MIGRATION_MISSING: apply the production 0037 migration before using this workflow.",
  );
}
