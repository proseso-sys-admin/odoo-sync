# Odoo Agent Service — Design Spec

**Date:** 2026-03-19
**Project:** Odoo-Agent
**Status:** Approved

---

## Overview

An external webhook-based agent service deployed on **Google Cloud Run** that powers multiple AI agents inside **Odoo 19 Online Discuss**. Since Odoo Online (SaaS) does not support custom Python modules, the service runs externally and communicates with Odoo via XML-RPC.

Each agent appears in Odoo Discuss as a named bot with its own avatar. Users send messages in the agent's dedicated channel and receive AI-generated replies that can read and act on live Odoo data.

---

## Constraints

- **Odoo Online (SaaS)** — no custom Python modules, no Odoo.sh
- **No extra user licenses** — agents use `res.partner` records, not full Odoo user accounts
- **One service, multiple agents** — a single Cloud Run deployment hosts all agents
- **Works within existing infrastructure** — reuses Cloud Run, Cloud Build, and the existing Google Drive MCP server patterns

---

## Architecture

```
User types in Odoo Discuss (agent channel)
        ↓
Odoo Automated Action — webhook on mail.message create
        ↓
Cloud Run Agent Service
  ├── Read agent config from ai.agent (system prompt, model name)
  ├── Fetch conversation history from mail.message
  ├── Call Gemini API with tools + history
  │     └── Gemini calls Odoo tools as needed (function calling loop)
  └── Post reply to Odoo Discuss as agent partner
```

**Runtime dependencies:**

| Dependency | Purpose |
|---|---|
| Odoo XML-RPC | Read/write all Odoo data, post replies, fetch history |
| Google Gemini API | LLM + function calling |
| Google Drive MCP server (optional) | Charts, Google Sheets, Drive file creation |

---

## Components

### Cloud Run Agent Service (Python)

```
agent-service/
├── main.py           # FastAPI app — POST /webhook endpoint
├── agent.py          # Core orchestration — debounce, history, Gemini loop, post reply
├── odoo.py           # Odoo XML-RPC client
├── gemini.py         # Gemini API client + function calling setup
├── tools/
│   ├── odoo_tools.py     # All 35 Odoo Connect tools re-implemented as XML-RPC calls
│   └── output_tools.py   # create_chart, create_excel, create_google_sheet, attach_file
├── config.py         # Env vars loader
└── Dockerfile / cloudbuild.yaml
```

### Odoo Setup (one-time configuration)

| Item | Detail |
|---|---|
| Service API credentials | Existing `joseph@proseso-consulting.com` or dedicated API key |
| `res.partner` per agent | Name + avatar — appears in Discuss as the bot |
| Discuss channel per agent | One private channel per agent |
| Automated Action | Webhook on `mail.message` create, filtered per agent channel |
| `ai.agent` record | Stores agent name, system prompt (with model prefix), description |

### Agent Configuration (stored in Odoo)

Model and behavior are configured per agent via the `system_prompt` field of the `ai.agent` record:

```
[MODEL: gemini-3.1-pro]

You are a helpful finance assistant for Proseso Ventures.
You have full access to Odoo data and can read, create, and update records.
Always confirm before deleting anything.
```

The service parses `[MODEL: ...]` from the first line and uses the remainder as the actual system prompt sent to Gemini. This allows model changes from the Odoo UI without redeployment.

---

## Tools Available to Gemini

### Odoo Tools (`odoo_tools.py`) — Static, XML-RPC direct

| Category | Tools |
|---|---|
| Search & Read | `odoo_search`, `odoo_read`, `odoo_read_group`, `odoo_count`, `odoo_get_fields`, `odoo_get_views`, `odoo_get_menus`, `odoo_get_metadata`, `odoo_search_models`, `odoo_default_get` |
| Write | `odoo_create`, `odoo_write`, `odoo_delete`, `odoo_copy`, `odoo_name_create`, `odoo_create_guided`, `odoo_execute_batch` |
| Actions | `odoo_call`, `odoo_run_server_action`, `odoo_trigger_cron`, `odoo_check_access` |
| Messaging | `odoo_send_message` |
| Files | `odoo_upload_attachment`, `odoo_download_attachment`, `odoo_get_report` |
| Lookup | `odoo_name_search`, `odoo_name_search_batch`, `odoo_list_companies` |

### Output Tools (`output_tools.py`) — Dynamic, MCP client for Google Drive server

