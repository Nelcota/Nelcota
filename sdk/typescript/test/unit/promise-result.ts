/**
 * Executes a callback immediately and represents its value or exception as a promise.
 *
 * @remarks
 * Synchronous adapters and listener callbacks retain their immediate side effects.
 * Thrown exceptions become rejections without introducing an extra scheduled task.
 *
 * @param work - Callback implementing a synchronous operation or returning a promise.
 * @returns A promise adopting the callback's outcome.
 */
export function promiseResult<T>(work: () => T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(work());
  });
}
