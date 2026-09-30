// Preloaded into the API under test through NODE_OPTIONS, never into the API
// itself. RSS read from outside keeps what the allocator holds after V8 has
// freed it, so a flat heap can look like a leak there. This reads the heap from
// inside, after a forced collection, every two seconds.
import {appendFileSync} from "node:fs";

const out = process.env.NOKTURN_TORTURE_HEAP_LOG;
if (out && typeof globalThis.gc === "function") {
  setInterval(() => {
    globalThis.gc();
    appendFileSync(out, `${process.memoryUsage().heapUsed}\n`);
  }, 2000).unref();
}
