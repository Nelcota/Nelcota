import type { FixtureEndpoint } from "./types.js";
export const overviewEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path }) => path === "/projects",
    respond: ({ data: { projects } }) => {
      return { status: 200, json: { current: "nelcota-demo", sso: true, projects } };
    },
  },
  {
    matches: ({ path }) => path === "/projects/status",
    respond: ({ data: { projects } }) => {
      return {
        status: 200,
        json: {
          current: "nelcota-demo",
          projects: projects.map(({ name, url, current }) => ({
            name,
            url,
            current,
            healthy: true,
            version: "0.1.0",
            latency_ms: 18,
          })),
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/overview",
    respond: ({ data: { tables, grants } }) => {
      return {
        status: 200,
        json: {
          schema: "public",
          counts: { tables: 3, users: 12, signed_in_users: 0, policies: 3, functions: 2 },
          exposed_without_rls: [],
          tables: tables.map((t) => ({ ...t, comment: null, rows: 12, rows_exact: true, grants })),
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/metrics",
    respond: ({ url, data: { stamp } }) => {
      const hourly = url.searchParams.get("range") === "1h";
      const count = hourly ? 60 : 96,
        step = hourly ? 60 : 900,
        end = Date.parse(stamp);
      const points = Array.from({ length: count }, (_, i) => ({
        at: new Date(end - (count - 1 - i) * step * 1000).toISOString(),
        requests: 40 + (i % 12) * 9,
        refused: i % 5,
        errors: 0,
        p95_ms: 25,
      }));
      return {
        status: 200,
        json: {
          range: hourly ? "1h" : "24h",
          step_secs: step,
          since: stamp,
          points,
          totals: {
            requests: points.reduce((a, p) => a + p.requests, 0),
            refused: points.reduce((a, p) => a + p.refused, 0),
            errors: 0,
            rest: 900,
            auth: 40,
            storage: 12,
            p95_ms: 25,
          },
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/denied",
    respond: ({ data: { stamp } }) => {
      return {
        status: 200,
        json: {
          capacity: 100,
          requests: [
            {
              at: stamp,
              method: "GET",
              path: "/rest/v1/notes",
              status: 401,
              code: "db_error",
              message: "permission denied for table notes (42501)",
              role: "anon",
              user_id: null,
              email: null,
            },
          ],
        },
      };
    },
  },
];
