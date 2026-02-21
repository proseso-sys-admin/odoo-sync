# Google Cloud setup for Odoo Sync Worker

PowerShell steps to create the project, bucket, deploy the worker, and schedule it.

---

## 1. Prerequisites

- **Google Cloud SDK (gcloud)**  
  Install: <https://cloud.google.com/sdk/docs/install>  
  Or with winget: `winget install Google.CloudSDK`

- **Node.js 20+**  
  `node --version`

- **Docker** (for building the Cloud Run image; or use Cloud Build)

```powershell
# Login and set default project
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

---

## 2. Create or select project and enable APIs

```powershell
# Create a new project (or skip and use existing)
$PROJECT_ID = "odoo-sync-prod"
gcloud projects create $PROJECT_ID --name="Odoo Sync"
gcloud config set project $PROJECT_ID

# Enable required APIs
gcloud services enable run.googleapis.com
gcloud services enable cloudscheduler.googleapis.com
gcloud services enable storage.googleapis.com
gcloud services enable secretmanager.googleapis.com
gcloud services enable artifactregistry.googleapis.com
```

---

## 3. Create Cloud Storage bucket for sync state

```powershell
$BUCKET = "odoo-sync-state"
$REGION = "asia-southeast1"

# Create bucket (same region as Cloud Run is best)
gcloud storage buckets create "gs://$BUCKET" --location=$REGION

# Optional: create the initial empty state file so the worker can overwrite it
echo '{}' | gcloud storage cp - "gs://$BUCKET/odoosync/state.json"
```

Note the bucket name (no `gs://`) and path for env: `STATE_GCS_BUCKET=$BUCKET`, `STATE_GCS_PATH=odoosync/state.json`.

---

## 4. (Optional) Store source Odoo credentials in Secret Manager

```powershell
# Create secrets so you don't put credentials in env
echo -n "https://your-source.odoo.com" | gcloud secrets create SOURCE_BASE_URL --data-file=-
echo -n "your-db-name" | gcloud secrets create SOURCE_DB --data-file=-
echo -n "admin@example.com" | gcloud secrets create SOURCE_LOGIN --data-file=-
echo -n "your-api-key-or-password" | gcloud secrets create SOURCE_PASSWORD --data-file=-
```

If you skip this, you will pass these as environment variables when deploying Cloud Run (step 6).

---

## 5. Grant the Cloud Run service account access to bucket and secrets

```powershell
$PROJECT_ID = gcloud config get-value project
$PROJECT_NUMBER = (gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
$SA_EMAIL = "${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

# Storage: read/write state file
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/storage.objectAdmin"

# If using Secret Manager: allow Cloud Run to read secrets
gcloud secrets add-iam-policy-binding SOURCE_BASE_URL `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding SOURCE_DB `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding SOURCE_LOGIN `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding SOURCE_PASSWORD `
  --member="serviceAccount:$SA_EMAIL" `
  --role="roles/secretmanager.secretAccessor"
```

---

## 6. Build and deploy to Cloud Run

**Option A: Deploy from source (Cloud Build)**

```powershell
cd "C:\Users\josep\OneDrive\Desktop\Odoo Sync\worker"

$REGION = "asia-southeast1"
$SERVICE_NAME = "odoo-sync-worker"

gcloud run deploy $SERVICE_NAME `
  --source=. `
  --region=$REGION `
  --allow-unauthenticated `
  --set-env-vars="STATE_GCS_BUCKET=$BUCKET,STATE_GCS_PATH=odoosync/state.json" `
  --set-env-vars="SOURCE_BASE_URL=https://your-source.odoo.com,SOURCE_DB=your-db,SOURCE_LOGIN=your-login" `
  --set-secrets="SOURCE_PASSWORD=SOURCE_PASSWORD:latest"
```

If you store **all** source vars in secrets:

```powershell
gcloud run deploy $SERVICE_NAME `
  --source=. `
  --region=$REGION `
  --allow-unauthenticated `
  --set-env-vars="STATE_GCS_BUCKET=$BUCKET,STATE_GCS_PATH=odoosync/state.json" `
  --set-secrets="SOURCE_BASE_URL=SOURCE_BASE_URL:latest,SOURCE_DB=SOURCE_DB:latest,SOURCE_LOGIN=SOURCE_LOGIN:latest,SOURCE_PASSWORD=SOURCE_PASSWORD:latest"
```

**Option B: Build with Docker and push to Artifact Registry, then deploy**

```powershell
$REGION = "asia-southeast1"
$PROJECT_ID = gcloud config get-value project
$REPO = "odoo-sync"
$IMAGE = "${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/worker:latest"

# Create Artifact Registry repo
gcloud artifacts repositories create $REPO --repository-format=docker --location=$REGION

# Build and push (Docker must be running)
docker build -t $IMAGE .
docker push $IMAGE

# Deploy
gcloud run deploy odoo-sync-worker `
  --image=$IMAGE `
  --region=$REGION `
  --allow-unauthenticated `
  --set-env-vars="STATE_GCS_BUCKET=$BUCKET,STATE_GCS_PATH=odoosync/state.json,SOURCE_BASE_URL=https://...,SOURCE_DB=...,SOURCE_LOGIN=...,SOURCE_PASSWORD=..."
```

After deploy, note the **service URL** (e.g. `https://odoo-sync-worker-xxxxx-uc.a.run.app`).

---

## 7. Create Cloud Scheduler job (every 5 minutes)

```powershell
$REGION = "asia-southeast1"
$SERVICE_URL = "https://YOUR_SERVICE_URL.run.app"   # from step 6
$JOB_NAME = "odoo-sync-every-5min"

gcloud scheduler jobs create http $JOB_NAME `
  --location=$REGION `
  --schedule="*/5 * * * *" `
  --uri="$SERVICE_URL/sync" `
  --http-method=GET `
  --attempt-deadline=600
```

If the service requires authentication (you removed `--allow-unauthenticated`):

```powershell
gcloud scheduler jobs create http $JOB_NAME `
  --location=$REGION `
  --schedule="*/5 * * * *" `
  --uri="$SERVICE_URL/sync" `
  --http-method=GET `
  --oidc-service-account-email="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" `
  --attempt-deadline=600
```

---

## 8. Verify

```powershell
# Trigger a run manually
Invoke-WebRequest -Uri "$SERVICE_URL/sync" -Method GET -UseBasicParsing

# Check state file in GCS
gcloud storage cat "gs://$BUCKET/odoosync/state.json"

# View logs
gcloud run services logs read odoo-sync-worker --region=$REGION --limit=50
```

---

## Summary: env / config

| Env / Secret | Description |
|--------------|-------------|
| `SOURCE_BASE_URL` | Source Odoo URL (e.g. https://your.odoo.com) |
| `SOURCE_DB` | Source DB name |
| `SOURCE_LOGIN` | Source login (email) |
| `SOURCE_PASSWORD` | Source API key or password |
| `STATE_GCS_BUCKET` | GCS bucket name (no gs://) |
| `STATE_GCS_PATH` | Path to state JSON (e.g. odoosync/state.json) |
| `PORT` | Set by Cloud Run (8080) |

Optional: `ATTACHMENT_BATCH_LIMIT`, `MAX_CONCURRENT_TARGETS` (see `.env.example`).
