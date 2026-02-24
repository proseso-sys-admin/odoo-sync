# Odoo Sync Worker — User Guide

This guide explains what the sync worker does, how to set it up, run it, and fix common issues — in plain language.

---

## 1. What does this system do?

The **Odoo Sync Worker** copies files (attachments) from **one** Odoo database (the “source”) to **many** client Odoo databases (the “targets”). You control which projects and which target databases are used by configuring a “Sync” tab on a task in the source Odoo.

- **Tax PH and Gvt contribs sync:** Files attached to tasks named like “Tax PH [2026.01]” or “Gvt contribs Filing [2026.01]” that are in the **Approved / Done** stage are copied into the **Taxes and Statutories** folder (and subfolders by year and type) in each target database. Tax PH uses subfolders such as VAT, Income Tax, etc.; Gvt contribs uses SSS, PHIC, HDMF, SSS Loans, HDMF Loans.
- **Onboarding sync:** Files attached to the **General** task (in specific fields) are copied into the **Onboarding** folder in each target.

The worker can run on your own computer for testing, or in **Google Cloud** so it runs automatically on a schedule (e.g. every 5 minutes).

---

## 2. Main ideas (without jargon)

| Term | Meaning |
|------|--------|
| **Source** | The single Odoo database where you upload files and manage tasks (e.g. your main company Odoo). |
| **Target** | A client Odoo database that should receive copies of certain files. There can be many targets (e.g. 30). |
| **Route** | A link from a **project** in the source to a target: “files from this project go to this target database.” Routes are read from the **General** task’s Sync tab in the source. |
| **Sync** | One “run” of the worker: it looks for new or eligible files in the source and copies them to the right targets. |
| **State / cursor** | The worker remembers how far it has already looked in the source (so it doesn’t re-process the same files every time). This “memory” is stored in a small file in Google Cloud Storage. |
| **Deploy** | Putting the worker code onto Google’s servers (Cloud Run) so it can run in the cloud and be triggered by a schedule or a manual URL call. |
| **Scheduler** | A timer (Cloud Scheduler) that calls the worker’s URL on a schedule (e.g. every 5 minutes) so sync runs automatically. |

---

## 3. What gets synced (Tax PH and Gvt contribs)

Both use the same root folder **Taxes and Statutories** (and the same structure: Year → type/bucket → Month).

**Tax PH**

1. **Task name** must contain **“Tax PH”** and a period in brackets, e.g. `[2026]` or `[2026.01]`.
2. **Task stage** must be **“Approved / Done”** (case doesn’t matter).
3. The task’s **project** must have sync turned on and be linked to a target (via the General task’s Sync tab).
4. The file must be a **new** attachment since the last time the worker advanced its “cursor” (see section 7).

Files end up under **Taxes and Statutories** in folders by year and type (VAT, Expanded Withholding Tax, Income Tax, Others, etc.), depending on which field on the task the file is attached to.

**Gvt contribs Filing**

1. **Task name** must contain **“Gvt contribs Filing”** and a period in brackets, e.g. `[2026]` or `[2026.01]`.
2. Same **stage** (Approved / Done), **project** (sync enabled), and **cursor** rules as Tax PH.

Files end up under **Taxes and Statutories** in folders by year and type: **SSS**, **PHIC**, **HDMF**, **SSS Loans**, **HDMF Loans**, depending on which field on the task the file is attached to (`x_studio_sss_contributions`, `x_studio_philhealth_contributions`, `x_studio_pag_ibig_contributions`, `x_studio_sss_loans`, `x_studio_pag_ibig_loans`).

---

## 4. What gets synced (Onboarding)

Files attached to the **General** task in the source (in the fields used for permanent and temporary onboarding files) are copied to the **Onboarding** folder in each target that has a route from that project.

---

## 5. Setup overview

You need:

