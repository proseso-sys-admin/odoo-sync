# Tax PH and Gvt contribs sync: fields and why a task might not sync

The worker syncs two kinds of tasks into the **Taxes and Statutories** folder (same root, same Year / Bucket / Month structure): **Tax PH** and **Gvt contribs Filing**.

## What the worker looks at

### 1. Which attachments are fetched (ir.attachment)

- **res_model** = `'project.task'`
- **type** = `'binary'`
- **id** > **last_attachment_id** (cursor stored in GCS)

Only attachments with **id greater than the cursor** are considered. If the cursor was already advanced past your attachment IDs (e.g. from a previous run), you get **nAttIds: 0** and nothing is processed.

### 2. For each attachment we read the task (project.task)

- **project_id** – must match a route (project with sync enabled on General task).
- **name** – must match **either**:
  - **Tax PH:** contains "Tax PH" (case-insensitive) and a period in brackets: `[YYYY]` or `[YYYY.MM]` (e.g. `[2026]`, `[2026.01]`), **or**
  - **Gvt contribs Filing:** contains "Gvt contribs Filing" (case-insensitive) and the same bracket period pattern.
- **stage_id** – we use the stage **name** (second element of the M2O). It must be exactly **"APPROVED / DONE"** after trimming and uppercasing (so "Approved / Done" in Odoo is correct).

### 3. Exact checks in code

| Check | Source | Required |
|-------|--------|----------|
| Route exists for project | `routingObj[String(pid)]` | Project must have General task with sync enabled, x_studio_odoo_document_sync true, email, api key, accounting DB. |
| Stage name | `task.stage_id` → name, trimmed, uppercased | Must equal `"APPROVED / DONE"`. |
| Task name (Tax PH) | `task.name` | Must match `Tax PH` (regex) and `\[(20\d{2})(\.(0[1-9]|1[0-2]))?\]` (e.g. `[2026.01]`). |
| Task name (Gvt contribs) | `task.name` | Must match `Gvt contribs Filing` (regex) and the same bracket period pattern. |

So **"Tax PH [2026.01]"** or **"Gvt contribs Filing [2026.01]"** in stage **"Approved / Done"** satisfy the task name and stage checks. The usual reason nothing syncs is the **cursor**.

### 4. Field → folder mapping (Gvt contribs Filing)

| Source field | Target folder name (under Taxes and Statutories / Year / …) |
|--------------|-------------------------------------------------------------|
| `x_studio_sss_contributions` | SSS |
| `x_studio_philhealth_contributions` | PHIC |
| `x_studio_pag_ibig_contributions` | HDMF |
| `x_studio_sss_loans` | SSS Loans |
| `x_studio_pag_ibig_loans` | HDMF Loans |

Tax PH uses the same structure with buckets VAT, Expanded Withholding Tax, Withholding Tax on Compensation, Income Tax, Others (see `FIELD_TO_TAX_BUCKET` in code).

## Why you see nAttIds: 0

The worker only fetches:

```text
ir.attachment where res_model='project.task' and type='binary' and id > last_attachment_id
```

If **last_attachment_id** (in your GCS state file) is already **greater than** the IDs of the attachments on your "Tax PH [2026.01]" task, those attachments are never fetched, so they never sync.

This happens when:

- The cursor was advanced by an earlier run (e.g. 200 attachments processed, cursor set to the highest id), or
- State was copied from the old Apps Script and already had a high cursor.

## Fix: reset the cursor so those attachments are considered again

### Option A: Env var (recommended)

Set **ODOO_SYNC_RESET_TAX_CURSOR=1** (or `true`) for one run. The next sync will use cursor 0 (full rescan); after the run the new cursor is saved. Then unset the env so later runs use the normal cursor.

- **Local:** In `.env` add `ODOO_SYNC_RESET_TAX_CURSOR=1`, run sync once, then remove or comment it out.
- **Cloud Run:** Set the env var for the service to `1`, trigger one sync (e.g. hit the sync URL), then set it back to empty or remove it.

Idempotency (marker in target attachments) prevents duplicates.

### Option C: Periodic full rescan (for “same file deleted then uploaded again”)

We can’t detect from Odoo when a file was deleted and re-uploaded in place (same attachment id). To still pick those up, set **ODOO_SYNC_TAX_RESCAN_DAYS=N** (e.g. `1` or `7`). Every N days the worker will do one run with cursor 0 (full rescan), then save the new cursor and the last-rescan date. Re-uploads that reused the same id will be synced on the next rescan. Idempotency avoids duplicates.

### Option B: Edit GCS state file

1. Open your GCS state file (e.g. `gs://odoo-sync-state/odoosync/state.json`).
2. Set **ODOO_SYNC_LAST_ATTACHMENT_ID** to **0** (or remove the key). Keep any other keys (e.g. GC cursors).
3. Save the file. The next sync run will re-scan from the beginning.
