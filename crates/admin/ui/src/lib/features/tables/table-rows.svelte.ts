import { RemoteResource } from '$lib/resources/remote-resource.svelte'
import { rowKey, rowPk } from '$lib/features/tables/grid'
import type { RowData, TableData } from '$lib/contracts/types'

export interface TableRowsAdapter {
  read(table: string, params: URLSearchParams, signal: AbortSignal): Promise<TableData>
  update(table: string, pk: RowData, values: RowData): Promise<{ count: number }>
  remove(table: string, pks: RowData[]): Promise<{ count: number }>
}

/** Owns row loading, selection and reconciliation across navigation and writes. */
export class TableRows {
  private resource = new RemoteResource<TableData>()
  private target?: { table: string; params: URLSearchParams }
  private loadSeq = 0
  selected = $state<Set<number>>(new Set())
  saving = $state(false)

  constructor(private adapter: TableRowsAdapter) {}

  get data() { return this.resource.data }
  get loading() { return this.resource.loading }
  get error() { return this.resource.error }

  setTable(table?: string) {
    if (this.target?.table !== table || (this.data && this.data.table.name !== table)) {
      this.resource.clear()
      this.target = undefined
      this.selected = new Set()
    }
  }

  async load(table: string, params: URLSearchParams) {
    this.loadSeq++
    this.setTable(table)
    const target = this.target = { table, params: new URLSearchParams(params) }
    this.selected = new Set()
    await this.resource.load(signal => this.adapter.read(target.table, new URLSearchParams(target.params), signal))
  }

  cancel() { this.resource.cancel() }

  /** Forgets the loaded rows, so a read as someone else never shows stale ones. */
  clear() {
    this.resource.clear()
    this.target = undefined
    this.selected = new Set()
  }

  private async reload(table: string) {
    if (this.target?.table === table) await this.load(table, this.target.params)
  }

  async edit(pk: RowData, column: string, value: string | null): Promise<number | undefined> {
    const data = this.data, target = this.target, seq = this.loadSeq
    if (!data || !target || this.loading || this.saving || data.table.name !== target.table || !data.table.editable) return undefined
    const table = target.table
    const key = rowKey(pk, data.table.primary_key)
    this.saving = true
    try {
      const result = await this.adapter.update(table, { ...pk }, { [column]: value })
      if (this.target?.table !== table) return result.count
      if (this.data === data && this.loadSeq === seq) {
        if (result.count > 0) this.replaceCell(data, key, column, value)
        return result.count
      }
      await this.reload(table)
      return result.count
    } finally {
      this.saving = false
    }
  }

  // Rows are raw state: a saved cell replaces its row and the page object,
  // and every other row keeps its identity.
  private replaceCell(data: TableData, key: string, column: string, value: string | null) {
    const index = data.rows.findIndex(candidate => rowKey(candidate, data.table.primary_key) === key)
    const row = data.rows[index]
    if (row === undefined) return
    this.resource.data = { ...data, rows: data.rows.with(index, { ...row, [column]: value }) }
  }

  async deleteSelected(): Promise<number | undefined> {
    const data = this.data, target = this.target
    if (!data || !target || this.loading || this.saving || !data.table.editable || data.table.name !== target.table) return undefined
    const pks = [...this.selected].map(index => data.rows[index]).filter((row): row is RowData => !!row)
      .map(row => rowPk(row, data.table.primary_key))
    if (!pks.length) return undefined
    this.saving = true
    try {
      const result = await this.adapter.remove(target.table, pks)
      await this.reload(target.table)
      return result.count
    } finally {
      this.saving = false
    }
  }
}