1. **Google Cloud project** with billing (for Cloud Run, Storage, Scheduler).
2. **Node.js 20+** and **Google Cloud SDK (gcloud)** if you run or deploy from your PC.
3. **Credentials** for the source Odoo (URL, database name, login, password or API key).
4. A **bucket** in Google Cloud Storage where the worker stores its state file (one small JSON file).
5. **Permissions** so the Cloud Run service can read/write that bucket and (if you use it) read secrets.

Detailed step-by-step is in [SETUP-GCP.md](../SETUP-GCP.md). The short version:

- Create a GCS bucket and a path for the state file (e.g. `odoosync/state.json`).
- Store source credentials either in **Secret Manager** (recommended) or in environment variables.
- Deploy the worker to **Cloud Run** with the right environment variables (and secrets).
- Optionally create a **Cloud Scheduler** job that calls the worker’s `/sync` URL every 5 minutes.

---

## 6. Configuration (environment variables)

These are the main settings the worker uses. You can set them in a `.env` file when running locally, or in Cloud Run (and/or Secret Manager) when running in the cloud.

**Required**

- **SOURCE_BASE_URL** — Full URL of the source Odoo (e.g. `https://your-company.odoo.com`).
- **SOURCE_DB** — Source database name.
- **SOURCE_LOGIN** — Login (e.g. email) for the source.
- **SOURCE_PASSWORD** — API key or password for the source.
- **STATE_GCS_BUCKET** — Name of the GCS bucket for state (no `gs://`).
- **STATE_GCS_PATH** — Path to the state file inside the bucket (e.g. `odoosync/state.json`).

**Optional**

- **MAX_CONCURRENT_TARGETS** — How many target databases to process at the same time (default 10). Can increase (e.g. 30) if you have many targets.
- **ATTACHMENT_BATCH_LIMIT** — Max attachments to process per sync run (default 200).
- **ODOO_SYNC_RESET_TAX_CURSOR** — Set to `1` or `true` for **one** run to force a full rescan from the beginning (see section 7). Remove or unset after that run.
- **ODOO_SYNC_TAX_RESCAN_DAYS** — If set (e.g. `1` or `7`), the worker will do a full rescan every N days so that “re-uploaded” files (same file deleted then uploaded again) are picked up. No need to remove this; it runs in the background.

See `.env.example` in the worker folder for a template.

---

## 7. Why didn’t my file sync? (cursor and rescan)

The worker does **not** re-scan every file in the source on every run. It only looks at attachments **newer** than the last one it already saw (using an internal “cursor” stored in the state file). So:

- If a file was uploaded **before** the task was moved to Approved/Done (or before the task name had “Tax PH” and the period), the worker may have already “passed” that file and will never look at it again unless you reset or rescan.
- If you **delete** a file and **re-upload** it and Odoo keeps the same internal ID, the worker has already passed that ID, so it won’t sync again until a full rescan.

**Ways to fix it:**

1. **One-time reset (recommended when something is missing)**  
   - **Locally:** In `.env` add `ODOO_SYNC_RESET_TAX_CURSOR=1`, run sync once (`npm run sync` or call `/sync`), then remove that line.  
   - **Cloud Run:** Set the same variable on the service, trigger one sync (open the sync URL or run the scheduler once), then remove the variable from the service.

2. **Periodic full rescan (for re-uploads)**  
   Set `ODOO_SYNC_TAX_RESCAN_DAYS=1` (or another number). Every N days the worker will do one full rescan so re-uploaded files are picked up. Duplicates are avoided because the worker matches files by a unique marker.

3. **Edit the state file in GCS**  
   Open the state file (e.g. in Cloud Console), set `ODOO_SYNC_LAST_ATTACHMENT_ID` to `0`, save. The next sync will rescan from the start. Keep any other keys in the file (e.g. for cleanup) as they are.

More detail on which fields the worker checks is in [TAX-SYNC-FIELDS.md](TAX-SYNC-FIELDS.md).

---

## 8. Same file in multiple fields — why only one copy?

If you attach the **same file** to several tax fields (e.g. VAT, Withholding Tax, etc.) on the same task, Odoo often stores it as **one** attachment that is linked from all those fields. The worker sees **one** attachment and syncs it **once** into **one** folder (the first bucket it associates with that attachment). So you get one copy in the target, not one per field.

