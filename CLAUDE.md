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
3. If the team holds the chat (`humanMode`) → Lia stays silent; the team gets a push
4. Otherwise → message goes to Claude with conversation history + FAQ knowledge base
5. Claude's reply may carry a control tag (parsed in `lib/replyTags.js`):
   - plain text → sent to the customer
   - `[HANDOFF: summary]` → catering / events / collaboration (after Lia collects date & time, location, guest count), jobs, "talk to a human". Text sent, chat moves to the team (`humanMode` + `waitingForTeam`), Dor alerted
   - `[ESCALATE]` → Lia doesn't know. Nothing sent; chat flagged "ליה מחכה לכם", Dor alerted. The answer typed in the app can be saved to the KB
6. The team answers from the **team app** (`/app`) — all from Lia's number. Writing in a chat takes it over from Lia; "החזר לליה" gives it back

Lia never sends Dor's contact card or phone number anymore.

---

## Architecture

```
WhatsApp → Meta API → Webhook (Railway) → Express → Claude API
                                                  ↘ Handoff / escalation → team app + Dor (WhatsApp + push)
Team app (/app, PWA) ⇄ /api (lib/api.js) → Meta API (sent from Lia's number)
```

| File | Role |
|------|------|
| `index.js` | Webhook, Claude, follow-ups, legacy `/conversations` dashboard |
| `lib/api.js` | `/api/*` for the team app + serves `public/app` |
| `lib/team.js` | Team members (`team.json`): 6-digit PINs (scrypt), admin setup via WhatsApp code to `MANAGER_PHONE`, one-time invite links |
| `lib/auth.js` | Signed session cookie (member id) + middleware |
| `lib/contacts.js` | Phone book (`contacts.json`), vCard/CSV import, phone normalization |
| `lib/push.js` | Web Push to the team's phones (`push.json`, VAPID) — every member switched on under ⋮ → ניהול צוות → "התראות" (admin on by default) |
| `lib/templates.js` | Approved message templates, read live from Meta |
| `lib/replyTags.js` | Parses `[HANDOFF]` / `[ESCALATE]` |
| `lib/media.js` | Send photos/videos/voice/files (upload to Meta), serve inbound/outbound media via `/api/media/:id` with a cache in `DATA_DIR/media` |
| `public/app/` | The team app: WhatsApp-style chats, contacts, import, new chat with template |

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
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verify token (set in Railway; don't write the value here) |
| `META_APP_SECRET` | Meta App secret (App → Settings → Basic). Verifies webhook `X-Hub-Signature-256`. If unset, verification is skipped (logged) so the webhook keeps working |
| `DATA_DIR` | `/data` — Railway volume mount. Persists `conversations.json`, `escalations.json`, `pending_escalations.json`, `kb.json`, `contacts.json`, `team.json`, `push.json` and `media/` across redeploys. Defaults to `.` locally |
| `APP_URL` | Public base URL used in links sent to Dor (default: the Railway URL) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | Optional — WABA id for reading templates. If unset it's discovered from the access token |
| `APP_SECRET` | Optional — signs team-app session cookies. If unset, a random key is generated once and kept in `DATA_DIR/app_secret` |
| `LEGACY_DASHBOARD` | Set to `1` to re-enable the old `/conversations?token=` dashboard (off by default; `/conversations` redirects to `/app/`) |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push keys. Generate once: `npx web-push generate-vapid-keys`. If unset, push is disabled |
| `PUSH_OWNER` | Optional, legacy — a member name that always gets push. Normally set per member in the app (ניהול צוות → התראות) |
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
| `/app/` | GET | Team app (PWA). First open: a 6-digit code goes to Dor's WhatsApp, he picks a PIN and becomes admin. Others join via an invite link from ⋮ → ניהול צוות (one-time, 48h), choose name + PIN, then get install instructions |
| `/api/*` | — | Team app API (session cookie) |
| `/health` | GET | Health check — returns `{ status, business, uptime_s, metrics }` where `metrics` = `{ answered, escalated, sendFailed }` (in-memory counters, reset on redeploy) |

**Deploy**: Push to `Main-Branch` → Railway auto-deploys.

---

## Known Issues & Next Steps

- [ ] **Token expiry**: Meta dev tokens expire every ~24h. Upgrade to a permanent **System User token** via Meta Business Manager for production
- [ ] **Meta app review**: Currently in development mode (only test recipients can receive messages). Submit app for Meta review to go live
- [ ] **Conversation history**: Stored in-memory — resets on redeploy. Consider Redis (e.g. Upstash) for persistence
- [ ] **Message templates**: create them in WhatsApp Manager → Message templates. The app lists only templates Meta has **approved** (read live, cached 5 min; `urban_morning_ping` is hidden). Body variables become fields; the first one is pre-filled with the customer's first name. Templates with a media header or dynamic URL button aren't offered. WhatsApp rule: free-form messages only within 24h of the customer's **last** message — older customers need a template even if you talked before
- [ ] **Google Contacts import** — not built yet (needs a Google OAuth app)
- [ ] **escalations.json**: Local file, lost on redeploy. Consider external storage if escalation history is needed

---

## Local Development

```bash
cp .env.example .env   # fill in your credentials
npm install
npm start              # runs on port 3000 — team app at http://localhost:3000/app/
npm test               # unit tests (node --test)
```

Set `NODE_ENV=development` locally so the session cookie works over plain http.

---

## Load & storage (measured)

Benchmarked locally with 3,000 conversations (≈ 60 days × 50 chats/day; idle chats are pruned after 60 days, at startup and daily):

| | |
|---|---|
| `conversations.json` | ~18 MB, written compact, at most once per second, atomically (tmp + rename), flushed on SIGTERM |
| Memory (RSS) | ~140 MB |
| App poll when nothing changed (`?rev=`) | ~26 bytes, < 1 ms |
| Full chat list | top 150 chats + anything unread / waiting for the team (~80 KB); older chats via server-side search |
| Open chat | last 200 messages ("הצגת הודעות קודמות" loads the rest) |
| Media cache | files older than 30 days removed, capped at 1 GB |
| Upload limit from the app | 30 MB per file (held in memory while relayed to Meta) |

If volume grows a lot beyond this, the next step is moving conversations from one JSON file to SQLite on the volume.

## Knowledge Base

Edit `kb.json` to update:
- Business info (address, Wolt link, manager contact)
- FAQ entries (hours, kosher, vegan, gluten-free, etc.)

Changes take effect on next deploy.
