import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { checkSvelte } from "./check.ts";

const repository = resolve(import.meta.dir, "../..");
const fixture = mkdtempSync(join(tmpdir(), "nelcota-svelte-fixture-"));
const ui = join(fixture, "crates/admin/ui");
const source = join(ui, "src");

beforeAll(() => {
  mkdirSync(join(source, "lib"), { recursive: true });
  symlinkSync(join(repository, "node_modules"), join(fixture, "node_modules"));
  symlinkSync(join(repository, "crates/admin/ui/node_modules"), join(ui, "node_modules"));
  writeFileSync(
    join(ui, "tsconfig.app.json"),
    JSON.stringify({
      extends: join(repository, "crates/admin/ui/tsconfig.app.json"),
    }),
  );
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

test("checks real script expressions with aliases, Unicode and both script blocks", () => {
  writeFileSync(
    join(source, "lib/work.ts"),
    "export const work = (): Promise<void> => Promise.resolve();",
  );
  writeFileSync(
    join(source, "probe.svelte"),
    `<script module lang="ts">
  import { work } from "$lib/work.js";
  work();
  </script>
  <script lang="ts">
  const label = "✓"; work();
  let { text }: { text?: string } = $props();
  if (text) console.log(label);
  </script>
  <p>{text}</p>`,
  );
  const diagnostics = checkSvelte(fixture);
  const promises = diagnostics.filter(
    (diagnostic) => diagnostic.code === "typescript(no-floating-promises)",
  );
  expect(promises.map((diagnostic) => diagnostic.labels[0]?.span.line)).toEqual([3, 6]);
  expect(promises[1]?.labels[0]?.span.column).toBe(22);
  expect(
    diagnostics.some((diagnostic) => diagnostic.code === "typescript(strict-boolean-expressions)"),
  ).toBe(true);
  expect(
    diagnostics.some((diagnostic) => diagnostic.code === "typescript(no-unsafe-assignment)"),
  ).toBe(false);
});

test("keeps unrelated unsafe assignments while excluding generated template machinery", () => {
  writeFileSync(
    join(source, "probe.svelte"),
    `<script lang="ts">
  let { value = $bindable() }: { value?: string } = $props();
  const unsafe: string = JSON.parse("null");
  </script>
  <input bind:value /><p>{unsafe}</p>`,
  );
  const diagnostics = checkSvelte(fixture);
  const unsafe = diagnostics.filter(
    (diagnostic) => diagnostic.code === "typescript(no-unsafe-assignment)",
  );
  expect(unsafe).toHaveLength(1);
  expect(unsafe[0]?.labels[0]?.span.line).toBe(3);
  expect(diagnostics.every((diagnostic) => (diagnostic.labels[0]?.span.line ?? 0) < 4)).toBe(true);
});

test("models deferred reactive conditions while retaining genuinely constant checks", () => {
  writeFileSync(
    join(source, "probe.svelte"),
    `<script lang="ts">
  let ready = $state(false);
  const reactive = $derived(ready ? "ready" : "waiting");
  const fixed = $derived(true ? "fixed" : "unreachable");
  </script>
  <button onclick={() => ready = true}>{reactive}{fixed}</button>`,
  );
  const diagnostics = checkSvelte(fixture).filter(
    (diagnostic) => diagnostic.code === "typescript(no-unnecessary-condition)",
  );
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]?.labels[0]?.span.line).toBe(4);
});

test("fails on invalid components and refuses component/Rune module collisions", () => {
  writeFileSync(join(source, "probe.svelte"), '<script lang="ts">const value = ;</script>');
  expect(() => checkSvelte(fixture)).toThrow();
  writeFileSync(join(source, "probe.svelte"), "<p>Valid component</p>");
  writeFileSync(join(source, "probe.svelte.ts"), "export const value = 1;");
  expect(() => checkSvelte(fixture)).toThrow("Component/Rune module collision");
});
