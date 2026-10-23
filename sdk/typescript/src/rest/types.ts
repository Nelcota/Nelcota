/**
 * Types that connect the client to the output of `nelcota types`. With no
 * generated `Database`, everything degrades to loose records, so the client
 * still works untyped.
 */

export type { Json } from '../core/json-types.js';

export interface GenericRelationship {
  foreignKeyName: string;
  columns: readonly string[];
  referencedRelation: string;
  referencedColumns: readonly string[];
}

export interface GenericTable {
  Row: Record<string, unknown>;
  Insert: Record<string, unknown>;
  Update: Record<string, unknown>;
  Relationships: readonly GenericRelationship[];
}

export interface GenericView {
  Row: Record<string, unknown>;
  Insert?: Record<string, unknown>;
  Update?: Record<string, unknown>;
  Relationships: readonly GenericRelationship[];
}

export interface GenericFunction {
  Args: Record<string, unknown>;
  Returns: unknown;
}

export interface GenericSchema {
  Tables: Record<string, GenericTable>;
  Views: Record<string, GenericView>;
  Functions: Record<string, GenericFunction>;
  Enums?: Record<string, unknown>;
}

/** A loose schema, used when no generated `Database` is given. */
export interface AnySchema {
  /** Marks the untyped schema (a generated one never has it). */
  readonly __untyped: true;
  Tables: Record<string, { Row: any; Insert: any; Update: any; Relationships: [] }>;
  Views: Record<string, { Row: any; Insert: any; Update: any; Relationships: [] }>;
  Functions: Record<string, { Args: any; Returns: any }>;
}

/** The schema the client is typed with: the generated one, or `AnySchema`. */
export type SchemaOf<Database, Name> = 0 extends 1 & Database
  ? AnySchema
  : Name extends keyof Database
    ? Database[Name] extends GenericSchema
      ? Database[Name]
      : AnySchema
    : AnySchema;

export type DefaultSchemaName<Database> = 'public' extends keyof Database ? 'public' : string & keyof Database;

export type RelationName<S extends GenericSchema> = (string & keyof S['Tables']) | (string & keyof S['Views']);

export type Relation<S extends GenericSchema, Name> = Name extends keyof S['Tables']
  ? S['Tables'][Name]
  : Name extends keyof S['Views']
    ? S['Views'][Name]
    : never;

export type RowOf<R> = R extends { Row: infer Row } ? Row : never;
export type InsertOf<R> = R extends { Insert: infer I } ? (unknown extends I ? never : I) : never;
export type UpdateOf<R> = R extends { Update: infer U } ? (unknown extends U ? never : U) : never;

// ------------------------------------------------------------ select parser

type Whitespace = ' ' | '\n' | '\t' | '\r';

type Trim<S extends string> = S extends `${Whitespace}${infer R}`
  ? Trim<R>
  : S extends `${infer R}${Whitespace}`
    ? Trim<R>
    : S;

/** Splits on commas outside parentheses, one character at a time. */
type SplitTop<
  S extends string,
  Depth extends unknown[] = [],
  Current extends string = '',
  Out extends string[] = [],
> = S extends `${infer C}${infer Rest}`
  ? C extends '('
    ? SplitTop<Rest, [...Depth, 0], `${Current}${C}`, Out>
    : C extends ')'
      ? SplitTop<Rest, Depth extends [unknown, ...infer D] ? D : [], `${Current}${C}`, Out>
      : C extends ','
        ? Depth extends []
          ? SplitTop<Rest, Depth, '', [...Out, Trim<Current>]>
          : SplitTop<Rest, Depth, `${Current}${C}`, Out>
        : SplitTop<Rest, Depth, `${Current}${C}`, Out>
  : [...Out, Trim<Current>];

/** A type that reports a mistake in a select string where the row would be. */
export interface SelectError<Message extends string> {
  readonly __selectError: Message;
}

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type Simplify<T> = { [K in keyof T]: T[K] } & {};

type HintMatches<Rel, Hint extends string> = Hint extends ''
  ? true
  : Rel extends { foreignKeyName: Hint }
    ? true
    : Rel extends { columns: readonly [Hint] }
      ? true
      : false;

