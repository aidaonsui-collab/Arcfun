/** Minimal `next/server` stand-in so the indexer daemon can import lib/arc-trades. */
export function after(fn) {
  queueMicrotask(() => {
    try {
      void fn()
    } catch {
      /* ignore */
    }
  })
}

export class NextRequest {}

export class NextResponse {
  static json(body, init) {
    return { body, init }
  }
}
