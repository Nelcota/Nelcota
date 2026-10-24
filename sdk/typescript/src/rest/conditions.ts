/**
 * Conditions for `or`/`and` groups, built from typed calls instead of
 * strings, so a value can never close a group or add a filter of its own.
 */

import { NelcotaUsageError } from '../core/errors.js';
import { identifier, inList, quote, scalar, type FilterScalar } from '../core/encoding.js';

/** A filter value for a column of type `T`. */
export type FilterValue<T> = unknown extends T ? FilterScalar : 0 extends 1 & T
  ? FilterScalar
  : [NonNullable<T>] extends [never]
    ? FilterScalar
    : NonNullable<T> extends number | string
      ? [Extract<NonNullable<T>, number>] extends [never]
        ? string extends NonNullable<T> ? string | Date : NonNullable<T>
        : number | bigint | string
      : NonNullable<T> extends boolean
        ? boolean
        : string;


const encoded: unique symbol = Symbol('nelcota.condition');

export interface Condition {
  readonly [encoded]: string;
}

function condition(text: string): Condition {
  return { [encoded]: text };
}

export function encodeCondition(value: Condition): string {
  if (typeof value !== 'object' || value === null || typeof value[encoded] !== 'string') {
    throw new NelcotaUsageError('or/and take conditions made with the builder passed to the callback');
  }
  return value[encoded];
}

export function encodeGroup(items: readonly Condition[]): string {
  if (!Array.isArray(items) || items.length === 0) {
    throw new NelcotaUsageError('An or/and group needs at least one condition');
  }
  return `(${items.map(encodeCondition).join(',')})`;
}

export type CompareOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike';
export type IsValue = null | boolean | 'unknown';

export function isOperand(value: IsValue): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === 'unknown') return 'unknown';
  throw new NelcotaUsageError('is accepts null, true, false or "unknown"');
}

const COMPARE = new Set<string>(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike']);

export function compareOperator(op: string): CompareOperator {
  if (!COMPARE.has(op)) throw new NelcotaUsageError(`Unknown operator ${JSON.stringify(op)}`);
  return op as CompareOperator;
}

/** Builds conditions on the columns of `Row`. Passed to `.or()` and `.and()`. */
export class Conditions<Row> {
  #compare(column: string, op: CompareOperator, value: unknown): Condition {
    return condition(`${identifier(column, 'column')}.${op}.${quote(scalar(value))}`);
  }

  eq<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'eq', value);
  }
  neq<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'neq', value);
  }
  gt<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'gt', value);
  }
  gte<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'gte', value);
  }
  lt<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'lt', value);
  }
  lte<C extends string & keyof Row>(column: C, value: FilterValue<Row[C]>): Condition {
    return this.#compare(column, 'lte', value);
  }
  /** `*` (or `%`) matches any text; see `escapeLike` for typed input. */
  like<C extends string & keyof Row>(column: C, pattern: string): Condition {
    return this.#compare(column, 'like', pattern);
  }
  ilike<C extends string & keyof Row>(column: C, pattern: string): Condition {
    return this.#compare(column, 'ilike', pattern);
  }
  in<C extends string & keyof Row>(column: C, values: readonly FilterValue<Row[C]>[]): Condition {
    return condition(`${identifier(column, 'column')}.in.${inList(values)}`);
  }
  is<C extends string & keyof Row>(column: C, value: IsValue): Condition {
    return condition(`${identifier(column, 'column')}.is.${isOperand(value)}`);
  }
  /** Negates one condition or a whole group. */
  not(inner: Condition): Condition {
    const text = encodeCondition(inner);
    if (text.startsWith('not.or(') || text.startsWith('not.and(')) return condition(text.slice(4));
    if (text.startsWith('or(') || text.startsWith('and(')) return condition(`not.${text}`);
    // A filter: `column.op.value` ⇄ `column.not.op.value`.
    const dot = text.indexOf('.');
    const rest = text.slice(dot + 1);
    return condition(
      rest.startsWith('not.') ? `${text.slice(0, dot)}.${rest.slice(4)}` : `${text.slice(0, dot)}.not.${rest}`,
    );
  }
  or(items: readonly Condition[]): Condition {
    return condition(`or${encodeGroup(items)}`);
  }
  and(items: readonly Condition[]): Condition {
    return condition(`and${encodeGroup(items)}`);
  }
}
