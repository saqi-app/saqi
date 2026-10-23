import { expect, test, vi } from "vitest";

import {
  readBoundedJsonBody,
  readBoundedTextBody,
} from "../read-bounded-body.js";

test("decodes UTF-8 characters split across chunks within the exact byte budget", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xd8]));
      controller.enqueue(new Uint8Array([0xa8]));
      controller.close();
    },
  });
  await expect(readBoundedTextBody(body, 2, "too large")).resolves.toBe("ب");
  expect(body.locked).toBe(false);
});

test("rejects malformed UTF-8 rather than replacing bytes in a JSON identity", async () => {
  const body = new Response(new Uint8Array([0x22, 0xff, 0x22])).body;
  await expect(readBoundedJsonBody(body, 3, "too large")).rejects.toThrow();
  expect(body?.locked).toBe(false);
});

test("overflow rejection releases the lock without waiting for transport cancellation", async () => {
  const cancel = vi.fn(
    () =>
      new Promise<void>(() => {
        /* Simulate transport cleanup that never settles. */
      })
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3));
    },
    cancel,
  });
  await expect(readBoundedTextBody(body, 2, "too large")).rejects.toThrow(
    "too large"
  );
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

test("aborting after a valid JSON prefix cannot turn cancelled input into success", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(new TextEncoder().encode('{"ok":true}'));
    },
  });
  const result = readBoundedJsonBody(body, 100, "too large", controller.signal);
  await Promise.resolve();
  controller.abort(new Error("cancelled"));
  await expect(result).rejects.toThrow("cancelled");
  expect(body.locked).toBe(false);
});

test("already-aborted reads cancel and release the body", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  await expect(
    readBoundedTextBody(body, 100, "too large", controller.signal)
  ).rejects.toThrow("cancelled");
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
