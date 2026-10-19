import { RemoteResource } from '$lib/resources/remote-resource.svelte'
import type { SchemaResponse, SqlResponse } from '$lib/contracts/types'
import type { RunAsRequest } from './run-as.svelte'

export interface SqlAdapter {
  schema(signal: AbortSignal): Promise<SchemaResponse>
  execute(sql: string, signal: AbortSignal, runAs?: RunAsRequest): Promise<SqlResponse>
}

/** Owns SQL request lifetime, timing and results independently of the page. */
export class SqlExecution {
  readonly schema = new RemoteResource<SchemaResponse>()
  running = $state(false)
  response = $state<SqlResponse | null>(null)
  error = $state<unknown>(null)
  elapsed = $state(0)
  private generation = 0
  private controller?: AbortController

  constructor(private adapter: SqlAdapter, private now = () => performance.now()) {}

  loadSchema() { return this.schema.load(signal => this.adapter.schema(signal)) }

  async run(sql: string, runAs?: RunAsRequest): Promise<boolean> {
    if (this.running || !sql.trim()) return false
    const generation = ++this.generation
    const controller = this.controller = new AbortController()
    const started = this.now()
    this.running = true
    this.error = null
    try {
      const response = await this.adapter.execute(sql, controller.signal, runAs)
      if (generation !== this.generation) return false
      this.response = response
      return true
    } catch (error) {
      if (generation === this.generation && !controller.signal.aborted) this.error = error
      return false
    } finally {
      if (generation === this.generation) {
        this.elapsed = Math.round(this.now() - started)
        this.running = false
        this.controller = undefined
      }
    }
  }

  /**
   * Stops the running query (the server cancels it when the request drops)
   * and keeps the previous result. Schema loading is left alone.
   */
  stop() {
    this.generation++
    this.controller?.abort()
    this.controller = undefined
    this.running = false
  }

  cancel() {
    this.stop()
    this.schema.cancel()
  }
}

/** SQL that may create, change or remove objects: autocomplete should reload. */
export const changesSchema = (sql: string) => /\b(create|alter|drop)\b/i.test(sql)
