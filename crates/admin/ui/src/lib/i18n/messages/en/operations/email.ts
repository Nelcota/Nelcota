import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/operations/email";
const en: Messages<typeof ptBR> = {
  title: "Email preview and test",
  variables:
    "Message: {{project_name}}, {{email}}, {{validity}} and exactly one {{link}}. Subject: only {{project_name}} and {{validity}}. No HTML or executable expressions.",
  safety:
    "Previews use fictional data. Tests use applied SMTP settings and send only to the configured administrator, at most once per minute. No real token is created; testing does not save the draft.",
  kind: "Email type",
  recovery: "Password recovery",
  signup: "Email confirmation",
  magiclink: "Sign-in link",
  preview: "Preview draft",
  sendTest: "Send test draft",
  recipient: "Fixed test recipient",
  unavailable:
    "To send, apply SMTP settings and open the selected project's own panel. Preview does not require SMTP.",
  accepted:
    "SMTP accepted the test. This does not prove inbox delivery. No authentication link was issued and the draft was not saved.",
  result: "Preview with fictional data",
};
export default en;
