# Events and webhooks

Send committed database changes to an HTTP endpoint. Configuration, signing keys and delivery history are under **Events** in the panel. The same Rust binary dispatches deliveries; Postgres stores the queue, so a restart does not lose pending work.

## Prerequisites

Use server 0.4.0+ with administrator access and a trusted receiver. The receiver
needs bounded raw-body signature verification and durable event-ID deduplication.

## Create a webhook

1. Open **Events → New webhook**.
2. Name it, choose a table and select `INSERT`, `UPDATE` and/or `DELETE`.
3. Enter the public HTTPS URL that receives JSON POST requests.
4. Keep the default six attempts, or choose one to ten.
5. Save and copy the signing key to your receiving service. It appears only once.

Only ordinary tables in the exposed schema are supported in this version. Views, partitioned tables, storage metadata and authentication tables are excluded. A table rename keeps its webhooks, because capture follows its PostgreSQL object identity. Dropping and recreating a table requires a new webhook.

Pausing stops capturing new changes and holds existing pending deliveries. Reactivating resumes the queue; changes made while paused are not replayed. Deleting cancels pending work and removes the key, while keeping terminal delivery history. A send already in progress may still arrive after a pause, deletion or key rotation.

Editing a URL applies to every send that starts afterwards. Queued deliveries and retries go to the new URL, signed with the current key, so a backlog is not released to a destination you replaced. A send already started, or claimed while the edit was being saved, still goes once to the previous URL (at most two per webhook). Resending uses the webhook's current URL, key and attempt limit. Key rotation takes effect on newly started sends; update the receiver before resuming a paused webhook.

## Event payload

The receiver gets a JSON object. The event ID is stable across retries, resends and destinations receiving the same database change. Each destination and manual resend has its own delivery ID.

```json
{
  "version": 1,
  "id": "94ca9597-b0d8-4c4c-a8ba-e5052c031382",
  "schema": "public",
  "table": "orders",
  "type": "UPDATE",
  "occurred_at": "2026-10-11T12:00:00Z",
  "record": { "id": 42, "status": "paid" },
  "old_record": { "id": 42, "status": "pending" }
}
```

For `INSERT`, `old_record` is null. For `DELETE`, `record` is null. Changes made through REST, RPC, the panel or direct SQL are captured by the same trigger. The event commits with the changed row; a rolled-back transaction creates no delivery. Capture never makes a network call.

The destination receives the full changed row and, for updates/deletes, the previous row. Only project administrators configure destinations. Public API roles cannot inspect the queue or keys; RLS continues to decide which business rows those roles can change. Webhooks are privileged server-to-server integrations, not subscriptions filtered for individual users.

## Verify signatures

Each request includes these headers:

| Header | Meaning |
| --- | --- |
| `x-nelcota-event-id` | Stable event UUID; use it for durable deduplication |
| `x-nelcota-delivery-id` | Delivery identifier shown in the panel |
| `x-nelcota-timestamp` | Unix timestamp in seconds for this send |
| `x-nelcota-signature` | `v1=` followed by the lowercase HMAC-SHA256 hex digest |

The signed bytes are the event ID, a period, the timestamp, another period and the exact request body. The HMAC key is the literal signing-key string, including its prefix. Use the raw body before parsing JSON, reject timestamps more than five minutes from your server clock, compare in constant time, then check that the payload ID matches the signed header.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(headers, rawBody, secret) {
  const id = headers.get('x-nelcota-event-id') ?? '';
  const timestamp = headers.get('x-nelcota-timestamp') ?? '';
  const signature = headers.get('x-nelcota-signature') ?? '';
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  if (!/^v1=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret)
    .update(`${id}.${timestamp}.`).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}
