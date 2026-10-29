import { columnDefault } from "./data.js";
import type { FixtureEndpoint } from "./types.js";
export const tablesEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path, method }) => path === "/tables" && method === "GET",
    respond: ({ data: { tables } }) => {
      return { status: 200, json: { schema: "public", tables } };
    },
  },
  {
    matches: ({ path }) => path === "/schema",
    respond: ({ data: { tables, columns } }) => {
      return {
        status: 200,
        json: {
          schema: "public",
          tables: Object.fromEntries(tables.map((t) => [t.name, columns.map((c) => c.name)])),
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/types",
    respond: () => {
      return {
        status: 200,
        json: {
          base: ["text", "uuid", "bigint", "boolean", "jsonb", "timestamptz"],
          enums: [],
        },
      };
    },
  },
  {
    matches: ({ path }) => /^\/tables\/[^/]+\/structure$/.test(path),
    respond: ({ path, data: { columns } }) => {
      return {
        status: 200,
        json: {
          name: path.split("/")[2],
          comment: "Dados de exemplo",
          rls_enabled: true,
          primary_key: ["id"],
          primary_key_constraint: "notes_pkey",
          columns: columns.map((c) => ({
            name: c.name,
            data_type: c.full_type,
            nullable: c.nullable,
            default: columnDefault(c),
            identity: null,
            generated: false,
            primary_key: c.is_pk,
            unique: null,
            references: null,
            comment: null,
          })),
          grants: [
            { role: "anon", privileges: ["select"] },
            { role: "authenticated", privileges: ["select", "insert", "update", "delete"] },
            { role: "service_role", privileges: ["select", "insert", "update", "delete"] },
          ],
        },
      };
    },
  },
  {
    matches: ({ path, method }) => /^\/tables\/[^/]+$/.test(path) && method === "GET",
    respond: ({ path, data: { tables, columns, rows } }) => {
      return {
        status: 200,
        json: {
          table: {
            ...tables[0],
            name: path.split("/")[2],
            comment: null,
            primary_key: ["id"],
            editable: true,
            insertable: true,
            exposed_without_rls: false,
            columns,
          },
          rows,
          page: 0,
          size: 50,
          has_next: false,
          total: 12,
          total_exact: true,
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/sql",
    respond: ({ data: { rows } }) => {
      return {
        status: 200,
        json: {
          results_truncated: false,
          results: [
            {
              columns: ["id", "title"],
              rows: rows.map((r) => [r.id, r.title]),
              count: rows.length,
              truncated: false,
            },
          ],
        },
      };
    },
  },
];
