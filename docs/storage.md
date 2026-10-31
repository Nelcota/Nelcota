# Storage

Files with the same rule as everything else: **Postgres decides access.**
Each file is a row in `storage.objects`; RLS policies on that table say who
may upload, read, replace or delete it. The bytes live on the server's disk
or in any S3-compatible bucket. The design and its reasons are D77–D80 in
[decisions.md](decisions.md).

## Prerequisites

You need initialized storage metadata, an enabled disk/S3 backend and policies
for your caller. Examples assume an authenticated user and explicit bucket setup.
This page describes source behavior; check the matching release for published
limits and fixes. Keep provider secrets in the private deployment configuration.

## Turning it on

New projects (`nelcota init`) keep files on the project's disk:

```sh
NELCOTA_STORAGE_BACKEND=disk
NELCOTA_STORAGE_DIR=/storage        # projects/<name>/storage on the host
```

In production, an S3-compatible bucket keeps files off a single disk
(Cloudflare R2, Backblaze B2, AWS S3, Wasabi...):

```sh
NELCOTA_STORAGE_BACKEND=s3
NELCOTA_STORAGE_S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # empty = AWS
NELCOTA_STORAGE_S3_BUCKET=files
NELCOTA_STORAGE_S3_REGION=auto                                          # R2: auto; AWS: us-east-1...
NELCOTA_STORAGE_S3_ACCESS_KEY_ID=...
NELCOTA_STORAGE_S3_SECRET_ACCESS_KEY=...
# NELCOTA_STORAGE_S3_VIRTUAL_HOSTED=true   # bucket.endpoint URLs, if the provider requires them
```

Then `nelcota -p <name> up`. Without `NELCOTA_STORAGE_BACKEND` storage is off
and `/storage/v1` does not exist. A project created before storage existed
turns it on by adding the two `disk` lines to its `.env` and
`- ./storage:/storage` to the app's `volumes` in `docker-compose.yml`
(`mkdir storage && chown 65532:65532 storage` first).

On Unix, the CLI creates the disk storage root with mode **0700**, owned by
the app's UID 65532 on Docker hosts. The server also enforces 0700 at startup
on existing roots, before opening the store. This prevents other host users
from reading or enumerating private files, including staged uploads and old
files, regardless of their individual modes. The server must own the root
and be allowed to change its permissions. Windows deployments require the
equivalent directory ACL; Unix modes do not configure Windows ACLs.

| Variable | Default | |
|---|---|---|
| `NELCOTA_STORAGE_MAX_FILE_SIZE` | 50 MiB | largest file; a bucket can only lower it |
| `NELCOTA_STORAGE_MAX_TOTAL_SIZE` | none | cap on all buckets together, in bytes |
| `NELCOTA_STORAGE_MIN_FREE_BYTES` | 1 GiB | disk backend: refuse uploads that would leave less free space |
| `NELCOTA_STORAGE_UPLOAD_TIMEOUT_SECS` | 3600 | shared deadline for admission, database/policy waits and receiving bytes |
| `NELCOTA_STORAGE_PUBLIC_URL` | the API's | origin of public file URLs, e.g. `https://files.shop.com` |

Uploads reserve capacity while their bodies are being received. A request
without `Content-Length` grows its reservation as bytes arrive, up to 1 MiB
ahead of what it has received but never more than half of the capacity left,
so small concurrent uploads still share the remaining capacity. Near a full
quota, that room held ahead can refuse another upload slightly early, by at
most 1 MiB per upload in progress. Declared lengths reserve their full size
before reception.
The committed total is checked in a serialized database transaction, including
when several server instances share the same database. Replacements receive
credit for their old bytes against the total quota, but still need disk space
for the new version while it is being written.

At most **32 uploads** may be active in a process. Excess attempts return
`503 upload_busy` immediately. Admission and byte reception share the configured
deadline, including pool and quota waits (`408 upload_timeout`); metadata
publication then settles with database timeouts so cancellation cannot delete
bytes after an ambiguous commit.

Canceled or timed-out multipart uploads abort their uploaded parts in a bounded
cleanup task. Creation and cleanup share the 32-upload capacity; creation may
settle for up to 30 seconds and abort for up to 10 seconds after cancellation.
Configure an S3 `AbortIncompleteMultipartUpload` lifecycle rule as well: process
crashes, unavailable providers or an initiation response lost before its upload
ID arrives cannot be cleaned up reliably by the server. Object garbage
collection only sees completed objects, not unfinished multipart parts.

`storage.usage` holds the committed byte total. Statement-level triggers update
it transactionally for inserts, updates, deletes, upserts and truncation,
including administrative SQL; bulk statements aggregate their changes once.
Only the internal storage role can read it. No caller role can modify it.
The migration initializes it while metadata writes are locked. If an operator
disabled triggers during maintenance, reconcile before resuming writes:

