import { clientError, fail, ok, type Result } from './errors.js';

type Outcome<T> = { value: T } | { error: unknown };
type Observer<T> = (outcome: Outcome<T>) => void;
const waiting = new WeakMap<Promise<unknown>, Set<Observer<unknown>>>();

/** One reaction per shared operation; cancelled callers can leave its set. */
function observers<T>(operation: Promise<T>): Set<Observer<T>> {
  const existing = waiting.get(operation) as Set<Observer<T>> | undefined;
  if (existing) return existing;
  const listeners = new Set<Observer<T>>();
  waiting.set(operation, listeners as Set<Observer<unknown>>);
  const complete = (outcome: Outcome<T>): void => {
    waiting.delete(operation);
    for (const listener of listeners) listener(outcome);
    listeners.clear();
  };
  // Observe rejection even if every caller has already cancelled.
  void operation.then(value => complete({ value }), error => complete({ error }));
  return listeners;
}

/** Cancel a caller's wait without interrupting a shared operation. */
export function abortable<T>(operation: Promise<T>, signal?: AbortSignal, withdraw?: () => void): Promise<Result<T>> {
  if (!signal) return operation.then(value => ok(value));
  const listeners = observers(operation);
  return new Promise<Result<T>>((resolve, reject) => {
    const cleanup = (): void => {
      listeners.delete(complete);
      signal.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      cleanup();
      withdraw?.();
      resolve(fail(clientError('aborted', 'The request was aborted')));
    };
    const complete: Observer<T> = outcome => {
      cleanup();
      if ('error' in outcome) { reject(outcome.error); return; }
      resolve(ok(outcome.value));
    };
    listeners.add(complete);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}
