/**
 * Minimal in-memory stand-in for the supabase-js query builder.
 *
 * Implements only the surface lib/health.ts and lib/operations.ts actually
 * use: from().select().eq().in().order().single(), plus insert/update/upsert
 * with an onConflict key. Awaiting a builder runs it, matching PostgREST's
 * thenable behaviour.
 *
 * Deliberately not a general Postgres emulator - it exists so the tests
 * exercise our logic, not the driver.
 */

export type Row = Record<string, any>

type Op =
  | { kind: 'select' }
  | { kind: 'insert'; rows: Row[] }
  | { kind: 'update'; patch: Row }
  | { kind: 'upsert'; rows: Row[]; onConflict?: string }

export type Result = { data: any; error: { message: string } | null }

export class FakeSupabase {
  tables: Record<string, Row[]>
  /** Every awaited operation, for asserting on writes. */
  log: Array<{ table: string; op: string; detail?: unknown }> = []
  private seq = 0
  /** Set to a message to make the next matching read fail. */
  failOn: { table: string; kind: string; message: string } | null = null

  constructor(seed: Record<string, Row[]> = {}) {
    this.tables = {}
    for (const [name, rows] of Object.entries(seed)) {
      this.tables[name] = rows.map((r) => ({ ...r }))
    }
  }

  nextId(prefix = 'id') {
    this.seq += 1
    return `${prefix}-${String(this.seq).padStart(4, '0')}`
  }

  table(name: string): Row[] {
    if (!this.tables[name]) this.tables[name] = []
    return this.tables[name]
  }

  from(name: string) {
    return new FakeQuery(this, name)
  }
}

class FakeQuery implements PromiseLike<Result> {
  private filters: Array<(row: Row) => boolean> = []
  private op: Op = { kind: 'select' }
  private selectColumns: string | null = null
  private singleMode = false
  private sort: { column: string; ascending: boolean } | null = null

  constructor(
    private db: FakeSupabase,
    private tableName: string,
  ) {}

  select(columns = '*') {
    this.selectColumns = columns
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push((row) => row[column] === value)
    return this
  }

  in(column: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[column]))
    return this
  }

  order(column: string, opts: { ascending?: boolean } = {}) {
    this.sort = { column, ascending: opts.ascending !== false }
    return this
  }

  single() {
    this.singleMode = true
    return this
  }

  insert(rows: Row | Row[]) {
    this.op = { kind: 'insert', rows: Array.isArray(rows) ? rows : [rows] }
    return this
  }

  update(patch: Row) {
    this.op = { kind: 'update', patch }
    return this
  }

  upsert(rows: Row | Row[], opts: { onConflict?: string } = {}) {
    this.op = {
      kind: 'upsert',
      rows: Array.isArray(rows) ? rows : [rows],
      onConflict: opts.onConflict,
    }
    return this
  }

  private matching(): Row[] {
    return this.db
      .table(this.tableName)
      .filter((row) => this.filters.every((f) => f(row)))
  }

  private run(): Result {
    const fail = this.db.failOn
    if (fail && fail.table === this.tableName && fail.kind === this.op.kind) {
      this.db.failOn = null
      return { data: null, error: { message: fail.message } }
    }

    const rows = this.db.table(this.tableName)
    let produced: Row[] = []

    switch (this.op.kind) {
      case 'select': {
        produced = this.matching().map((r) => ({ ...r }))
        if (this.sort) {
          const { column, ascending } = this.sort
          produced.sort((a, b) => {
            const av = a[column], bv = b[column]
            const cmp = av === bv ? 0 : av > bv ? 1 : -1
            return ascending ? cmp : -cmp
          })
        }
        break
      }

      case 'insert': {
        for (const row of this.op.rows) {
          const created = { id: this.db.nextId(this.tableName), ...row }
          rows.push(created)
          produced.push({ ...created })
        }
        this.db.log.push({
          table: this.tableName,
          op: 'insert',
          detail: this.op.rows,
        })
        break
      }

      case 'update': {
        const targets = this.matching()
        for (const row of targets) Object.assign(row, this.op.patch)
        produced = targets.map((r) => ({ ...r }))
        this.db.log.push({
          table: this.tableName,
          op: 'update',
          detail: this.op.patch,
        })
        break
      }

      case 'upsert': {
        const keys = (this.op.onConflict ?? 'id').split(',').map((k) => k.trim())
        for (const row of this.op.rows) {
          const existing = rows.find((candidate) =>
            keys.every((k) => candidate[k] === row[k]),
          )
          if (existing) {
            Object.assign(existing, row)
            produced.push({ ...existing })
          } else {
            const created = { id: this.db.nextId(this.tableName), ...row }
            rows.push(created)
            produced.push({ ...created })
          }
        }
        this.db.log.push({
          table: this.tableName,
          op: 'upsert',
          detail: this.op.rows,
        })
        break
      }
    }

    if (this.singleMode) {
      if (produced.length === 0) {
        return { data: null, error: { message: 'No rows found' } }
      }
      return { data: produced[0], error: null }
    }

    return { data: produced, error: null }
  }

  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected)
  }
}

/** Cast helper - the fake structurally satisfies the calls we make. */
export function asClient(fake: FakeSupabase): any {
  return fake
}
