export async function readBoundedJsonBody(
  stream: null | ReadableStream<Uint8Array>,
  maximumBytes: number,
  tooLargeMessage: string
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  if (!stream) throw new Error("Missing body");

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Stream chunks must be read sequentially to enforce the byte limit before requesting more data.
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        // eslint-disable-next-line no-await-in-loop -- Cancel the owned reader before releasing its lock after exceeding the byte limit.
        await reader.cancel();
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}