```sql
BEGIN;
LOCK TABLE storage.objects IN SHARE MODE;
UPDATE storage.usage SET bytes = (SELECT coalesce(sum(size), 0)::bigint FROM storage.objects)
WHERE singleton;
COMMIT;
```

## Buckets and policies

A bucket is a row in `storage.buckets`. Create it in a migration (or with
`POST /storage/v1/bucket` as `service_role`):

```sql
-- migrations/V2__avatars.sql
INSERT INTO storage.buckets (id, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', true, 2097152, '{image/*}');

-- Each user writes only into the folder named after their id.
CREATE POLICY avatar_owner ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text)
    WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
```

**Until a policy says otherwise, nobody but `service_role` reaches any file.**
`public` only opens reads through `/object/public/`; writes to a public bucket
still go through the policies.

| Operation | Policies needed |
|---|---|
| upload (`POST`) | `INSERT` |
| replace (`PUT`) | `INSERT`, `SELECT`, `UPDATE` |
| download, sign, list | `SELECT` |
| delete | `SELECT`, `DELETE` |

An upload (`POST` or `PUT`) to a name already taken by a file the caller
cannot see answers exactly like a policy refusal (403, or 401 for `anon`), not
409 `object_exists`. Names are still unique in a bucket: where policies let a
caller create files in a shared folder, a refusal there, where another name
would be accepted, reveals that the name is in use. Give each user a folder of
their own when names must stay private.

`owner` is filled with `auth.uid()` on upload, so `owner = auth.uid()` is the
simplest private-files policy. Helpers for paths:
`storage.foldername('a/b/c.png')` → `{a,b}`, `storage.filename(...)` →
`c.png`, `storage.extension(...)` → `png`. A policy sees the final row,
including `size`, so a per-user quota is a policy too:

```sql
CREATE POLICY quota ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK ((SELECT coalesce(sum(size), 0) FROM storage.objects
                  WHERE owner = auth.uid()) + size <= 100 * 1024 * 1024);
```

Bucket names: lowercase letters, digits, `-` and `_`; `public`, `sign` and
`list` are reserved. A bucket with files cannot be dropped.

## HTTP API

Every route takes the usual `Authorization: Bearer <jwt>` (none = `anon`).
Paths are percent-encoded; segments cannot be empty, `.` or `..`.

```sh
# upload (409 if the name exists; PUT replaces)
curl -X POST "$API/storage/v1/object/avatars/$USER_ID/me.png" \
  -H "authorization: Bearer $TOKEN" -H 'content-type: image/png' --data-binary @me.png
# {"id":"...","bucket":"avatars","name":"<id>/me.png","size":48213,
#  "mime_type":"image/png","etag":"...","public_url":"/storage/v1/object/public/avatars/<id>/me.png"}

curl "$API/storage/v1/object/avatars/$USER_ID/me.png" -H "authorization: Bearer $TOKEN"   # download
curl "$API/storage/v1/object/public/avatars/$USER_ID/me.png"                               # public bucket
curl -X DELETE "$API/storage/v1/object/avatars/$USER_ID/me.png" -H "authorization: Bearer $TOKEN"
```

| Route | |
|---|---|
| `POST /storage/v1/object/{bucket}/{path}` | upload a new file (201) |
| `PUT /storage/v1/object/{bucket}/{path}` | upload or replace (200 replaced, 201 created) |
| `GET /storage/v1/object/{bucket}/{path}` | download under the caller's policies |
| `GET /storage/v1/object/public/{bucket}/{path}` | download from a public bucket, no token |
| `POST /storage/v1/object/sign/{bucket}/{path}` | `{"expires_in": 3600}` → `{"signed_url": "..."}` (up to 7 days) |
| `GET /storage/v1/object/sign/{bucket}/{path}?token=...` | download with a signed URL, no token |
| `POST /storage/v1/object/list/{bucket}` | `{"prefix": "a/", "limit": 100, "offset": 0}` → `{"folders": [...], "objects": [...]}` |
| `DELETE /storage/v1/object/{bucket}/{path}` | delete (204) |
| `GET/POST /storage/v1/bucket`, `GET/PUT/DELETE /storage/v1/bucket/{id}` | buckets (writes: `service_role`) |

Listing applies `limit` and `offset` independently to the sorted `folders` and
`objects` arrays. Advance the offset by the requested limit while either array
fills a page; a page containing only folders can still have a next page.

A signed URL covers the version of the file that was signed. Once the file is
replaced, or deleted and uploaded again under the same name, the URL answers
404 `object_not_found`; sign the new version again.