If you need one copy per category, you have to upload the file separately to each field (so Odoo creates separate attachments); then the worker will sync each attachment once.

---

## 9. Running the worker

**On your computer (one run):**

```powershell
cd path\to\worker
npm run sync
```

**On your computer (server; then trigger sync in browser or another terminal):**

```powershell
npm start
# Then open http://localhost:8080/sync or run:
Invoke-WebRequest -Uri "http://localhost:8080/sync" -Method GET -UseBasicParsing
```

**In the cloud (after deploy):**  
Open the Cloud Run URL in a browser or call it with PowerShell:

```powershell
# Get your real URL first:
$URL = gcloud run services describe odoo-sync-worker --region=asia-southeast1 --format="value(status.url)"
Invoke-WebRequest -Uri "$URL/sync" -Method GET -UseBasicParsing
```

**Scheduler:**  
If you created a Cloud Scheduler job, it will call that URL automatically (e.g. every 5 minutes). You can also run the job once by hand:

```powershell
gcloud scheduler jobs run odoo-sync-every-5min --location=asia-southeast1
```

---

## 10. Deploying (what it means and how)

**Deploying the worker** means: building your code into a container image, uploading it to Google, and creating or updating a **Cloud Run service** so that when someone (or the scheduler) calls the service URL, Google runs your sync code.

**Deploying the scheduler** means: creating a **Cloud Scheduler job** that, on a schedule, sends an HTTP request to your Cloud Run URL (e.g. `https://odoo-sync-worker-njiacix2yq-as.a.run.app/sync`). No extra container; it’s just a timer that hits your already-deployed worker.

**Full redeploy (worker) — when source credentials are in Secret Manager:**

```powershell
cd path\to\worker
$REGION = "asia-southeast1"
$SERVICE_NAME = "odoo-sync-worker"
$BUCKET = "odoo-sync-state"

gcloud run deploy $SERVICE_NAME `
  --source=. `
  --region=$REGION `
  --allow-unauthenticated `
  --set-env-vars="STATE_GCS_BUCKET=$BUCKET,STATE_GCS_PATH=odoosync/state.json,MAX_CONCURRENT_TARGETS=30,ATTACHMENT_BATCH_LIMIT=200,ODOO_SYNC_TAX_RESCAN_DAYS=1" `
  --set-secrets="SOURCE_BASE_URL=SOURCE_BASE_URL:latest,SOURCE_DB=SOURCE_DB:latest,SOURCE_LOGIN=SOURCE_LOGIN:latest,SOURCE_PASSWORD=SOURCE_PASSWORD:latest"
```

Replace `path\to\worker` and `$BUCKET` with your values. If you previously set SOURCE_* as **secrets**, keep using `--set-secrets` for them; do not switch them to plain env vars in the same deploy or you’ll get an error.

**Add or fix state variables only (no code change):**

```powershell
gcloud run services update odoo-sync-worker --region=asia-southeast1 --set-env-vars="STATE_GCS_BUCKET=your-bucket,STATE_GCS_PATH=odoosync/state.json"
```

**Create the scheduler (e.g. every 5 minutes):**

```powershell
$REGION = "asia-southeast1"
$SERVICE_URL = "https://odoo-sync-worker-njiacix2yq-as.a.run.app"
$JOB_NAME = "odoo-sync-every-5min"

gcloud scheduler jobs create http $JOB_NAME `
  --location=$REGION `
  --schedule="*/5 * * * *" `
  --uri="$SERVICE_URL/sync" `
  --http-method=GET `
  --attempt-deadline=600s
```

Use `600s` (with the “s”), not `600`, for the deadline.

---

## 11. Logs and alerts

**Where to see what happened**

- **Cloud Run logs:** In Google Cloud Console go to **Cloud Run** → your service → **Logs**. You see each request and any errors.
- **Scheduler runs:** **Cloud Scheduler** → your job → **Job runs** shows whether each scheduled run succeeded or failed.

