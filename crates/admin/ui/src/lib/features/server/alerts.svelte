<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { i18n, translate } from "$lib/i18n/index.svelte";
  import { dateTimeText } from "$lib/formatting/date";
  import { RemoteResource } from "$lib/resources/remote-resource.svelte";
  import { request, sessionExpired } from "../updates/controller";
  import { integer, type Configuration } from "./contracts";
  import { parseAlertStatus, type AlertSettings, type AlertStatus } from "./alerts-contracts";
  import type { Operation } from "../host/controller";
  const SECOND_IN_MS = 1000;
  const STALE_SCAN_SECONDS = 300;
  const MIN_DISK_PERCENT = 5;
  const MAX_DISK_PERCENT = 50;
  const MAX_DISK_GIB = 1024;
  const MAX_CERTIFICATE_DAYS = 60;
  const MAX_REMINDER_HOURS = 168;

  let {
    project,
    disabled,
    revision,
    prepare,
    action,
    expired,
    ondirty,
    navigate,
  }: {
    project: string;
    disabled: boolean;
    revision: string;
    prepare: (configuration: Configuration) => Promise<boolean>;
    action: (operation: Operation) => Promise<boolean>;
    expired: () => void;
    ondirty: (value: boolean) => void;
    navigate: (proceed: () => void) => void;
  } = $props();
  const a = (key: string) => translate(i18n.locale, `alerts.${key}`);
  const POLL_MS = 30000;
  const alertStatus = new RemoteResource<AlertStatus>();
  const view = $derived(alertStatus.data),
    loading = $derived(alertStatus.loading);
  let failure = $state(""),
    dirty = $state(false),
    stale = $state(false);
  let enabled = $state(false),
    email = $state(false),
    webhook = $state(false),
    heartbeat = $state(false);
  let smtpProject = $state(""),
    recipient = $state(""),
    webhookUrl = $state(""),
    heartbeatUrl = $state("");
  let diskPercent = $state("15"),
    diskGib = $state("3"),
    certDays = $state("14"),
    backupHours = $state("26"),
    reminderHours = $state("24");
  let alive = true,
    saved = "",
    poll: ReturnType<typeof setTimeout> | undefined;
  const blocked = $derived(disabled || Boolean(view) === false || (loading && view === null));
  const active = $derived(view?.incidents.filter((i) => i.active) ?? []);
  const clockStale = $derived(
    view?.last_scan_at === null ||
      (view != null && Date.now() / SECOND_IN_MS - view.last_scan_at > STALE_SCAN_SECONDS),
  );
  function date(value: number | null | undefined): string {
    if (value == null) return a("never");
    return dateTimeText(value * SECOND_IN_MS, i18n.locale);
  }
  function mark(value: boolean) {
    dirty = value;
    ondirty(value);
  }
  function populate(v: AlertStatus) {
    const s = v.settings;
    saved = JSON.stringify(s);
    enabled = s.enabled;
    email = s.email_enabled;
    webhook = s.webhook_enabled;
    heartbeat = s.heartbeat_enabled;
    smtpProject = s.smtp_project !== "" ? s.smtp_project : project;
    recipient = s.recipient !== "" ? s.recipient : (v.recipients[0] ?? "");
    diskPercent = String(s.disk_percent);
    diskGib = String(s.disk_gib);
    certDays = String(s.certificate_days);
    backupHours = String(s.backup_hours);
    reminderHours = String(s.reminder_hours);
    webhookUrl = "";
    heartbeatUrl = "";
    stale = false;
    mark(false);
  }
  function schedulePoll() {
    clearTimeout(poll);
    poll = setTimeout(() => {
      if (document.hidden) {
        schedulePoll();
        return;
      }
      void load();
    }, POLL_MS);
  }
  function apply(next: AlertStatus, replace: boolean) {
    if (dirty === false || replace) populate(next);
    if (dirty && JSON.stringify(next.settings) !== saved) stale = true;
    failure = "";
  }
  async function load(replace = false) {
    if (alive === false) return;
    clearTimeout(poll);
    const loaded = await alertStatus.load(async (signal) =>
      parseAlertStatus((await request({ action: "host_alerts" }, signal)).data),
    );
    if (loaded) {
      // Poll first: nothing below may keep the next scan from being scheduled.
      schedulePoll();
      // `loaded` means the reply is in `data`; the check only narrows the type.
      if (alertStatus.data !== null) apply(alertStatus.data, replace);
      return;
    }
    // No error: a newer load replaced this one (and schedules the next poll) or the page closed.
    if (alertStatus.error === null) return;
    if (sessionExpired(alertStatus.error)) expired();
    else failure = a("loadFailed");
    schedulePoll();
  }
  $effect(() => {
    const changed = revision;
    untrack(() => {
      void load();
    });
    void changed;
  });
  onDestroy(() => {
    alive = false;
    alertStatus.cancel();
    clearTimeout(poll);
    webhookUrl = "";
    heartbeatUrl = "";
  });
  function alertSettings(): AlertSettings | null {
    const dp = integer(diskPercent, MIN_DISK_PERCENT, MAX_DISK_PERCENT),
      dg = integer(diskGib, 1, MAX_DISK_GIB),
      cd = integer(certDays, 1, MAX_CERTIFICATE_DAYS),
      bh = integer(backupHours, 1, MAX_REMINDER_HOURS),
      rh = integer(reminderHours, 1, MAX_REMINDER_HOURS);
    if (dp === null || dg === null || cd === null || bh === null || rh === null) {
      failure = a("invalid_alert_limits");
      return null;
    }
    return {
      enabled,
      email_enabled: email,
      webhook_enabled: webhook,
      heartbeat_enabled: heartbeat,
      smtp_project: smtpProject,
      recipient,
      disk_percent: dp,
      disk_gib: dg,
      certificate_days: cd,
      backup_hours: bh,
      reminder_hours: rh,
    };
  }
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (blocked || stale) return;
    const settings = alertSettings();
    if (settings === null) return;
    try {
      if (
        await prepare({
          section: "alerts",
          settings,
          webhook_url: webhookUrl === "" ? null : webhookUrl,
          heartbeat_url: heartbeatUrl === "" ? null : heartbeatUrl,
        })
      )
        mark(false);
    } finally {
      webhookUrl = "";
      heartbeatUrl = "";
    }
  }