/** Relationships of `From` that point at `To` (many-to-one: an object). */
type Outgoing<S extends GenericSchema, From, To extends string, Hint extends string> =
  Relation<S, From> extends { Relationships: readonly (infer Rel)[] }
    ? Rel extends { referencedRelation: To }
      ? HintMatches<Rel, Hint> extends true
        ? Rel
        : never
      : never
    : never;

/** Relationships of `To` that point at `From` (one-to-many: an array). */
type Incoming<S extends GenericSchema, From extends string, To, Hint extends string> =
  Relation<S, To> extends { Relationships: readonly (infer Rel)[] }
    ? Rel extends { referencedRelation: From }
      ? HintMatches<Rel, Hint> extends true
        ? Rel
        : never
      : never
    : never;

type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

type EmbedValue<S extends GenericSchema, From extends string, Target extends string, Hint extends string, Inner extends string> =
  Target extends RelationName<S>
    ? [Outgoing<S, From, Target, Hint>] extends [never]
      ? [Incoming<S, From, Target, Hint>] extends [never]
        ? SelectError<`no relationship between '${From}' and '${Target}'`>
        : true extends IsUnion<Incoming<S, From, Target, Hint>>
          ? SelectError<`more than one relationship between '${From}' and '${Target}': add !column`>
          : ParseSelect<S, Target, Inner>[]
      : [Incoming<S, From, Target, Hint>] extends [never]
        ? true extends IsUnion<Outgoing<S, From, Target, Hint>>
          ? SelectError<`more than one relationship between '${From}' and '${Target}': add !column`>
          : ParseSelect<S, Target, Inner> | null
        : SelectError<`more than one relationship between '${From}' and '${Target}': add !column`>
    : SelectError<`table '${Target}' does not exist`>;

/** `[alias:]table[!hint]` → its parts. */
type EmbedHead<Head extends string> = Head extends `${infer Alias}:${infer Rest}`
  ? Rest extends `${infer Table}!${infer Hint}`
    ? [Trim<Alias>, Trim<Table>, Trim<Hint>]
    : [Trim<Alias>, Trim<Rest>, '']
  : Head extends `${infer Table}!${infer Hint}`
    ? [Trim<Table>, Trim<Table>, Trim<Hint>]
    : [Trim<Head>, Trim<Head>, ''];

type ParseItem<S extends GenericSchema, From extends string, Item extends string> = Item extends '*'
  ? RowOf<Relation<S, From>>
  : Item extends `${infer Head}(${infer Inner})`
    ? EmbedHead<Head> extends [infer Alias extends string, infer Target extends string, infer Hint extends string]
      ? { [K in Alias]: EmbedValue<S, From, Target, Hint, Inner> }
      : never
    : Item extends keyof RowOf<Relation<S, From>>
      ? { [K in Item]: RowOf<Relation<S, From>>[K] }
      : { [K in Item]: SelectError<`column '${Item}' does not exist in '${From}'`> };

/**
 * The row type a `select` string produces: columns picked from the row,
 * `*` for all of them, and embeds typed as an object (or `null`) when this
 * relation holds the foreign key, or an array when the other one does.
 */
export type ParseSelect<S extends GenericSchema, From extends string, Select extends string> =
  string extends Select
    ? RowOf<Relation<S, From>>
    : Simplify<UnionToIntersection<ParseItem<S, From, SplitTop<Select>[number]>>>;

/** The row of a select, or a loose record for an untyped client. */
export type SelectRow<S extends GenericSchema, From extends string, Select extends string> =
  S extends { readonly __untyped: true } ? Record<string, any> : ParseSelect<S, From, Select>;

// ---------------------------------------------------------------- functions

export type FunctionName<S extends GenericSchema> = string & keyof S['Functions'];
export type FunctionArgs<S extends GenericSchema, F> = F extends keyof S['Functions']
  ? S['Functions'][F] extends { Args: infer A }
    ? A
    : never
  : never;
export type FunctionReturns<S extends GenericSchema, F> = F extends keyof S['Functions']
  ? S['Functions'][F] extends { Returns: infer R }
    ? R
    : never
  : never;

/** Whether every argument is optional (the call may omit them). */
export type ArgsOptional<A> = {} extends A ? true : false;
