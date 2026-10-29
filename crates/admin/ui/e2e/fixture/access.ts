import { requiredValue } from "../../src/lib/contracts/required-value.js";
import { userProviders } from "./data.js";
import type { FixtureEndpoint } from "./types.js";
export const accessEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path, method }) => path === "/users" && method === "GET",
    respond: ({ search, data: { stamp, rows } }) => {
      return {
        status: 200,
        json: {
          page: 0,
          users: Array.from({ length: 6 }, (_, i) => ({
            id: requiredValue(rows[i], "fixture row").id,
            email: requiredValue(
              ["ana@example.test", "bruno@example.test", "carla@example.test"][i % 3],
              "fixture email",
            ),
            created_at: stamp,
            last_sign_in_at: i % 2 !== 0 ? null : stamp,
            email_confirmed_at: i === 1 ? null : stamp,
            sessions: i,
            has_password: i % 3 !== 2,
            providers: userProviders(i),
          })).filter((u) => search === "" || u.email.includes(search)),
          total: 6,
          has_next: false,
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/policies",
    respond: ({ data: { tables } }) => {
      return {
        status: 200,
        json: {
          schema: "public",
          exposed_without_rls: [],
          tables: tables.map(({ name, kind, has_pk, rls }) => ({
            name,
            kind,
            has_pk,
            rls,
            exposed_without_rls: false,
            policies: [
              {
                name: "owner_access",
                permissive: true,
                roles: ["authenticated"],
                command: "ALL",
                using: "owner = auth.uid()",
                check: "owner = auth.uid()",
              },
            ],
          })),
          anon_functions: [],
        },
      };
    },
  },
];
