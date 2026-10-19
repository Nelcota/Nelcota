import { QueryClient } from '@tanstack/svelte-query'
import { session } from './session.svelte'

// JSON reads share a short-lived cache. SQL execution and all writes always
// reach the server; a session boundary cancels and discards private data.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 2000, gcTime: 60_000, structuralSharing: false } },
})
let revision = 0
const readers = new Map<string, number>()

type Outcome<T> = { value: T } | { error: unknown }
type Waiter<T> = { complete: ((outcome: Outcome<T>) => void) | undefined }

// Keep promise reactions outside the reader's closure. An aborted reader
// clears its slot, releasing its signal and component before the fetch settles.
function observe<T>(pending: Promise<T>, waiter: Waiter<T>) {
  void pending.then(value => waiter.complete?.({ value }), error => waiter.complete?.({ error }))
}

export const querySession = () => session.epoch

export function clearQuerySession() {
  session.epoch++
  revision = 0
  queryClient.clear()
}

export async function queryRead<T>(path: string, account: string | null | undefined, fetcher: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, freshForMs = 2000): Promise<T> {
  signal?.throwIfAborted()
  const started = querySession()
  const queryKey = ['admin', started, revision, account, path]
  const key = JSON.stringify(queryKey)
  readers.set(key, (readers.get(key) ?? 0) + 1)
  try {
    const pending = queryClient.fetchQuery({ queryKey, queryFn: ({ signal }) => fetcher(signal), staleTime: freshForMs })
    // Cancelling one reader must not cancel another reader of the same query.
    const result = signal ? await new Promise<T>((resolve, reject) => {
      const waiter: Waiter<T> = { complete: undefined }
      const complete = (outcome: Outcome<T>) => {
        waiter.complete = undefined
        signal.removeEventListener('abort', abort)
        if ('error' in outcome) { reject(outcome.error); return }
        resolve(outcome.value)
      }
      const abort = () => complete({ error: signal.reason ?? new DOMException('Aborted', 'AbortError') })
      waiter.complete = complete
      signal.addEventListener('abort', abort, { once: true })
      observe(pending, waiter)
      // A synchronous adapter can abort while fetchQuery starts its request.
      if (signal.aborted) abort()
    }) : await pending
    if (started !== querySession()) throw new DOMException('Session changed', 'AbortError')
    // Table cell editing mutates local rows; it must not mutate cached JSON.
    return structuredClone(result)
  } finally {
    const remaining = (readers.get(key) ?? 1) - 1
    if (remaining > 0) {
      readers.set(key, remaining)
    }
    if (remaining === 0) {
      readers.delete(key)
      if (signal?.aborted) void queryClient.cancelQueries({ queryKey, exact: true })
    }
  }
}

export function invalidateReads() {
  // A read started before a write may still resolve afterwards. New readers
  // must neither join that request nor cache its pre-mutation result.
  revision++
  void queryClient.invalidateQueries({ queryKey: ['admin'], refetchType: 'none' })
}
