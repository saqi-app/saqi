import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";

import { RuntimeOwnerRecordSchema } from "../persistence/runtime-owner-schema.js";

/** Historical offline staging/import only. Never reclaims an existing file;
 * schema35 runtime ownership must exclusively use the SQLite owner store. */
export async function acquireLegacyMaintenanceLock(
  path: string,
  configDigest: string,
): Promise<{ release(): Promise<void> }> {
  const record = RuntimeOwnerRecordSchema.parse({
    configDigest,
    pid: process.pid,
    runId: randomUUID(),
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
  });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      const current = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await current.stat();
        if (!metadata.isFile() || metadata.size > 4096)
          throw new Error("LEGACY_MAINTENANCE_LOCK_INVALID");
        const bytes = Buffer.alloc(4097);
        const { bytesRead } = await current.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 4096)
          throw new Error("LEGACY_MAINTENANCE_LOCK_INVALID");
        const parsed: unknown = JSON.parse(
          bytes.subarray(0, bytesRead).toString("utf8"),
        );
        const owner = RuntimeOwnerRecordSchema.parse(parsed);
        if (owner.runId !== record.runId || owner.pid !== record.pid)
          throw new Error("LEGACY_MAINTENANCE_LOCK_OWNER_CHANGED");
        // No historical maintenance participant reclaims files. Old runners
        // must remain stopped throughout this deliberately offline protocol.
        await unlink(path);
        released = true;
      } finally {
        await current.close();
      }
    },
  };
}
