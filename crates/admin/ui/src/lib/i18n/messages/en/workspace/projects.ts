// Projects page (every project on this host).
import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/workspace/projects";

const en: Messages<typeof ptBR> = {
  title: "Projects",
  sso: "Single sign-on: panels open without asking for a password.",
  separateLogin: "Each panel asks for its own login.",
  refreshing: "Refreshing…",
  current: "this panel",
  up: "Up",
  down: "Down",
  empty: "No projects found",
  emptyDescription: "Create a project with nelcota init and refresh this list.",
  copyUrl: "Copy address for {name}",
  open: "Open panel",
  back: "Back to overview",
  newProject: {
    title: "New project",
    subdomain: "On a subdomain of this server:",
    subdomainCommand: "nelcota init --project name",
    domain: "Or on a domain of its own:",
    domainCommand: "nelcota init api.domain.com",
  },
};

export default en;
