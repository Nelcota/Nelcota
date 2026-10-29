import { i18n } from "$lib/i18n/index.svelte";
import { describe, expect, it } from "vitest";

import { crumbsFor, documentTitle } from "./titles";

const title = (path: string) => documentTitle(crumbsFor(path));

describe("documentTitle", () => {
  it("names each page with the product last", () => {
    i18n.locale = "pt-BR";
    expect(title("/")).toBe("Visão geral · Nelcota");
    expect(title("/sql")).toBe("Editor SQL · Nelcota");
    expect(title("/migrations")).toBe("Migrações · Nelcota");
    expect(title("/users/")).toBe("Usuários · Nelcota");
    expect(title("/guides/storage")).toBe("Arquivos e S3 · Guias e referências · Nelcota");
  });

  it("puts the most specific part first (fits the tab)", () => {
    i18n.locale = "pt-BR";
    expect(title("/tables/orders")).toBe("orders · Tabelas · Nelcota");
    expect(title("/tables/orders/structure")).toBe("Estrutura · orders · Tabelas · Nelcota");
  });

  it("names unknown routes", () => {
    i18n.locale = "pt-BR";
    expect(title("/does-not-exist")).toBe("Página não encontrada · Nelcota");
  });

  it("follows the chosen language", () => {
    i18n.locale = "en";
    expect(title("/tables/orders/structure")).toBe("Structure · orders · Tables · Nelcota");
    expect(title("/nope")).toBe("Page not found · Nelcota");
    expect(title("/guides/sdk")).toBe(
      "JavaScript and TypeScript SDK · Guides and references · Nelcota",
    );
  });
});
