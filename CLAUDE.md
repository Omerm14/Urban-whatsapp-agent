# Urban Bakery WhatsApp Agent

AI-powered WhatsApp customer service agent for **אורבן בייקרי** (Urban Bakery, Tel Aviv).

---

## Project Status

| Component | Status |
|-----------|--------|
| Express server | ✅ Running |
| Railway deployment | ✅ Live |
| Meta webhook | ✅ Verified & subscribed |
| WhatsApp → webhook | ✅ Messages arriving |
| Claude AI responses | ✅ Working |
| Reply delivery | ✅ Working (requires valid token) |
| Production (live mode) | ⏳ Pending Meta app review |

---

## How It Works

1. Customer sends a WhatsApp message to the business number
2. Meta forwards it to the webhook (`POST /webhook`)
3. App checks for fixed-response intents (menu, catering, collaboration)
4. If no match → sends message to Claude with conversation history + FAQ knowledge base
5. Claude replies with a confidence score
   - **≥70%** → reply sent to customer
   - **<70%** → escalate to manager (Dor) via WhatsApp + notify customer

---

## Architecture

```
WhatsApp → Meta API → Webhook (Railway) → Express → Claude API
                                                  ↘ Fixed responses (Wolt, catering, collab)
                                                  ↘ Escalation → Manager WhatsApp
```

---

## Stack

- **Runtime**: Node.js + Express
- **AI**: Anthropic Claude (`claude-sonnet-4-6`)
- **Messaging**: Meta WhatsApp Business API
- **Hosting**: Railway
- **Knowledge base**: `kb.json` (FAQ + business info)

---

## Environment Variables

Set in Railway → Variables (never commit to git):

| Variable | Description |
|----------|-------------|
| `WHATSAPP_PHONE_ID` | `1109937042206846` |
| `WHATSAPP_API_TOKEN` | Meta access token — **expires ~24h in dev mode**, needs refresh or permanent System User token |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MANAGER_PHONE` | `+9720546408547` (Dor) |
| `WEBHOOK_VERIFY_TOKEN` | `urban_bakery_secret_2026` (also protects the `/conversations` dashboard) |
| `META_APP_SECRET` | Meta App secret (App → Settings → Basic). Verifies webhook `X-Hub-Signature-256`. If unset, verification is skipped (logged) so the webhook keeps working |
| `DATA_DIR` | `/data` — Railway volume mount. Persists `conversations.json`, `escalations.json`, `pending_escalations.json`, and `kb.json` across redeploys. Defaults to `.` locally |
| `PORT` | `8080` (Railway default) |

> **PII note**: `chat-history/*.zip` are real exported WhatsApp chats used once to
> tune the agent's tone + seed the KB. They are **untracked** from git (kept in
> secure storage for KB work only).

---

## Deployment

**Live URL**: `https://urban-whatsapp-agent-production.up.railway.app`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhook` | GET | Meta webhook verification |
| `/webhook` | POST | Receive WhatsApp messages |
| `/health` | GET | Health check — returns `{ status, business, uptime_s, metrics }` where `metrics` = `{ answered, escalated, sendFailed }` (in-memory counters, reset on redeploy) |

**Deploy**: Push to `Main-Branch` → Railway auto-deploys.

---

## Known Issues & Next Steps

- [ ] **Token expiry**: Meta dev tokens expire every ~24h. Upgrade to a permanent **System User token** via Meta Business Manager for production
- [ ] **Meta app review**: Currently in development mode (only test recipients can receive messages). Submit app for Meta review to go live
- [ ] **Conversation history**: Stored in-memory — resets on redeploy. Consider Redis (e.g. Upstash) for persistence
- [ ] **escalations.json**: Local file, lost on redeploy. Consider external storage if escalation history is needed

---

## Local Development

```bash
cp .env.example .env   # fill in your credentials
npm install
npm start              # runs on port 3000
```

---

## Knowledge Base

Edit `kb.json` to update:
- Business info (address, Wolt link, manager contact)
- FAQ entries (hours, kosher, vegan, gluten-free, etc.)

Changes take effect on next deploy.
