# Why sync works for one project but not another (same source DB)

When the **source database** is the same but sync works for a **test project** and fails for **another project**, the difference is always in how that **target** is configured or what that target Odoo allows. The worker uses the same source and same code; only the target (URL, DB, credentials, company) changes per project.

---

## Why is nothing happening at all?

If the sync runs but **no files appear** on the target (e.g. hdf-energy-holdings-incorporated), work through these in order.

### 1. No routes loaded (`routes: 0`)

The sync only runs for targets that have a **route**. Routes come from the **source** DB:

- At least one **Tax PH** task in stage **Master** (so the project is included).
- A **General** task in that project with **x_studio_enabled** = true, **x_studio_odoo_document_sync** = true, **x_studio_accounting_database** = target URL, **x_studio_email** and **x_studio_api_key** set.

If the project for hdf has no such General task, or sync is disabled, or email/API key/URL is missing, **no route** is created → sync never sends anything to that target.

**What to do:** Run the sync locally and watch the **console** (not only the JSON result). You should see:

- `[routes] Tax PH tasks in stage "Master": N → projectIds: ...`
- `[routes] General tasks found: ...`
- `[routes] project X → ...` (if a project is skipped)
- `[routes] Active routes: N (projectIds: ...)`

If **Active routes: 0** or the hdf project’s ID is not in `projectIds`, fix the **General** task for that project in the source DB.

**Run locally:** From the `worker` folder, set `.env` with `SOURCE_*`, then run `npm run sync`. Watch the console; the JSON will show `routes: 0` if no routes were loaded.

### 2. Routes exist but nothing is processed (all skipped)

An attachment is only synced if the task is in stage **APPROVED / DONE** and the task name matches **Tax PH** or **Gvt contribs Filing** with a period like **[2025]** or **[2025.01]**. Otherwise you get 0 processed and counts in `nSkipStage`, `nSkipNotTaxOrGvt`, etc.

**What to do:** Check `result.tax.metrics`. Move a qualifying task to **APPROVED / DONE** and ensure the name has the bracket period.

### 3. No new attachments in this batch (cursor)

The worker only fetches attachments with **id > lastId**. If there are no new attachments since the last run, the batch is empty and no new files are created.

**What to do:** Add a new attachment in the source, or set `ODOO_SYNC_RESET_TAX_CURSOR=1` for one run to rescan from the start (then unset it).

### 4. Target errors (auth, Documents, permissions)

Errors for a specific target are in **`result.tax.failures`**. Common causes: wrong API key/email, or target has no Documents app / API user has no rights.

**What to do:** Inspect `result.tax.failures` after a run. Log in to the target with the same email/API key and ensure Documents is installed and the user can create documents in that company.

---

## 1. Route not created for the other project

The worker only syncs to targets that appear in **routes**. A route is created only when **in the source DB**:

- The project has at least one **Tax PH** task in stage **Master**.
- The project has a **General** task with:
  - **x_studio_enabled** = true (sync enabled)
  - **x_studio_odoo_document_sync** = true (document sync enabled)
  - **x_studio_accounting_database** = target Odoo URL (e.g. `https://other-project.odoo.com` or `other-project`)
  - **x_studio_email** and **x_studio_api_key** set (target login and API key)

If any of these are missing or wrong for the “other” project in the source, **no route** is built for it, so the sync never runs for that target.

**Check:** Run the sync and look at logs: `[routes] Active routes: N (projectIds: ...)`. Confirm the other project’s ID is in that list.

---

## 2. Target URL / database (x_studio_accounting_database)

The worker derives the target from **x_studio_accounting_database** on the General task (see `parseAcctDb` in `odoo.js`). Supported formats:

- Subdomain only: `other-project` → `https://other-project.odoo.com/`
- Full URL: `https://other-project.odoo.com/`
- JSON: `{"baseUrl":"https://other-project.odoo.com","db":"..."}`

If the value is empty, invalid, or points to the wrong instance, the route is skipped or the worker talks to the wrong Odoo.

**Check:** In the source DB, open the **General** task of the other project and confirm **x_studio_accounting_database** is exactly the target you expect (same subdomain/URL as where you expect files).

---

## 3. Target credentials (API user)

Each target uses **x_studio_email** and **x_studio_api_key** from the General task. The worker authenticates to that target with these.

- **Wrong or expired API key** → auth fails for that target only.
- **Wrong email** → same.
- **User deactivated or no access to that database** → calls to that target fail.

**Check:** Use the same email + API key to log in to the **other** Odoo instance (browser or XML-RPC). If login fails there, sync will fail for that project.

---

## 4. Target company (multi-company)

If **x_studio_multi_company** is true, the worker uses **x_studio_company_id_if_multi_company** as `target_company_id`. All target operations use that company (`force_company` / `allowed_company_ids`).

- If that **company does not exist** on the target DB → errors.
- If the **API user has no access** to that company → errors.

**Check:** On the **other** Odoo instance, ensure the company ID in the General task exists and that the API user can switch to that company and create documents/attachments.

---

## 5. Documents app and rights on the target

The worker assumes the **target** Odoo has:

- **Documents** app installed (model `documents.document` with `type`, `folder_id`, `attachment_id`, etc.).
- **API user** can:
  - Create/read/update/delete `ir.attachment`
  - Create/read/update/delete `documents.document`
  - Create folders (documents with `type='folder'`)

If the other project’s Odoo:

- Does **not** have Documents installed, or
- Restricts the API user so it cannot create documents/attachments in that company,

then sync will fail for that target only.

**Check:** On the **other** instance, install Documents (if needed) and ensure the API user has rights to create documents and attachments in the target company.

---

## 6. Failures are per-target

Sync does not stop the whole run when one target fails. It:

- **Tax sync:** appends to `failures[]` (reason, attachment_id, error message).
- **Onboarding:** logs with `console.warn` and continues.

So “it doesn’t work on the other project” might mean: the job runs, but that target has **failures** (auth, permissions, missing app, etc.). The **test** project might have zero failures.

**Check:** After a run, inspect the returned `failures` (or logs) and look for errors mentioning the other project’s URL/database or company. That will tell you whether the problem is auth, company, or Documents/rights.

---

## Quick comparison checklist (test vs other project)

Use the **same source DB** and compare the **General** task of the **test** project vs the **other** project:

| Item | Test project (works) | Other project (doesn’t work) |
|------|----------------------|-------------------------------|
| Tax PH task in stage Master | ✓ | ? |
| General task exists | ✓ | ? |
| x_studio_enabled = true | ✓ | ? |
| x_studio_odoo_document_sync = true | ✓ | ? |
| x_studio_accounting_database | Correct URL | Same format / correct URL? |
| x_studio_email | Valid | Same user or valid for target? |
| x_studio_api_key | Valid | Same key or valid for target? |
| x_studio_multi_company / company_id | Correct | Company exists on **target**? |

Then on the **target** Odoo instances:

| Item | Test target | Other target |
|------|-------------|--------------|
| Documents app installed | ✓ | ? |
| API user can log in | ✓ | ? |
| API user has access to target company | ✓ | ? |
| API user can create documents/attachments | ✓ | ? |

Fixing the differences on the “other” project (route config in source + app/rights/credentials on that target) is what makes the change effective on that project; the code path is the same for both.
