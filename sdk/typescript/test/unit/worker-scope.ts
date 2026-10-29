/** Simulate a worker global without introducing window or document. */
export class WorkerScopeFixture {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value === globalThis;
  }
}
