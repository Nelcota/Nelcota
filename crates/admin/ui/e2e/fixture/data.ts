export function columnDefault(column: { name: string; has_default: boolean }): string | null {
  if (column.name === "id") return "gen_random_uuid()";
  return column.has_default ? "now()" : null;
}
export function userProviders(index: number): string[] {
  if (index === 0) return ["google"];
  return index % 3 === 2 ? ["github"] : [];
}
const stamp = "2026-10-08T10:30:00Z";
const rls = { state: "ok", label: "RLS enabled", enabled: true, forced: false, policies: 1 };
const tables = ["notes", "profiles", "tasks"].map((name) => ({
  name,
  kind: "table",
  has_pk: true,
  rls,
}));
const columns = [
  {
    name: "id",
    type: "uuid",
    full_type: "uuid",
    category: "U",
    nullable: false,
    has_default: true,
    generated: false,
    enum_values: [],
    is_pk: true,
    comment: null,
    references: null,
  },
  {
    name: "title",
    type: "text",
    full_type: "text",
    category: "S",
    nullable: false,
    has_default: false,
    generated: false,
    enum_values: [],
    is_pk: false,
    comment: null,
    references: null,
  },
  {
    name: "body",
    type: "text",
    full_type: "text",
    category: "S",
    nullable: true,
    has_default: false,
    generated: false,
    enum_values: [],
    is_pk: false,
    comment: null,
    references: null,
  },
  {
    name: "created_at",
    type: "timestamptz",
    full_type: "timestamp with time zone",
    category: "D",
    nullable: false,
    has_default: true,
    generated: false,
    enum_values: [],
    is_pk: false,
    comment: null,
    references: null,
  },
];
const grants = { anon: ["SELECT"], authenticated: ["SELECT", "INSERT", "UPDATE", "DELETE"] };
const projects = [
  { name: "nelcota-demo", url: null, current: true },
  { name: "loja-demo", url: "https://shop.example.test", current: false },
];
const bucket = {
  id: "documents",
  public: true,
  file_size_limit: 10485760,
  allowed_mime_types: null,
  created_at: stamp,
  files: 3,
  bytes: 1258291,
};
export function fixtureData(contentLanguage: "pt-BR" | "en") {
  const noteTitles =
    contentLanguage === "en"
      ? ["Weekly planning", "API integration", "Panel review"]
      : ["Planejamento da semana", "Integração com a API", "Revisão do painel"];
  const noteBody =
    contentLanguage === "en"
      ? "Example content for reviewing the interface."
      : "Texto de exemplo para revisão visual da interface.";
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    title: noteTitles[i % 3],
    body: noteBody,
    created_at: stamp,
  }));
  return { stamp, rls, tables, columns, grants, rows, projects, bucket };
}
export type FixtureData = ReturnType<typeof fixtureData>;
