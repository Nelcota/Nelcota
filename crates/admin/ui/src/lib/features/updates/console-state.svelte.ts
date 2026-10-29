import { t } from "$lib/i18n/index.svelte";

import {
  ControllerError,
  request,
  sessionExpired,
  pollDelay,
  parseStatus,
  parsePlan,
  parseJob,
  mergeStatus,
  newKey,
  message,
  terminal,
  type Status,
  type Plan,
  type Job,
} from "./controller";
const MAX_RECENT_JOBS = 32;
const IDLE_POLL_MS = 10000;

/** Owns controller requests, session boundaries and update approval state. */
export class UpdatesConsoleState {
  status = $state<Status | null>(null);
  signedOut = $state(false);
  email = $state("");
  password = $state("");
  approval = $state("");
  project = $state("");
  plan = $state<Plan | null>(null);
  recover = $state<Job | null>(null);
  failure = $state<string | null>(null);
  offline = $state(false);
  busy = $state(false);
  private key = "";
  private alive = true;
  private readonly isAlive = (): boolean => {
    return this.alive;
  };
  private generation = 0;
  private readonly currentRevision = (revision: number): boolean => {
    return this.isAlive() && revision === this.generation;
  };
  private polling: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private readonly requests = new Set<AbortController>();
  active = $derived(
    (this.status?.host_busy === true ||
      this.status?.jobs.some((job) => Boolean(terminal(job.phase)) === false)) ??
      false,
  );
  selected = $derived(this.status?.projects.find((item) => item.name === this.project));
  clearApproval = () => {
    this.plan = null;
    this.recover = null;
    this.approval = "";
    this.key = "";
  };
  private readonly call = async (body?: object) => {
    const abort = new AbortController();
    this.requests.add(abort);
    try {
      return await request(body, abort.signal);
    } finally {
      this.requests.delete(abort);
    }
  };
  private readonly schedule = () => {
    clearTimeout(this.timer);
    if (this.alive === false || this.signedOut) return;
    const delayInMs = pollDelay({
      offline: this.offline,
      attempts: this.attempts,
      active: this.active || (this.status?.checking ?? false),
      idleMs: IDLE_POLL_MS,
    });
    // A hidden tab keeps its schedule without asking the controller.
    this.timer = setTimeout(() => {
      if (document.hidden) {
        this.schedule();
        return;
      }
      void this.refresh();
    }, delayInMs);
  };
  private readonly refreshWhenShown = () => {
    if (document.hidden === false) void this.refresh();
  };
  private readonly applyStatus = (reply: Record<string, unknown>) => {
    this.status = mergeStatus(this.status, parseStatus(reply.data));
    this.signedOut = false;
    this.offline = false;
    this.attempts = 0;
    if (Boolean(this.status.projects.some((item) => item.name === this.project)) === false) {
      this.project = this.status.projects[0]?.name ?? "";
      this.clearApproval();
    }
  };
  refresh = async () => {
    if (this.alive === false || this.polling === this.generation) return;
    clearTimeout(this.timer);
    this.polling = this.generation;
    const revision = this.generation;
    try {
      const reply = await this.call();
      if (this.currentRevision(revision) === false) return;
      this.applyStatus(reply);
    } catch (error) {
      if (this.currentRevision(revision) === false) return;
      if (sessionExpired(error)) {
        this.signedOut = true;
        this.status = null;
        this.clearApproval();
        return;
      }
      this.offline = true;
      this.attempts++;
    } finally {
      if (this.polling === revision) this.polling = null;
      if (this.currentRevision(revision)) this.schedule();
    }
  };
  login = async (event: SubmitEvent) => {
    event.preventDefault();
    if (this.busy || Boolean(this.email.trim()) === false || this.password === "") return;
    this.busy = true;
    this.failure = null;
    try {
      await this.call({ action: "login", email: this.email.trim(), password: this.password });
      if (this.alive === false) return;
      this.generation++;
      clearTimeout(this.timer);
      for (const abort of this.requests) abort.abort();
      this.signedOut = false;
      await this.refresh();
    } catch (error) {
      if (this.alive)
        this.failure =
          error instanceof ControllerError ? message(error.code) : t("updates.reconnect");
    } finally {
      this.password = "";
      this.busy = false;
    }
  };
  act = async (body: object, apply: (reply: Record<string, unknown>) => void) => {
    if (this.busy || this.offline) return;
    this.busy = true;
    this.failure = null;
    const revision = this.generation;
    try {
      const reply = await this.call(body);
      if (this.currentRevision(revision)) apply(reply);
    } catch (error) {
      if (this.currentRevision(revision))
        this.failure =
          error instanceof ControllerError ? message(error.code) : t("updates.reconnect");
    } finally {
      this.busy = false;
      this.approval = "";
      if (this.currentRevision(revision)) void this.refresh();
    }
  };
  prepare = () => {
    this.clearApproval();
    void this.act({ action: "plan", project: this.project }, (reply) => {
      this.plan = parsePlan(reply.data);
      this.key = newKey();
    });
  };
  private readonly accepted = (reply: Record<string, unknown>) => {
    const job = parseJob(reply.data);
    if (this.status != null)
      this.status = mergeStatus(this.status, {
        ...this.status,
        jobs: [job, ...this.status.jobs.filter((entry) => entry.id !== job.id)].slice(
          0,
          MAX_RECENT_JOBS,
        ),
      });
    this.clearApproval();
  };
  approve = (event: SubmitEvent) => {
    event.preventDefault();
    if (this.approval === "" || this.busy || this.offline) return;
    if (this.recover != null) {
      void this.act(
        { action: "recover", job: this.recover.id, password: this.approval },
        this.accepted,
      );
      return;
    }
    if (
      this.plan == null ||
      Boolean(this.plan.blockers.length) ||
      Boolean(this.status?.enabled) === false
    )
      return;
    void this.act(
      { action: "start", plan: this.plan.id, key: this.key, password: this.approval },
      this.accepted,
    );
  };
  logout = async () => {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.call({ action: "logout" });
      this.generation++;
      this.status = null;
      this.signedOut = true;
      this.clearApproval();
      clearTimeout(this.timer);
      for (const abort of this.requests) abort.abort();
    } catch {
      this.failure = t("updates.reconnect");
    } finally {
      this.busy = false;
    }
  };
  /** Starts polling and returns the owner's disposal callback. */
  mount = () => {
    void this.refresh();
    document.addEventListener("visibilitychange", this.refreshWhenShown);
    return () => {
      this.alive = false;
      this.generation++;
      clearTimeout(this.timer);
      document.removeEventListener("visibilitychange", this.refreshWhenShown);
      for (const abort of this.requests) abort.abort();
    };
  };
  /** Discards requests and approval secrets when the host session expires. */
  expire = () => {
    this.generation++;
    this.signedOut = true;
    this.status = null;
    this.clearApproval();
    clearTimeout(this.timer);
    for (const abort of this.requests) abort.abort();
  };
}