**Getting alerted when something goes wrong**

- In **Cloud Monitoring** (Console → Monitoring → Alerting), create an **alerting policy** that fires when:
  - Cloud Run requests fail (e.g. 5xx errors), or
  - Cloud Scheduler job runs fail.
- Add a **notification** (e.g. email) to that policy so you get an email when the condition is met.

That way you have one place to see logs and one place to get notified of failures.

---

## 12. Cost (rough idea)

For a setup with about **30 target databases** and **20 new files per database per month** (600 files/month), running sync every 5 minutes:

- **Cloud Run:** A few dollars to around $15/month (depends on how long each run takes and how much memory/CPU you use).
- **Egress:** Usually small (first 1 GB free; then a few dollars if you send a lot of data to the targets).
- **Cloud Storage and Secret Manager:** Typically under $1/month.
- **Cloud Scheduler:** About $0.10 per job per month.

A reasonable total is **about $5–20 per month**, with **$10–15** as a typical middle. Cost goes up if you run more often or sync much larger files or more targets.

---

## 13. Troubleshooting

| Problem | What to check / do |
|--------|--------------------|
| Sync returns “STATE_GCS_BUCKET and STATE_GCS_PATH must be set” | Set those two environment variables on the Cloud Run service (see section 10). |
| Sync returns 200 but “nAttIds: 0” and nothing syncs | The cursor is already past your attachments. Do a one-time cursor reset (section 7) or wait for the next periodic rescan if you have ODOO_SYNC_TAX_RESCAN_DAYS set. |
| “Cannot update environment variable [X] to string literal because it has already been set with a different type” | That variable is set as a **secret**. Keep using `--set-secrets` for it; don’t switch it to `--set-env-vars` in the same deploy. |
| Scheduler creation fails with “Duration must end with time part character” | Use `--attempt-deadline=600s` (with **s**), not `600`. |
| Same file in all tax fields but only one copy in target | The worker syncs one attachment once. If Odoo stored one attachment for all fields, you get one copy. Upload separately to each field if you need one copy per category. |
| I want to run sync by hand in the cloud | Use the Cloud Run URL: `Invoke-WebRequest -Uri "https://odoo-sync-worker-njiacix2yq-as.a.run.app/sync" -Method GET -UseBasicParsing`, or run the scheduler job once (section 9). |

---

## 14. Quick reference

**Get Cloud Run URL**

```powershell
gcloud run services describe odoo-sync-worker --region=asia-southeast1 --format="value(status.url)"
```

**Trigger sync once (cloud)**

```powershell
Invoke-WebRequest -Uri "https://odoo-sync-worker-njiacix2yq-as.a.run.app/sync" -Method GET -UseBasicParsing
```

**One-time cursor reset (cloud)** — then trigger sync once, then remove the variable

```powershell
gcloud run services update odoo-sync-worker --region=asia-southeast1 --set-env-vars="ODOO_SYNC_RESET_TAX_CURSOR=1"
# ... trigger sync ...
gcloud run services update odoo-sync-worker --region=asia-southeast1 --remove-env-vars="ODOO_SYNC_RESET_TAX_CURSOR"
```

**Scheduler: run now, pause, resume, list**

```powershell
gcloud scheduler jobs run odoo-sync-every-5min --location=asia-southeast1
gcloud scheduler jobs pause odoo-sync-every-5min --location=asia-southeast1
gcloud scheduler jobs resume odoo-sync-every-5min --location=asia-southeast1
gcloud scheduler jobs list --location=asia-southeast1
```

**Recent logs (worker)**

```powershell
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="odoo-sync-worker"' --limit=50 --format="table(timestamp,severity,textPayload)" --freshness=1d
```

---

## 12. Detailed step-by-step: Odoo automation to trigger the worker (webhook or full sync)

Follow these steps in your **source** Odoo database. You can either trigger **full sync** (all targets) or **single-target sync** (only the target for the attachment’s project).

### Before you start

