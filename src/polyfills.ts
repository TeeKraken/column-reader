// Small fill-ins for browsers a year or two old (and Safari), which pdf.js
// expects. Loaded on the page and inside the pdf.js worker.

type IterableStream = ReadableStream & { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };

const proto = (globalThis.ReadableStream?.prototype ?? null) as IterableStream | null;
if (proto && !proto[Symbol.asyncIterator]) {
  proto[Symbol.asyncIterator] = async function* (this: ReadableStream) {
    const reader = this.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

const url = URL as unknown as { parse?: (u: string | URL, base?: string | URL) => URL | null };
if (typeof url.parse !== "function") {
  url.parse = (u, base) => {
    try {
      return new URL(u, base);
    } catch {
      return null;
    }
  };
}

export {};