New tools added to the Google Drive MCP server are automatically discovered at service startup — no code changes needed to the agent service.

| Tool | Output |
|---|---|
| `create_chart` | PNG image attached to Discuss message |
| `create_excel` | `.xlsx` file attached to Discuss message |
| `create_google_sheet` | Google Sheet link posted in reply |
| `attach_file` | Any file attached to Discuss message |

---

## Data Flow — Single Message

1. User sends message in agent's Discuss channel
2. Odoo Automated Action fires `POST /webhook` with `{ channel_id, message_id, author_id, body, agent_partner_id }`
3. Service validates webhook secret → 401 if mismatch
4. **Debounce check:** fetch last message in channel — if last sender is agent partner and timestamp < 10s ago, return 200 and skip
5. Webhook returns `200 OK` immediately; processing continues async
6. Fetch last 20 messages from `mail.message` for channel → build Gemini conversation history
7. Read `ai.agent` config via `partner_id` → parse `[MODEL: ...]` → extract system prompt
8. Call Gemini with: model, system prompt, conversation history, full tool set
9. **Function calling loop** (max 10 iterations):
   - Gemini requests tool call → execute XML-RPC or MCP call → return result to Gemini
   - Repeat until Gemini returns final text response
10. Post reply to Odoo channel via `mail.channel.message_post` with `author_id = agent_partner_id`
11. Message appears in Discuss as the agent

---

## Concurrency

- **Cloud Run concurrency:** Default 80 (handles multiple channels simultaneously)
- **Same-channel concurrency:** Debounce check (Step 4) prevents overlapping calls within a 10-second window
- **Future:** Cloud Tasks FIFO queue per channel if strict ordering is needed

---

## Error Handling

| Failure | Response |
|---|---|
| Webhook secret mismatch | 401, log, ignore |
| Odoo unreachable | 503 — Odoo retries webhook automatically |
| Agent config not found | Post: *"Agent not configured. Contact admin."* |
| Gemini API error | Post: *"I'm having trouble responding right now. Try again in a moment."* |
| Tool call error | Return error to Gemini — it adapts or explains |
| Tool call loop exceeded | Hard cap at 10 iterations — Gemini responds with available info |
| Debounce triggered | 200, silent skip |

**Key principle:** The agent never goes silent. Every failure posts a human-readable message back to Discuss.

---

## Testing

| Type | What | Method |
|---|---|---|
| Unit | Each Odoo tool function | Mock XML-RPC, assert correct payload |
| Integration | Webhook → Odoo → Gemini → reply | Real `proseso-ventures.odoo.com` dev channel |
| Manual E2E | Full chat conversation | Send messages, verify replies, verify Odoo data changes |
| Tool calling | Read/create/update Odoo records | Ask agent to find records, create tasks, generate sheets |
| Error paths | Bad secret, Gemini down, invalid tool | Malformed webhooks, assert graceful replies |
| Debounce | Rapid messages | Send 3 messages quickly, verify 3 sequential clean replies |

**Dev setup:** Dedicated `#agent-test` Discuss channel with a test agent — no impact on production channels.

---

## Deployment

Follows the same Cloud Build + Cloud Run pattern as `google-drive-mcp-server` and `Odoo-AP-Worker`:

- Push to `main` branch → Cloud Build triggers → builds Docker image → deploys to Cloud Run
- Secrets via Google Secret Manager: Odoo credentials, Gemini API key, webhook secret
- Region: `asia-southeast1` (consistent with existing services)

---

## Environment Variables

| Variable | Description |
|---|---|
| `ODOO_URL` | `https://proseso-ventures.odoo.com` |
| `ODOO_DB` | `proseso-ventures` |
| `ODOO_USER` | Service account email |
| `ODOO_API_KEY` | Odoo API key |
| `GEMINI_API_KEY` | Google AI Studio API key |
| `WEBHOOK_SECRET` | Shared secret for webhook validation |
| `GOOGLE_DRIVE_MCP_URL` | URL of the Google Drive MCP server |
| `GOOGLE_DRIVE_MCP_SECRET` | Auth secret for Google Drive MCP server |
| `DEFAULT_GEMINI_MODEL` | Fallback model if not specified in system prompt |
| `MAX_TOOL_ITERATIONS` | Max Gemini tool call iterations (default: 10) |
| `DEBOUNCE_SECONDS` | Debounce window in seconds (default: 10) |
| `HISTORY_LIMIT` | Number of past messages to include (default: 20) |
