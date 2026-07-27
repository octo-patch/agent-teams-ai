export async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    return Buffer.byteLength(raw, 'utf8') <= maxBytes ? raw : null;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return Buffer.concat(chunks, totalBytes).toString('utf8');
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(Buffer.from(chunk.value));
    }
  } finally {
    reader.releaseLock();
  }
}