```

Keep the receiving body bounded to 256 KiB. After verifying, parse JSON and process once per event ID in a database transaction with a unique constraint. Record acceptance durably before replying with 2xx. A repeated event should also receive 2xx, without repeating the action. For multiple independent consumers sharing a database, deduplicate by consumer and event ID.

## Retries and delivery history

Any 2xx response acknowledges delivery. Network errors, timeouts, HTTP 408, 425, 429 and 5xx retry automatically. Other statuses, including redirects, are terminal failures. The receiver has ten seconds to answer; a separate twelve-second deadline also bounds DNS and connection setup.

Retry delays start at approximately 5 seconds, 30 seconds, 2 minutes, 10 minutes, 30 minutes and 1 hour, with jitter and a one-hour cap. A numeric `Retry-After` is respected up to one hour without reducing the normal delay. Six attempts by default means the initial send and five retries. A lost worker lease is recovered after two minutes and still counts as an attempt.

Delivery is **at least once**, with no ordering guarantee. A receiver may process an event whose acknowledgement never reaches Nelcota; the next attempt may send it again. Multiple workers claim queue rows with short leases and do not hold a database connection during HTTP calls. Each webhook has at most two sends in progress, and every claim takes the oldest due delivery of each webhook in turn, so a slow destination cannot delay the others. A send that cannot start because local DNS lookups are saturated is retried two seconds later without using an attempt, and history shows `dns_busy`. After about a minute of such retries, the next one uses an attempt like any other network failure.

The history shows status, HTTP code, attempts, timestamps and the exact payload. A delivery detail shows every attempt, including sends interrupted by a restart. **Resend** creates a new delivery, preserving the original history and stable event ID. Active deliveries cannot be resent; the webhook must be enabled. Receiver response bodies and signing keys never appear in history.

## Limits and retention

There are at most 50 webhooks per project (paused ones included, deleted ones excluded) and ten per table. Each webhook queues at most 10,000 outstanding deliveries. A change captured beyond that limit is recorded as a visibly failed `queue_full` delivery with omitted contents, while the business write still commits, so a stalled destination never blocks database writes or other webhooks. The limit is approximate while several transactions write at once. **Resend** is refused while a webhook is at the limit. After fixing the destination, reconcile those changes from the table itself. The panel shows usage and warns once 8,000 deliveries are waiting in total.

Terminal history is kept for up to seven days and at most the newest 100,000 terminal deliveries; older ones are cleaned every minute in bounded batches, which continue while there is more to remove, so cleanup keeps pace with a sustained burst. History never blocks writes. Pending deliveries are never deleted by age. **Clear history** removes only terminal deliveries and their payloads. To free a stalled queue, fix or enable its destinations, or delete unwanted webhooks to cancel their pending work. Keep database backups private: they contain signing keys and event payloads.

A payload larger than 256 KiB also produces a visibly failed delivery with omitted contents (`payload_too_large`), while the business row still commits. Deliveries with omitted contents cannot be resent; reduce the row size or use another integration for large values. Changes to a hook configuration are project configuration, separate from schema migration exports.

## Destination safety and local development

Public destinations require HTTPS with certificate verification. Credentials, query parameters and fragments in URLs are rejected. Redirects and environment proxy settings are disabled. Private, loopback, link-local, metadata, carrier-grade NAT, multicast and reserved IP ranges are blocked, including DNS answers at connection time. All addresses in a DNS answer must pass the policy, preventing DNS rebinding into internal services.

For local development only, set `NELCOTA_WEBHOOKS_ALLOW_LOOPBACK=true` and restart. This permits HTTP or HTTPS to `localhost`, `127.0.0.1` and `::1`; it never opens private networks or metadata addresses. The server refuses to start when it is combined with `NELCOTA_PRODUCTION=true`. Inside Docker, loopback refers to the Nelcota container, not the host. Use a public HTTPS development tunnel when the receiver runs outside that container.

No Redis, HTTP extension, extra server or Node process is required for dispatch. The queue worker uses a small pool separate from API and panel connections. A graceful shutdown stops claiming work and gives started deliveries time to finish; unfinished leases remain recoverable after startup.

## Related guides

See [REST API](api.md), [panel](panel.md), [backup](backup.md) and [architecture](architecture.md).
