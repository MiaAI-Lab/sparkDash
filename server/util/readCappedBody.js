/**
 * Read a fetch response body up to `maxBytes`, counting bytes as they arrive so a body
 * without Content-Length (or a compressed one) is never buffered whole before the cap applies.
 * Returns the bytes, or null when the body is larger than the cap (the stream is cancelled).
 */
export async function readCappedBody(body, maxBytes) {
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}