- Worker URL for this project: `https://odoo-sync-worker-njiacix2yq-as.a.run.app` (or run `gcloud run services describe odoo-sync-worker --region=asia-southeast1 --format="value(status.url)"` to get it).
- (Optional) If you use a webhook secret, know the value you set as `WEBHOOK_SECRET` on the worker.

### Making delete work when using task-based webhook (project.task)

If you use **Send Webhook Notification** on **project.task** (On create and edit) only, the worker never receives the **deleted** attachment id (the attachment is already unlinked from the task), so it cannot remove that file from the target. To get **instant delete** on webhook:

1. Add a **second** automated action in Odoo:
   - **Model:** Attachment (`ir.attachment`)
   - **Trigger:** **On delete**
   - **Domain:** `[('res_model', '=', 'project.task')]` (optional, so only task attachments trigger)
   - **Action:** **Send Webhook Notification**
   - **URL:** your worker webhook URL (e.g. `https://.../webhook`)
   - **Body:** must include the deleted record id and action. Depending on your Odoo version, the webhook may send `_model`, `_id` and optionally `action`. If you can set the body manually, send e.g. `{"_model": "ir.attachment", "_id": <record id>, "action": "unlink"}`. The worker accepts the attachment id in `_id`, `id`, or `record_id`.

2. If your automation uses **Execute Python Code** instead of Send Webhook Notification, when the trigger is **On delete**, include in the payload `attachment_id`: `record.id` and `action`: `"unlink"`, so the worker runs the delete path.

---

### Step 1: Open Automation

1. Log in to the **source** Odoo (where tasks and attachments live).
2. Go to **Settings** (gear icon).
3. At the bottom, under **Technical**, click **Automation** → **Automated Actions**.
   - If you don’t see **Technical**, enable **Developer Mode**: Settings → **Activate the developer mode**.
4. Click **Create**.

---

### Step 2: Basic settings

1. **Action Name**  
   Example: `Notify Odoo Sync Worker on attachment change`.

2. **Model**  
   Open the dropdown and choose **Attachment** (technical name: `ir.attachment`).  
   This makes the automation run when attachments are created, updated, or deleted.

3. **When to Run (Trigger)**  
   Choose when the worker should be called. Options depend on your Odoo version:
   - **Odoo 17 / 19:** Trigger is often a single dropdown, e.g. **"On create and edit"** (covers new uploads and changes). If you also need runs when an attachment is **deleted**, check if there is an option like "On create, update and delete" or create a **second** automation rule with trigger "On delete" and the same Actions.
   - **Odoo (older):** You may be able to tick multiple (On Create, On Update, On Delete). If so, tick the ones you need.
   - **Minimum:** Use at least **"On create and edit"** so uploads and changes trigger the worker.

4. **Apply on**  
   Leave **Record set** (default).

5. **Domain Filter (optional but recommended)**  
   So only **task** attachments trigger the automation, set:
   ```text
   [('res_model', '=', 'project.task')]
   ```  
   Leave empty if you want any attachment (any model) to trigger.

---

### Step 3: Action type and code

1. **Action To Do**  
   Select **Execute Python Code**.

2. In the **Python Code** box, paste **one** of the two options below.

---

### Option A: Full sync (all targets) on any attachment change

Use this if you want: “whenever an attachment changes, run sync for **all** target databases.”

- **Worker URL:** `https://odoo-sync-worker-njiacix2yq-as.a.run.app/webhook`
- **Body:** empty `{}`. The worker then runs full sync.
- **Secret (optional):** If you set `WEBHOOK_SECRET` on the worker, add the header below and use the same value.

**Python code for Option A:**

```python
import json
import urllib.request

worker_url = "https://odoo-sync-worker-njiacix2yq-as.a.run.app/webhook"
payload = {}
headers = {"Content-Type": "application/json"}
# If you set WEBHOOK_SECRET on the worker, uncomment and set the same value:
# headers["X-Webhook-Secret"] = "your-secret-here"

req = urllib.request.Request(worker_url, data=json.dumps(payload).encode(), headers=headers, method="POST")
try:
    urllib.request.urlopen(req, timeout=60)
except Exception as e:
    import logging
    logging.getLogger(__name__).warning("Odoo sync webhook failed: %s", e)
```