A file the caller may not see answers 404, as if it did not exist. Downloads
take `?download` to force a "save as". Errors: 400 `invalid_path`, 404
`bucket_not_found`/`object_not_found`, 409 `object_exists`, 413
`file_too_large`, 415 `mime_type_not_allowed`, 507 `storage_full`. The JSON
endpoints (bucket writes, list, sign) answer 400/422 `invalid_body` for a
malformed body and 415 `unsupported_media_type` without `Content-Type:
application/json`; a range that cannot be served is 416
`range_not_satisfiable` (with `Content-Range: bytes */<size>`). Every error
has the API's JSON shape (see [api.md](api.md#errors)).

## How files are served

- **The type comes from the bytes**, not from the client: a "PNG" that is
  really HTML is stored as `text/html` (and refused by an `image/*` bucket).
- **Files are inert.** Only images (not SVG), audio, video and plain text open
  in the browser; HTML, SVG, PDF and the rest download. Files served from disk
  also carry `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: sandbox` (S3: see below).
  For public files on their own origin, point `NELCOTA_STORAGE_PUBLIC_URL` at
  a second domain that proxies `/storage/v1/object/public/*` to the app.
- **Disk:** `Range` (video seeking, resumed downloads), `ETag` and
  `If-None-Match`. Public files are cacheable for 60 s; private ones are
  revalidated each time.
- **S3:** downloads are a `302` to a presigned URL valid for at most 5 minutes;
  the bytes come straight from the provider. The URL fixes the file's
  `Content-Type` and `Content-Disposition`, but a presigned URL cannot set
  security headers, so the provider's response lacks
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
  Add both on the provider (bucket response-header settings, where it has them)
  or on a CDN in front of the bucket.

## Consistency

A file's bytes are stored under a new key (`<bucket>/<uuidv7>`) on every
upload, and the row is written only after the bytes are complete. Readers
never see a half-written file. Known failures before metadata publication
attempt to remove the unpublished bytes. If the database's commit reply is
lost, the request returns an error but retains the new version: PostgreSQL
may already reference it. Check the current object before retrying a write
whose outcome is unknown.

Replacing or deleting a file removes the old bytes right away:
**a database restore does not bring deleted files back**. An hourly collector
checks authoritative metadata and removes unreferenced versions once they are
a day old, including bytes left by an interrupted upload or an uncertain
publication. A version still referenced by a row is retained.

On disk, collection also checks hidden `<bucket>/<uuidv7>#<part>` staging files
left by a process crash. Both the version timestamp and the file's last write
must be older than the collection grace period. The grace is at least one day
and exceeds the configured upload deadline by an hour. Foreign names, symlinks
and directories are retained, and the same ownership checks guard deletion.
Failed deletes emit `storage.collector_delete_failed` and are retried later.

Use a separate physical disk root or S3 bucket for each independent metadata
database. Application instances connected to the same writable metadata database
may share it. Independent physical copies, lagging database replicas and older
writers that do not enforce ownership must use separate targets. The server
records a database identity in `.nelcota-gc-owner-v1`. If another database uses
that store, or an unmarked store contains versioned files not known to the current
database, it records `.nelcota-gc-shared-v1` and disables automatic collection.
File APIs remain available; ambiguous bytes are retained. Missing, changed or
unsafe ownership markers also prevent collection. These internal markers are
not objects in the file API and are never automatically removed.

After `storage.collector_quarantined` or `storage.ownership_unavailable`, keep
the original store and investigate before deleting anything. Stop sharing the
target, provision a separate empty target for each database, and copy only that
database's referenced `<bucket>/<version>` objects into its target while writes
are stopped. Verify the restored files against metadata/backups, then restart
with that target: it can be adopted when every version is accounted for. Do not
remove markers to make an ambiguous target collectible. A provider outage or a
large legacy scan may defer initialization; uploads retry within their existing
deadline and collection stays disabled until ownership can be verified.

## Backups

With the disk backend, every dump has its own `<dump>.files/` snapshot and
SHA-256 manifest. `nelcota backup --upload` uploads that immutable snapshot to
`s3://<backup bucket>/<project>/<dump>.files/`. Later file deletions leave older
snapshots intact. After losing the server:

```sh
nelcota -p shop restore projects/shop/backups/nelcota-shop-<date>.dump --files --yes
```

`--files` verifies and restores that dump's snapshot, locally or from the backup
bucket. Keep the `.dump` and `.dump.files/` directory together. With the S3 backend the
files never leave the provider; use its versioning or replication if you need
more copies.

## Leaving

The metadata is plain SQL (`storage.objects`), the bytes are ordinary files or
S3 objects. To get them back under their names:

```sql
SELECT bucket_id || '/' || version AS key, bucket_id || '/' || name AS name
  FROM storage.objects;
```

## Related guides

See [REST API](api.md), [backup](backup.md), [JWT/roles](jwt-and-roles.md) and [troubleshooting](troubleshooting.md).
