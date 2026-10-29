import { sessionExpired } from "../../updates/controller";
import { parseLogs, type LogEntry } from "../controller";
type Options = {
  selected: () => string;
  busy: () => boolean;
  offline: () => boolean;
  setBusy: (value: boolean) => void;
  fail: (key: "error" | null) => void;
  call: (body: object) => Promise<Record<string, unknown>>;
  alive: () => boolean;
  expired: () => void;
  schedule: () => void;
};

/** Publishes log metadata only for the project and service that requested it. */
export class HostLogs {
  logs = $state<LogEntry[] | null>(null);
  service = $state<"app" | "database">("app");
  constructor(private readonly options: Options) {}
  private current(project: string, service: string): boolean {
    return this.options.alive() && this.options.selected() === project && this.service === service;
  }
  async read(): Promise<void> {
    const options = this.options;
    if (options.selected() === "" || options.busy() || options.offline()) return;
    options.setBusy(true);
    options.fail(null);
    const name = options.selected(),
      service = this.service;
    try {
      const reply = await options.call({ action: "host_logs", project: name, service });
      if (this.current(name, service)) this.logs = parseLogs(reply.data);
    } catch (error) {
      if (options.alive() && sessionExpired(error)) {
        options.expired();
        return;
      }
      if (options.alive()) options.fail("error");
    } finally {
      options.setBusy(false);
      if (options.alive()) options.schedule();
    }
  }
}