---

### Option B: Single-target sync (only the target for this attachment’s project)

Use this if you want: “when an attachment changes, run sync **only** for the target database linked to that attachment’s project” (via the project’s General task Sync tab).

- **Worker URL:** same as above, `.../webhook`.
- **Body:** the worker expects either `target_key` or the four fields below. This code reads the **General** task for the attachment’s project and sends those four fields so only that target is synced.
- **Secret (optional):** same as Option A.

**Python code for Option B:**

```python
import json
import urllib.request

# Only for task attachments; otherwise do nothing
if record.res_model == 'project.task' and record.res_id:
  task = env['project.task'].browse(record.res_id)
  if task and task.project_id:
    project_id = task.project_id.id
    general = env['project.task'].search([
        ('project_id', '=', project_id),
        ('name', '=', 'General')
    ], limit=1)
    if general and general.x_studio_enabled and str(general.x_studio_enabled).lower() == 'true':
      raw_acct = general.x_studio_accounting_database
      target_base_url = ''
      target_db = ''
      if raw_acct:
        s = str(raw_acct).strip()
        if s.startswith('{') and s.endswith('}'):
          try:
            o = json.loads(s)
            target_base_url = (o.get('baseUrl') or o.get('target_base_url') or '').strip()
            target_db = (o.get('db') or o.get('target_db') or '').strip()
            if target_base_url and not target_db:
              target_db = target_base_url.split('/')[-1].split('.')[0] or target_base_url.replace('https://', '').replace('http://', '').split('.')[0]
          except Exception:
            pass
        if not target_base_url and s.startswith('http'):
          target_base_url = s.rstrip('/')
          target_db = s.replace('https://', '').replace('http://', '').split('.')[0].split('/')[0]
      target_login = (general.x_studio_email or '').strip()
      if target_base_url and target_db and target_login:
        multi = general.x_studio_multi_company and str(general.x_studio_multi_company).lower() == 'true'
        target_company_id = int(general.x_studio_company_id_if_multi_company or 1) if multi else 1
        worker_url = "https://odoo-sync-worker-njiacix2yq-as.a.run.app/webhook"
        payload = {
            "target_base_url": target_base_url,
            "target_db": target_db,
            "target_login": target_login,
            "target_company_id": target_company_id,
        }
        headers = {"Content-Type": "application/json"}
        # If you set WEBHOOK_SECRET on the worker, uncomment and set the same value:
        # headers["X-Webhook-Secret"] = "your-secret-here"
        req = urllib.request.Request(worker_url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            urllib.request.urlopen(req, timeout=60)
        except Exception as e:
            import logging
            logging.getLogger(__name__).warning("Odoo sync webhook failed: %s", e)
```

---

### Step 4: Replace placeholders and save

1. In the code you chose (A or B), replace:
   - The worker URL is already set in the code above (`https://odoo-sync-worker-njiacix2yq-as.a.run.app`). If you use a different project/region, run `gcloud run services describe odoo-sync-worker --region=asia-southeast1 --format="value(status.url)"` and replace it.
2. If you use a webhook secret:
   - Uncomment the two lines that set `X-Webhook-Secret` and set `"your-secret-here"` to the same value as `WEBHOOK_SECRET` on the worker.
3. Click **Save**.

---

### Step 5: Test

1. **Option A:** Upload or delete any attachment (or one on a task if you used the domain filter). Check worker logs or the target DBs to see that a full sync ran.
2. **Option B:** Upload or delete an attachment on a **task** in a project that has a **General** task with sync enabled and target configured. Check that only that project’s target database was synced (worker logs or target DB).

---

### Summary

| What you want                         | Use    | Result                                      |
|--------------------------------------|--------|---------------------------------------------|
| Any attachment change → sync all DBs | Option A | One automation, empty body → full sync.     |
| Attachment change → sync that project’s target only | Option B | One automation, body with target → single-target sync. |

