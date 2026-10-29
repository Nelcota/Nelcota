import type { FixtureEndpoint } from "./types.js";
export const migrationsEndpoints: readonly FixtureEndpoint[] = [
  {
    matches: ({ path, method }) => path === "/migrations" && method === "GET",
    respond: ({ data: { stamp } }) => {
      return {
        status: 200,
        json: {
          migrations: [
            {
              version: 1,
              name: "initial_schema",
              applied_on: stamp,
              in_folder: true,
              from_panel: false,
            },
            {
              version: 2,
              name: "add_notes",
              applied_on: stamp,
              in_folder: false,
              from_panel: true,
            },
          ],
          pending: [
            {
              id: 1,
              applied_at: stamp,
              summary: "Add title column",
              statements: ["ALTER TABLE public.notes ADD COLUMN title text"],
              kind: "add_column",
              target: "title",
            },
          ],
          next_version: 3,
          folder: "/app/migrations",
        },
      };
    },
  },
  {
    matches: ({ path }) => path === "/migrations",
    respond: () => {
      return {
        status: 200,
        json: {
          version: 3,
          filename: "V3__changes.sql",
          message: "Migration exported",
          sql: "ALTER TABLE public.notes ADD COLUMN title text;",
          in_folder: false,
        },
      };
    },
  },
];
