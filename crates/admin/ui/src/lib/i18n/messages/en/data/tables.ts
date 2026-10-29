import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/data/tables";
import navigation from "./table-navigation";
import rows from "./table-rows";
import structure from "./table-structure";

const en: Messages<typeof ptBR> = { ...navigation, ...rows, ...structure };

export default en;