The **scheduler** (e.g. every 5 minutes) is independent: it still calls `/sync` with no params and runs full sync. The automation only adds extra triggers (webhook) when attachments change.

---

## 13. One automation in Odoo: sync only the target for the changed attachment

You can use **one** automated action on the **source** Odoo so that when an attachment is created, updated, or deleted, the worker runs sync **only for the target** linked to that attachment’s project (not for all targets).

**How it works:** Attachment → task → project → **General** task for that project → read target (URL, db, login, company) from the General task’s Sync tab → POST that single target to the worker’s `/webhook`. The worker then runs sync only for that target.

**Steps in Odoo**

1. **Settings → Technical → Automation → Automated Actions → Create**
2. **Model:** `Attachment (ir.attachment)`
3. **Trigger:** e.g. “On Create”, “On Update”, “On Delete” (as needed)
4. **Apply on:** Record set
5. **Domain (optional):** `[('res_model', '=', 'project.task')]` so only task attachments trigger
6. **Action To Do:** Execute Python Code

**Python code** (replace `WORKER_URL` and optionally `WEBHOOK_SECRET`):

```python
import json
import urllib.request

# Only for task attachments; otherwise do nothing
if record.res_model == 'project.task' and record.res_id:
  task = env['project.task'].browse(record.res_id)
  if task and task.project_id:
    project_id = task.project_id.id
    general = env['project.task'].search([
        ('project_id', '=', project_id),
        ('name', '=', 'General')
    ], limit=1)
    if general and general.x_studio_enabled and str(general.x_studio_enabled).lower() == 'true':
      # Target from General task (same fields the worker uses)
      raw_acct = general.x_studio_accounting_database
      target_base_url = ''
      target_db = ''
      if raw_acct:
        s = str(raw_acct).strip()
        if s.startswith('{') and s.endswith('}'):
          try:
            o = json.loads(s)
            target_base_url = (o.get('baseUrl') or o.get('target_base_url') or '').strip()
            target_db = (o.get('db') or o.get('target_db') or '').strip()
            if target_base_url and not target_db:
              target_db = target_base_url.split('/')[-1].split('.')[0] or target_base_url.replace('https://', '').replace('http://', '').split('.')[0]
          except Exception:
            pass
        if not target_base_url and s.startswith('http'):
          target_base_url = s.rstrip('/')
          target_db = s.replace('https://', '').replace('http://', '').split('.')[0].split('/')[0]
      target_login = (general.x_studio_email or '').strip()
      if target_base_url and target_db and target_login:
        multi = general.x_studio_multi_company and str(general.x_studio_multi_company).lower() == 'true'
        target_company_id = int(general.x_studio_company_id_if_multi_company or 1) if multi else 1
        worker_url = "https://odoo-sync-worker-njiacix2yq-as.a.run.app/webhook"
        payload = {
            "target_base_url": target_base_url,
            "target_db": target_db,
            "target_login": target_login,
            "target_company_id": target_company_id,
        }
        headers = {"Content-Type": "application/json"}
        # If you set WEBHOOK_SECRET on the worker, set the same value here (e.g. in a config or env)
        # secret = env['ir.config_parameter'].sudo().get_param('odoo_sync.webhook_secret') or ''
        # if secret:
        #     headers["X-Webhook-Secret"] = secret
        req = urllib.request.Request(worker_url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            urllib.request.urlopen(req, timeout=30)
        except Exception as e:
            import logging
            _logger = logging.getLogger(__name__)
            _logger.warning("Odoo sync webhook call failed: %s", e)
```

Result: **one** automation; each attachment change triggers the worker **once** with the **one** target for that attachment’s project, so only that database is synced.

---

For step-by-step GCP setup (APIs, bucket, permissions, deploy, scheduler), see [SETUP-GCP.md](../SETUP-GCP.md).  
For which exact fields the Tax PH sync uses and why a task might not sync, see [TAX-SYNC-FIELDS.md](TAX-SYNC-FIELDS.md).
