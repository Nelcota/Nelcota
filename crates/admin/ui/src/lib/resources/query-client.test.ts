import { afterEach, expect, it } from 'vitest'
import { clearQuerySession, invalidateReads, queryRead } from './query-client'

afterEach(clearQuerySession)

it('deduplicates reads and isolates editable rows from the cache', async () => {
  let calls = 0
  const fetcher = async () => { calls++; return { rows: [{ value: 'original' }] } }
  const [first, second] = await Promise.all([queryRead('/rows', 'admin', fetcher), queryRead('/rows', 'admin', fetcher)])
  first.rows[0].value = 'edited'
  expect(second.rows[0].value).toBe('original')
  expect((await queryRead('/rows', 'admin', fetcher)).rows[0].value).toBe('original')
  expect(calls).toBe(1)
  invalidateReads()
  await queryRead('/rows', 'admin', fetcher)
  expect(calls).toBe(2)
})

it('cancelling one subscriber preserves another subscriber', async () => {
  let finish!: (value: string) => void
  const fetcher = () => new Promise<string>(resolve => { finish = resolve })
  const controller = new AbortController()
  const first = queryRead('/shared', 'admin', fetcher, controller.signal)
  const second = queryRead('/shared', 'admin', fetcher)
  const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  finish('data')
  await rejected
  expect(await second).toBe('data')
})

it('discards in-flight and cached private data at a session boundary', async () => {
  let finish!: (value: string) => void
  const pending = queryRead('/private', 'admin', () => new Promise<string>(resolve => { finish = resolve }))
  const rejected = expect(pending).rejects.toBeDefined()
  clearQuerySession()
  finish('old private data')
  await rejected
  expect(await queryRead('/private', 'admin', async () => 'new session')).toBe('new session')
})

it('starts a fresh read after a mutation while an older read is still pending', async () => {
  let finish!: (value: string) => void
  const older = queryRead('/rows', 'admin', () => new Promise<string>(resolve => { finish = resolve }))
  invalidateReads()
  const newer = queryRead('/rows', 'admin', async () => 'updated')
  finish('before mutation')
  await older
  expect(await newer).toBe('updated')
  expect(await queryRead('/rows', 'admin', async () => 'unexpected')).toBe('updated')
})

it('cancels an abandoned shared request so a retry can start a new one', async () => {
  let finish!: (value: string) => void
  let upstream!: AbortSignal
  const controller = new AbortController()
  const abandoned = queryRead('/retry', 'admin', signal => {
    upstream = signal
    return new Promise<string>(resolve => { finish = resolve })
  }, controller.signal)
  const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  const retry = queryRead('/retry', 'admin', async () => 'new request')
  finish('old request')
  expect(await retry).toBe('new request')
  expect(upstream.aborted).toBe(true)
})

it('observes cancellation triggered while the fetcher starts', async () => {
  const controller = new AbortController()
  await expect(queryRead('/immediate', 'admin', async () => {
    controller.abort()
    return 'cancelled data'
  }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
})

// Run with Vitest's `--pool forks --execArgv=--expose-gc`.
const collect = (globalThis as { gc?: () => void }).gc
it.skipIf(!collect)('releases cancelled readers while another reader still waits', async () => {
  let finish!: (value: string) => void
  const active = queryRead('/retention', 'admin', () => new Promise<string>(resolve => { finish = resolve }))
  async function cancel() {
    const controller = new AbortController()
    const reference = new WeakRef(controller.signal)
    const pending = queryRead('/retention', 'admin', async () => 'unexpected', controller.signal)
    controller.abort()
    // Vitest retains async assertion failures and their native stack frames
    // until the test finishes. Do not let the test harness own these signals.
    await pending.then(() => { throw new Error('Reader ignored cancellation') }, error => {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
    })
    return reference
  }
  try {
    const references = []
    for (let index = 0; index < 1000; index++) references.push(await cancel())
    for (let index = 0; index < 10; index++) {
      await new Promise(resolve => setTimeout(resolve, 0))
      collect!()
    }
    expect(references.filter(reference => reference.deref() !== undefined)).toHaveLength(0)
  } finally {
    finish('accepted')
    expect(await active).toBe('accepted')
  }
})
