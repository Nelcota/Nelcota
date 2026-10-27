// PostgreSQL 17 keywords that cannot be a bare column name in an expression:
// the "reserved" and "reserved (can be function or type)" categories of the
// SQL Key Words appendix. `user = auth.uid()` would read `current_user`.
const RESERVED = new Set([
  'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc', 'asymmetric', 'authorization', 'binary', 'both',
  'case', 'cast', 'check', 'collate', 'collation', 'column', 'concurrently', 'constraint', 'create', 'cross',
  'current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time', 'current_timestamp',
  'current_user', 'default', 'deferrable', 'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
  'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike', 'in', 'initially', 'inner', 'intersect',
  'into', 'is', 'isnull', 'join', 'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
  'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order', 'outer', 'overlaps', 'placing',
  'primary', 'references', 'returning', 'right', 'select', 'session_user', 'similar', 'some', 'symmetric',
  'system_user', 'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique', 'user', 'using',
  'variadic', 'verbose', 'when', 'where', 'window', 'with',
])

/** Quotes only when the name is not a plain lowercase identifier or is a reserved keyword. */
export function quoteIfNeeded(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && RESERVED.has(name) === false ? name : `"${name.replaceAll('"', '""')}"`
}
