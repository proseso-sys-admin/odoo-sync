# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

```
worker/           Node.js 20 ESM — the sync worker
OdooSync.txt      Original Google Apps Script version (historical reference only)
```

All active code is in `worker/`. `OdooSync.txt` is the prior Apps Script implementation it was ported from; do not edit it.

---

## worker/ — Odoo Sync Worker

Node.js (ESM, `"type": "module"`) service that syncs `project.task` attachments from one **source** Odoo database to multiple **target** client Odoo databases.

### Commands

```bash
cd worker
npm install

# One-shot sync (local test or Cloud Run Job)
npm run sync

# HTTP server on :8080, then GET/POST /sync or POST /webhook
npm start

# Debug mode (verbose bucket resolution logging)
ODOO_SYNC_DEBUG=1 npm run sync
```

### Environment variables

Copy `worker/.env.example` to `worker/.env`. Required:

| Var | Purpose |
|-----|---------|
| `SOURCE_BASE_URL` | Source Odoo root URL (e.g. `https://company.odoo.com`) — no `/web` suffix |
| `SOURCE_DB` | Source database name |
| `SOURCE_LOGIN` | Source login (email) |
| `SOURCE_PASSWORD` | Source password or API key |
| `STATE_GCS_BUCKET` | GCS bucket name (no `gs://`) for sync state file |
| `STATE_GCS_PATH` | Path inside bucket, e.g. `odoosync/state.json` |

Optional:

| Var | Purpose |
|-----|---------|
| `WEBHOOK_SECRET` | If set, `POST /webhook` requires header `X-Webhook-Secret` to match |
| `MAX_CONCURRENT_TARGETS` | Parallel target DB cap (default 10) |
| `ATTACHMENT_BATCH_LIMIT` | Attachments fetched per run (default 200) |
| `ODOO_SYNC_DEBUG` | `1` or `true` — verbose tax bucket logging |
| `ODOO_SYNC_RESET_TAX_CURSOR` | `1` for one-time full rescan (unset after one run) |
| `ODOO_SYNC_TAX_RESCAN_DAYS` | Run full rescan every N days automatically |

### Deployment

Push to `master` on `https://github.com/proseso-sys-admin/odoo-sync` triggers Cloud Build (`worker/cloudbuild.yaml`) → builds image → deploys to Cloud Run in `asia-southeast1`.

`gh` CLI is available and authenticated. Pushing directly to `master` is allowed.

## Smoke Testing

After deploying:
```bash
./smoke-test.sh https://odoo-sync-worker-njiacix2yq-as.a.run.app
```

Verifies root, sync, and webhook endpoints are reachable.

---

## Architecture

### Two sync flows (run in parallel)

**Tax PH + Gvt contribs** (`taxSync.js`)
- Cursor-based: fetches `ir.attachment` with `id > lastId` (stored in GCS state file)
- Only syncs attachments on tasks in stage `"APPROVED / DONE"` whose name matches:
  - `Tax PH` + `[YYYY.MM]` or `[YYYY]` → into `Taxes and Statutories / Year / Bucket / Month`
  - `Gvt contribs Filing` + `[YYYY.MM]` or `[YYYY]` → same root, different buckets (SSS/PHIC/HDMF/…)
- Bucket resolved from task M2M fields (primary) → `res_field` → fallback scan
- GC pass per target: removes synced attachments whose source no longer qualifies

**Onboarding** (`onboardingSync.js`)
- Per-route: reads `x_studio_permanent_files` + `x_studio_temporary_files` from the source **General** task
- Syncs all referenced attachments to a flat `Onboarding` folder on the target
- GC: removes target docs not in the current allowed set

### Routing (`routes.js`)

Routes come from source Odoo — not a spreadsheet. A route is created for each project that has:
- A task named `"Tax PH …"` in stage `"Master"`
- A **General** task in that project with `x_studio_enabled = true` AND `x_studio_odoo_document_sync = true`
- `x_studio_email`, `x_studio_api_key`, and `x_studio_accounting_database` set

`x_studio_accounting_database` accepts a URL, subdomain name, or `{"baseUrl":"…"}` JSON; `parseAcctDb()` in `odoo.js` normalises all three forms.

### State (`state.js`)

Single JSON file in GCS: `{ ODOO_SYNC_LAST_ATTACHMENT_ID: "12345", "ODOO_SYNC_GC_LAST_TARGET_ATT_ID|…": "…" }`.
Falls back to in-memory (warns) when GCS auth fails locally — leave `STATE_GCS_BUCKET` empty in `.env` to run fully in-memory.

### Idempotency

Every synced attachment gets `description = "ODOO_SYNC|SRC_DB=<db>|SRC_ATT=<id>"` on the **target** `ir.attachment`. This marker is checked before creating a duplicate; `parseSrcAttIdFromMarker()` / `buildMarker()` in `odoo.js` are the canonical functions.

### Folder management (`folders.js`)

`findOrCreateFolder()` uses a per-process in-memory cache + a per-key Promise lock to prevent race-condition duplicate creation when multiple targets run in parallel. `evictFolderById()` clears the cache when an archived-folder error is caught.

### HTTP endpoints (`index.js`)

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET/POST` | `/` or `/sync` | Full sync (optional `target_*` query params to limit to one target) |
| `POST` | `/webhook` | Smart dispatch: `project.task` write → `runTaskAttachmentsSync`; `ir.attachment` create/delete → single-attachment sync/delete; otherwise full sync |

### Webhook retry logic

When a webhook fires on `ir.attachment` create, Odoo has not yet written the M2M bucket field on the task. Both `syncSingleAttachment` and `syncSingleOnboardingAttachment` retry up to 3 times (3-5 s delays) before falling back to `res_field`-based bucket detection.

### Module map

| File | Role |
|------|------|
| `src/index.js` | HTTP server entrypoint |
| `src/cli-sync.js` | One-shot CLI entrypoint |
| `src/runSync.js` | Orchestrator: loads routes, runs both flows in parallel |
| `src/routes.js` | Loads routing from source Odoo General tasks |
| `src/taxSync.js` | Tax PH + Gvt contribs sync + GC |
| `src/onboardingSync.js` | Onboarding sync + GC |
| `src/folders.js` | Target folder cache + create logic; bucket→field maps |
| `src/docs.js` | `upsertMoveDocumentForAttachment`, `deleteTargetDocAndAttachment` |
| `src/odoo.js` | JSON-RPC client, URL normalisation, marker helpers, task-name parsers |
| `src/state.js` | GCS-backed sync cursor and GC cursor read/write |
| `src/config.js` | Env validation + exported constants |

---

## Key constraints and gotchas

- **GCS auth locally**: run `gcloud auth application-default login` before `npm run sync`, or leave `STATE_GCS_BUCKET` empty to use in-memory state.
- **Cursor reset for backfill**: set `ODOO_SYNC_RESET_TAX_CURSOR=1`, run once, then unset. Idempotency prevents duplicates.
- **`nAttIds: 0`** means the cursor is already past the attachment IDs you expect — see `docs/TAX-SYNC-FIELDS.md`.
- **Stage name** is matched as the string `"APPROVED / DONE"` (upper-cased) — the Odoo display is "Approved / Done".
- **`ATTACHMENT_DELETED` / `FOLDER_ARCHIVED`** are sentinel error codes thrown by `docs.js` and caught + recovered in the calling sync functions.
- **Multi-company**: when `x_studio_multi_company` is true, `x_studio_company_id_if_multi_company` is used as `company_id`; otherwise defaults to `1`.
- **`OdooSync.txt`**: original Apps Script code, kept for reference. Do not port changes back to it.

