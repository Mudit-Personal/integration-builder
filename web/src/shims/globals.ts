import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer;

// Safari has no async iterator on ReadableStream, and the runtime reads bodies with for await.
const proto = ReadableStream.prototype as unknown as { [Symbol.asyncIterator]?: () => AsyncGenerator<Uint8Array> };
proto[Symbol.asyncIterator] ??= async function* (this: ReadableStream<Uint8Array>) {
  const reader = this.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
};
