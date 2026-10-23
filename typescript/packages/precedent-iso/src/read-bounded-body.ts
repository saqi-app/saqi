// Workers and Node expose different generic/BYOB stream declarations. This
// reader contract is the common byte-stream surface consumed at this boundary.
interface BodyReader {
  cancel(reason?: unknown): Promise<unknown>;
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  releaseLock(): void;
}

export interface BodyStream {
  getReader(): BodyReader;
}

export async function readBoundedTextBody(
  stream: BodyStream | null,
  maximumBytes: number,
  tooLargeMessage: string,
  signal?: AbortSignal
): Promise<string> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  if (!stream) throw new Error("Missing body");

  const reader = stream.getReader();
  const abort = () => {
    reader.cancel(signal?.reason).catch(() => {
      /* Cancellation cannot replace the caller's timeout or body error. */
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    if (signal?.aborted) {
      abort();
      signal.throwIfAborted();
    }
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Stream chunks must be read sequentially to enforce the byte limit before requesting more data.
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (!value) throw new Error("Missing body bytes");
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        reader.cancel().catch(() => {
          /* Oversize rejection and lock release cannot wait for transport cleanup. */
        });
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

export async function readBoundedJsonBody(
  stream: BodyStream | null,
  maximumBytes: number,
  tooLargeMessage: string,
  signal?: AbortSignal
): Promise<unknown> {
  return JSON.parse(
    await readBoundedTextBody(stream, maximumBytes, tooLargeMessage, signal)
  );
}

export function cancelBody(body: BodyStream | null): void {
  if (!body) return;
  const reader = body.getReader();
  try {
    reader.cancel().catch(() => {
      /* Transport cleanup cannot delay the caller or retain our lock. */
    });
  } finally {
    reader.releaseLock();
  }
}
