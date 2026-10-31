import type { Messages } from "../../../index.svelte";
import type ptBR from "../../pt-BR/data/webhooks";

const en: Messages<typeof ptBR> = {
  title: "Events and webhooks",
  description: "Send database changes to other services, with signatures and automatic retries.",
  summary: {
    outstanding: { one: "{count} delivery queued", other: "{count} deliveries queued" },
    retained: { one: "{count} delivery in history", other: "{count} deliveries in history" },
  },
  configuration: "Webhooks",
  deliveries: "Delivery history",
  webhook: "Webhook",
  create: "New webhook",
  edit: "Edit webhook",
  emptyTitle: "Connect the database to your services",
  emptyHint: "Choose a table, events and the URL that will receive each change.",
  noTables: "Create a table first",
  noTablesHint:
    "Webhooks watch ordinary tables in the exposed schema. Views and partitioned tables are unavailable in this version.",
  noDeliveries: "No deliveries here yet",
  noDeliveriesHint:
    "Changes made after enabling a webhook appear here. Adjust the filters if you are looking for a delivery.",
  name: "Name",
  table: "Table",
  destination: "Destination URL",
  events: "When to send",
  attempts: "Maximum attempts",
  namePlaceholder: "Notify about new orders",
  chooseTable: "Choose a table",
  urlHint:
    "Use public HTTPS without credentials, query parameters or a fragment. Rows from this table will be sent to this service.",
  localHint:
    "This environment also allows HTTP to localhost, 127.0.0.1 and ::1. Private networks remain blocked.",
  insert: "Row created",
  update: "Row updated",
  delete: "Row deleted",
  attemptsHint:
    "From 1 to 10, including the initial send. Temporary failures retry with increasing delays.",
  enabled: "Active",
  paused: "Paused",
  tableMissing: "Table missing",
  pause: "Pause",
  resume: "Enable",
  pauseTitle: "Pause {name}?",
  pauseConfirm: "Pause webhook",
  pauseHint:
    "Pausing stops capturing new changes and holds pending deliveries until enabled again. A send already in progress may finish.",
  missingTable: "The table no longer exists",
  saved: "Webhook saved.",
  created: "Webhook created.",
  removed: "Webhook deleted.",
  remove: "Delete",
  deleteConfirm: "Delete webhook",
  deleteTitle: "Delete {name}?",
  deleteHint:
    "Pending deliveries will be cancelled. History remains available for up to 7 days. A send already in progress may reach the destination.",
  rotate: "Rotate key",
  rotateTitle: "Rotate the key for {name}?",
  rotateHint:
    "New sends will use the new key. Update the receiving service; a send already in progress may use the previous key.",
  secretTitle: "Save the signing key",
  secretHint:
    "It is shown only once. Copy it to the service receiving events. If you lose it, you can rotate it.",
  copySecret: "Copy key",
  secretCopied: "I’ve copied the key",
  closeWithoutCopy: "Close without copying",
  secretNotCopied: "You have not copied the key yet. Once closed, it will not be shown again.",
  secretHelp:
    "Verify the signature and timestamp before processing. Use the event ID to avoid repeating an action on retries or resends.",
  guide: "How to receive and verify events",
  retryGuide:
    "Deliveries receive up to 6 attempts by default. 2xx responses acknowledge; temporary failures retry automatically.",
  retention: "History for up to 7 days. Pending events remain queued until completed or cancelled.",
  attemptsOf: { one: "{done} of {count} attempt", other: "{done} of {count} attempts" },
  capacity:
    "Many deliveries are waiting. Each webhook queues up to 10,000; beyond that, new events are recorded as failed. Check failed or paused destinations.",
  clear: "Clear history",
  clearTitle: "Clear completed history?",
  clearHint:
    "Succeeded, failed and cancelled deliveries will be removed, including their payloads. Pending deliveries remain queued.",
  cleared: "Completed history cleared.",
  allWebhooks: "All webhooks",
  allStatuses: "All states",
  webhookFilter: "Filter by webhook",
  statusFilter: "Filter by state",
  status: {
    pending: "Waiting",
    processing: "Sending",
    succeeded: "Delivered",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  sent: "Created",
  event: "Event",
  result: "Result",
  view: "View delivery",
  firstPage: "Newest",
  nextPage: "Older",
  deliveryTitle: "Delivery #{id}",
  eventId: "Event ID",
  deliveryId: "Delivery ID",
  payload: "Payload",
  attemptHistory: "Attempts",
  attempt: "Attempt",
  started: "Started",
  duration: "Duration",
  nextAttempt: "Next attempt",
  noAttempts: "No send started yet.",
  replay: "Resend",
  replayTitle: "Resend this event?",
  replayHint:
    "A new delivery will use the webhook’s current URL and key. The event ID and payload stay the same. The service may ignore an already processed event.",
  replayed: "Resend queued.",
  replayOf: "Resend of delivery #{id}",
  destinationHint:
    "Queued deliveries and retries use the current URL. A send in progress finishes at the previous one.",
  failures: {
    http_error: "The destination rejected the send.",
    network_error: "Could not connect to the destination. Check its URL, DNS and certificate.",
    timeout: "The destination took too long to respond.",
    invalid_destination: "Destination blocked by the security rules.",
    worker_interrupted: "The send was interrupted; the queue recovered the attempt.",
    payload_too_large:
      "The payload exceeded 256 KiB. Its contents were omitted and cannot be resent.",
    endpoint_deleted: "The webhook was deleted.",
    dns_busy:
      "Local DNS lookups were saturated. The send is retried shortly without using an attempt.",
    queue_full:
      "This webhook already had 10,000 deliveries waiting. The event was recorded without its contents and cannot be resent.",
  },
};

export default en;