</script>

<section
  class="grid gap-5 rounded-3xl border border-border bg-card p-6"
  aria-labelledby="alerts-title"
  aria-busy={loading && !view}
>
  <div class="flex flex-wrap items-center justify-between gap-3">
    <h2 id="alerts-title" class="text-xl font-semibold">{a("title")}</h2>
    <Button
      variant="outline"
      disabled={disabled || loading}
      onclick={() =>
        navigate(() => {
          mark(false);
          void load(true);
        })}>{a("reload")}</Button
    >
  </div>
  <p class="text-sm text-muted-foreground">{a("description")}</p>
  {#if failure}<p id="alerts-failure" role="alert" class="text-sm text-destructive">
      {failure}
    </p>{/if}
  {#if stale}<p role="alert" class="text-sm text-warning">{a("staleForm")}</p>{/if}
  {#if !view && loading}<p role="status">{a("loading")}</p>{/if}
  {#if view}
    <div class="grid gap-3 rounded-2xl bg-well p-4">
      <p class="font-medium" role="status">
        {view.settings.enabled
          ? view.monitor_error
            ? a("observerFailed")
            : clockStale
              ? a("observerStale")
              : view.maintenance
                ? a("maintenance")
                : active.length > 0
                  ? translate(i18n.locale, "alerts.activeCount", { count: active.length })
                  : a("noConfirmed")
          : a("disabled")}
      </p>
      {#if view.monitor_error === "alert_state_unavailable"}<p
          role="alert"
          class="text-sm text-destructive"
        >
          {a("stateUnavailable")}
        </p>{/if}
      <p class="text-sm">{a("lastScan")}: {date(view.last_scan_at)}</p>
      <p class="text-sm">{a("heartbeatAccepted")}: {date(view.heartbeat_accepted_at)}</p>
      {#if view.heartbeat_error}<p class="text-sm text-destructive">
          {a("alert_heartbeat_failed")}
        </p>{/if}
      {#each view.channels as channel}<p class="text-sm">
          {a(channel.channel)} · {a("lastDelivery")}: {date(
            channel.last_success_at,
          )}{#if channel.last_error}<span class="text-destructive">
              · {a("alert_delivery_failed")} · {a("retry")}: {date(channel.next_attempt_at)}</span
            >{/if}
        </p>{/each}
    </div>
    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
      <p class="font-medium">{a("externalTitle")}</p>
      <p class="mt-2">{a("externalRequired")}</p>
      <p class="mt-2">{a("externalSetup")}</p>
    </div>
    {#if view.incidents.length}<ul class="grid gap-2" aria-label={a("incidents")}>
        {#each view.incidents as item}<li
            class={`grid gap-1 break-words rounded-xl border p-4 ${item.active ? "border-amber-500/40" : "border-border"}`}
          >
            <p class="font-medium">{item.project ?? a("host")} · {a(item.kind)}</p>
            <p class="text-sm">
              {item.active ? a(item.severity) : a("recovered")} · {a("changed")}: {date(
                item.changed_at,
              )}
            </p>
          </li>{/each}
      </ul>{/if}
  {/if}
  <form class="grid gap-4" onsubmit={submit} oninput={() => mark(true)}>
    <label class="flex items-center gap-3"
      ><input type="checkbox" bind:checked={enabled} disabled={blocked} />{a("enable")}</label
    >
    <p class="text-sm text-muted-foreground">{a("scope")}</p>
    <fieldset
      class="grid gap-3 rounded-2xl border border-border p-4"
      disabled={blocked || !enabled}
    >
      <legend class="px-2">{a("email")}</legend>
      <label class="flex items-center gap-3"
        ><input type="checkbox" bind:checked={email} />{a("emailEnable")}</label
      >
      <label class="grid gap-2"
        ><span>{a("smtpProject")}</span><select
          class="rounded-xl border border-border bg-background p-3"
          bind:value={smtpProject}
          disabled={!email}
          required={email}
          ><option value="">{a("select")}</option>{#each view?.projects ?? [] as name}<option
              value={name}>{name}</option
            >{/each}</select
        ></label
      >
      <label class="grid gap-2"
        ><span>{a("recipient")}</span><select
          class="rounded-xl border border-border bg-background p-3"
          bind:value={recipient}
          disabled={!email}
          required={email}
          ><option value="">{a("select")}</option>{#each view?.recipients ?? [] as address}<option
              value={address}>{address}</option
            >{/each}</select
        ></label
      >
      <p class="text-sm text-muted-foreground">{a("smtpNotice")}</p>
    </fieldset>
    <fieldset
      class="grid gap-3 rounded-2xl border border-border p-4"
      disabled={blocked || !enabled}
    >
      <legend class="px-2">{a("webhook")}</legend>
      <label class="flex items-center gap-3"
        ><input type="checkbox" bind:checked={webhook} />{a("webhookEnable")}</label
      >
      <label class="grid gap-2"
        ><span>{a("webhookUrl")}</span><Input
          type="password"
          autocomplete="new-password"
          maxlength={2048}
          bind:value={webhookUrl}
          disabled={!webhook}
        /></label
      >
      <p class="break-all text-sm text-muted-foreground">
        {a("currentHost")}: {view?.webhook_host ?? a("notConfigured")}. {a("privateUrls")}
      </p>
      <p class="text-sm text-muted-foreground">{a("webhookNotice")}</p>
    </fieldset>
    <fieldset
      class="grid gap-3 rounded-2xl border border-border p-4"
      disabled={blocked || !enabled}
    >
      <legend class="px-2">{a("heartbeat")}</legend>
      <label class="flex items-center gap-3"
        ><input type="checkbox" bind:checked={heartbeat} />{a("heartbeatEnable")}</label
      >
      <label class="grid gap-2"
        ><span>{a("heartbeatUrl")}</span><Input
          type="password"
          autocomplete="new-password"
          maxlength={2048}
          bind:value={heartbeatUrl}
          disabled={!heartbeat}
        /></label
      >
      <p class="break-all text-sm text-muted-foreground">
        {a("currentHost")}: {view?.heartbeat_host ?? a("notConfigured")}. {a("privateUrls")}
      </p>
    </fieldset>
    <div class="grid gap-4 sm:grid-cols-2">
      {#each [["diskPercent", a("diskPercent"), 5, 50], ["diskGib", a("diskGib"), 1, 1024], ["certDays", a("certDays"), 1, 60], ["backupHours", a("backupHours"), 1, 168], ["reminderHours", a("reminderHours"), 1, 168]] as [key, label, min, max]}
        {@const value =
          key === "diskPercent"
            ? diskPercent
            : key === "diskGib"
              ? diskGib
              : key === "certDays"
                ? certDays
                : key === "backupHours"
                  ? backupHours
                  : reminderHours}
        {@const invalid = integer(value, Number(min), Number(max)) === null}
        <label class="grid gap-2"
          ><span>{label}</span><Input
            type="number"
            {min}
            {max}
            step={1}
            {value}
            aria-invalid={invalid}
            aria-describedby={invalid && failure ? "alerts-failure" : undefined}
            oninput={(event) => {
              const value = event.currentTarget.value;
              switch (key) {
                case "diskPercent":
                  diskPercent = value;
                  break;
                case "diskGib":
                  diskGib = value;
                  break;
                case "certDays":
                  certDays = value;
                  break;
                case "backupHours":
                  backupHours = value;
                  break;
                default:
                  reminderHours = value;
              }
            }}
            disabled={blocked}
            required
          /></label
        >
      {/each}
    </div>
    <p class="text-sm text-muted-foreground">{a("confirmationPolicy")}</p>
    <div class="flex flex-wrap gap-3">
      <Button type="submit" disabled={blocked || stale}>{a("preview")}</Button><Button
        type="button"
        variant="outline"
        disabled={blocked || dirty || stale || !view?.settings.enabled}
        onclick={() => void action({ kind: "test_alerts", project })}>{a("test")}</Button
      >
    </div>
    <p class="text-sm text-muted-foreground">{a("testNotice")}</p>
  </form>
</section>
