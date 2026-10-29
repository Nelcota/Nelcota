import { CloseGuard } from "$lib/forms/close-guard.svelte";

import type { Configuration } from "../server/components";
import { newKey, sessionExpired } from "../updates/controller";
import {
  HostConnection,
  HostLogs,
  approvalBody,
  approvalReady,
  rejectedApproval,
  acceptedJob,
  planSeconds,
  inventoryOutcome,
  inventorySelection,
  hostText as h,
  previewFailure,
  parseStatus,
  parsePlan,
  parseJob,
  mergeStatus,
  terminal,
  type Status,
  type Plan,
  type Job,
  type Operation,
  type Pending,
} from "./model";
const SECOND_IN_MS = 1000;
/** Current component callbacks remain live across reactive prop updates. */
interface HostConsoleOptions {
  email: () => string;
  expired: () => void;
}

/** Owns host inventory, durable approval receipts and request lifetimes. */
export class HostConsoleState {
  get email(): string {
    return this.current.email();
  }
  expired = () => this.current.expired();
  dirty = $state(false);
  private nextNavigation: (() => void) | null = null;
  guard = new CloseGuard({
    dirty: () => this.dirty,
    busy: () => this.busy,
    close: () => {
      this.dirty = false;
      const next = this.nextNavigation;
      this.nextNavigation = null;
      next?.();
    },
    active: () => true,
  });
  leave = (proceed: () => void): void => {
    this.nextNavigation = proceed;
    this.guard.request();
  };
  status = $state<Status | null>(null);
  plan = $state<Plan | null>(null);
  recovery = $state<Job | null>(null);
  pending = $state<Pending | null>(null);
  name = $state("");
  domain = $state("");
  profile = $state("1gb");
  selected = $state("");
  backup = $state("");
  confirmation = $state("");
  password = $state("");
  acknowledged = $state(false);
  rescue = $state(false);
  busy = $state(false);
  offline = $state(false);
  failure = $state<string | null>(null);
  notice = $state<string | null>(null);
  private now = $state(Math.floor(Date.now() / SECOND_IN_MS));
  private readonly isAlive = (): boolean => {
    return this.connection.alive;
  };
  private mutationEpoch = 0;
  private attempts = 0;
  private key = "";
  private rejected = false;
  reviewForm = $state<HTMLFormElement>();
  polling = $state(false);
  private readonly storageKey = $derived(`nelcota.host.request:${this.email}`);
  active = $derived(
    (this.status?.busy === true ||
      this.status?.jobs.some((j) => Boolean(terminal(j.stage)) === false)) ??
      false,
  );
  project = $derived(this.status?.projects.find((p) => p.name === this.selected));
  target = $derived(
    this.plan?.operation ?? this.recovery?.operation ?? this.pending?.operation ?? null,
  );
  phrase = $derived(
    this.recovery != null
      ? `RESUME ${this.recovery.operation.project}`
      : (this.plan?.confirmation ?? this.pending?.confirmation ?? ""),
  );
  seconds = $derived(planSeconds(this.plan, this.now));
  canApprove = $derived(approvalReady(this));
  reset = () => {
    this.plan = null;
    this.recovery = null;
    this.confirmation = "";
    this.password = "";
    this.acknowledged = false;
    this.rescue = false;
    this.key = "";
    this.rejected = false;
  };
  private readonly savePending = (value: Pending | null): boolean => {
    try {
      if (value != null) sessionStorage.setItem(this.storageKey, JSON.stringify(value));
      if (value == null) sessionStorage.removeItem(this.storageKey);
      this.pending = value;
      return true;
    } catch {
      if (value == null) this.pending = null;
      this.failure = h(value != null ? "storageFailure" : "storageCleanupFailure");
      return false;
    }
  };
  private readonly connection = new HostConnection({
    refresh: () => this.refresh(),
    pollState: () => ({
      offline: this.offline,
      attempts: this.attempts,
      active: this.active || this.pending !== null,
    }),
    tick: () => {
      this.now = Math.floor(Date.now() / SECOND_IN_MS);
    },
  });
  private readonly call = (body: object) => this.connection.call(body);
  private readonly schedule = () => this.connection.schedule();
  private readonly applyStatus = (reply: Record<string, unknown>, requestedKey: string | null) => {
    this.status = mergeStatus(this.status, parseStatus(reply.data), true);
    this.offline = false;
    this.attempts = 0;
    const outcome = inventoryOutcome(this.status, {
      pending: this.pending,
      recovery: this.recovery,
      requestedKey,
    });
    if (outcome.acknowledged) this.savePending(null);
    if (outcome.submitted) {
      this.reset();
      this.notice = h("submitted");
    }
    if (outcome.mayReject && this.rejected) {
      this.savePending(null);
      this.reset();
      this.rejected = false;
      this.failure = h("error");
    }
    const selection = inventorySelection(this.status, this.selected);
    this.selected = selection.selected;
    if (selection.removed) {
      this.backup = "";
      this.logReader.logs = null;
    }
  };
  refresh = async () => {
    if (this.connection.canPoll(this.polling, this.busy) === false) {
      this.schedule();
      return;
    }
    this.connection.pause();
    this.polling = true;
    const requestedKey = this.pending?.key ?? null;
    const revision = this.mutationEpoch;
    try {
      const reply = await this.call({
        action: "host_status",
        key: requestedKey,
      });
      if (Boolean(this.connection.alive) === false || revision !== this.mutationEpoch) return;
      this.applyStatus(reply, requestedKey);
    } catch (error) {
      if (Boolean(this.connection.alive) === false) return;
      if (sessionExpired(error)) {
        this.expired();
        return;
      }
      this.offline = true;
      this.attempts++;
    } finally {
      this.polling = false;
      if (this.isAlive()) this.schedule();
    }
  };
  private readonly previewBlocked = $derived(
    this.busy || this.offline || this.active || this.pending !== null,
  );
  preview = async (
    operation: Operation | null,
    configuration?: Configuration,
  ): Promise<boolean> => {
    if (this.previewBlocked) return false;
    this.reset();
    this.failure = null;
    this.notice = null;
    this.busy = true;
    try {
      const reply = await this.call(
        configuration != null
          ? { action: "host_configure_plan", project: this.selected, configuration }
          : { action: "host_plan", operation },
      );
      if (this.connection.alive === false) return false;
      this.plan = parsePlan(reply.data);
      this.key = newKey();
      await this.connection.focusReview(() => this.reviewForm);
      return true;
    } catch (error) {
      if (this.connection.alive === false) return false;
      this.failure = previewFailure(error);
      if (sessionExpired(error)) this.expired();
      return false;
    } finally {
      this.busy = false;
      if (this.isAlive()) this.schedule();
    }
  };
  approve = async (event: SubmitEvent) => {
    event.preventDefault();
    if (this.canApprove === false || Boolean(this.target) === false) return;
    this.busy = true;
    this.failure = null;
    this.notice = null;
    this.rejected = false;
    const body = approvalBody(
      {
        recovery: this.recovery,
        pending: this.pending,
        plan: this.plan,
        key: this.key,
        password: this.password,
        confirmation: this.confirmation,
      },
      this.savePending,
    );
    if (body == null) {
      this.busy = false;
      this.password = "";
      return;
    }
    try {
      const reply = await this.call(body);
      if (this.connection.alive === false) return;
      const job = parseJob(reply.data);
      this.mutationEpoch++;
      this.status = acceptedJob(this.status, job);
      this.savePending(null);
      this.reset();
      this.notice = h("submitted");
    } catch (error) {
      if (this.connection.alive === false) return;
      this.failure = h("uncertain");
      this.rejected = rejectedApproval(error);
      if (sessionExpired(error)) this.expired();
    } finally {
      this.busy = false;
      this.password = "";
      if (this.isAlive()) void this.refresh();
    }
  };
  logReader = new HostLogs({
    selected: () => this.selected,
    busy: () => this.busy,
    offline: () => this.offline,
    setBusy: (value) => {
      this.busy = value;
    },
    fail: (key) => {
      this.failure = key === null ? null : h(key);
    },
    call: this.call,
    alive: this.isAlive,
    expired: () => this.expired(),
    schedule: this.schedule,
  });
  recover = async (job: Job) => {
    if (this.busy || this.offline || this.pending != null) return;
    this.reset();
    this.recovery = job;
    this.failure = null;
    await this.connection.focusReview(() => this.reviewForm);
  };
  /** Starts polling and returns the owner's disposal callback. */
  mount = () => {
    this.pending = this.connection.readPending(this.storageKey);
    const dispose = this.connection.mount();
    return () => {
      dispose();
      this.password = "";
    };
  };
  constructor(private readonly current: HostConsoleOptions) {}
}
