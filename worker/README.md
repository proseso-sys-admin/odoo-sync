# Odoo Sync Worker (GCP)

Node.js worker that syncs project.task attachments from a **source** Odoo database to **target** client Odoo databases.

**Detailed, non-technical guide:** [docs/USER-GUIDE.md](docs/USER-GUIDE.md) — what it does, setup, running, rescan, logs, cost, troubleshooting.

- **Tax PH and Gvt contribs sync**: Attachments on tasks in stage "Approved / Done" with "Tax PH" or "Gvt contribs Filing" + period in name (e.g. `[2026.01]`) → target **Taxes and Statutories** folder (Year / Bucket / Month). Tax PH buckets: VAT, EWT, WTC, ITR, Others. Gvt contribs buckets: SSS, PHIC, HDMF, SSS Loans, HDMF Loans.
- **Onboarding sync**: Attachments on the General task (`x_studio_permanent_files`, `x_studio_temporary_files`) → target **Onboarding** folder.

Routing is read from the source Odoo **General** task (Sync tab): `x_studio_enabled`, `x_studio_email`, `x_studio_api_key`, `x_studio_multi_company`, `x_studio_company_id_if_multi_company`, `x_studio_accounting_database`.

## Setup

1. **Env (or Secret Manager)**  
   Copy `.env.example` and set:
   - `SOURCE_BASE_URL`, `SOURCE_DB`, `SOURCE_LOGIN`, `SOURCE_PASSWORD`
   - `STATE_GCS_BUCKET`, `STATE_GCS_PATH` (for sync state in GCS)

2. **Cloud Storage**  
   Create a GCS bucket (or use an existing one). Set `STATE_GCS_BUCKET` (bucket name, no `gs://`) and `STATE_GCS_PATH` (e.g. `odoosync/state.json`). The worker stores the main cursor and per-target GC cursors in this single JSON file. Ensure the Cloud Run service account has Storage Object Admin (or read/write) on that bucket.

3. **Install**  
   `npm install`

## Run locally

1. **Env**  
   Copy `.env.example` to `.env` and set `SOURCE_*` and `STATE_GCS_*`. (Or set the same variables in your shell.)

2. **GCS auth (needed for state)**  
   So the worker can read/write the state file in Cloud Storage:
   ```powershell
   gcloud auth application-default login
   ```

3. **Run the worker** (pick one):

   - **One-shot (recommended for local test)** — runs sync once and prints the result:
     ```powershell
     npm run sync
     ```
   - **HTTP server** — start the server, then call the sync endpoint:
     ```powershell
     npm start
     ```
     In another terminal:
     ```powershell
     Invoke-WebRequest -Uri "http://localhost:8080/sync" -Method GET -UseBasicParsing
     ```
     Or open `http://localhost:8080/sync` in a browser. GET or POST to `/` or `/sync` runs one full sync.

## Run (summary)

| How | Command | Use |
|-----|---------|-----|
| **CLI one-shot** | `npm run sync` | Local test, Cloud Run Job |
| **HTTP server** | `npm start` then GET/POST `/sync` | Local server, Cloud Run Service |

## Deploy (Cloud Run)

- **From GitHub (recommended):** Connect the repo to Cloud Build; push to `main` (or run the trigger) to build and deploy. See [SETUP-GCP.md](SETUP-GCP.md) §6 Option C.
- **From your machine:** `docker build -t odoo-sync-worker .` then push to Artifact Registry and deploy, or use `gcloud run deploy --source=.` (see SETUP-GCP.md §6 Option A/B).

## Parallelism

- Tax PH and Onboarding run **in parallel**.
- Within each flow, target databases are processed **in parallel** (cap: `MAX_CONCURRENT_TARGETS`, default 10).

Trigger Run Manually
gcloud scheduler jobs run $JOB_NAME --location=$REGION

gcloud scheduler jobs create http $JOB_NAME `
  --location=$REGION `
  --schedule="*/5 * * * *" `
  --uri="$SERVICE_URL/sync" `
  --http-method=GET `
  --attempt-deadline=600s `
  --oidc-service-account-email=YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com

  # List jobs
gcloud scheduler jobs list --location=$REGION

# Pause
gcloud scheduler jobs pause $JOB_NAME --location=$REGION

# Resume
gcloud scheduler jobs resume $JOB_NAME --location=$REGION

# Delete
gcloud scheduler jobs delete $JOB_NAME --location=$REGION

# Manual
gcloud scheduler jobs run $JOB_NAME --location=$REGION
