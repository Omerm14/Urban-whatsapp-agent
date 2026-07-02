# Urban Bakery WhatsApp Agent

An AI-powered WhatsApp customer service agent for **אורבן בייקרי** (Urban Bakery), located at Nitzana 14, Tel Aviv.

---

## Overview

Customers message the bakery's WhatsApp number and get instant, intelligent replies — in Hebrew or English — powered by Claude AI. When the agent isn't confident enough in an answer, it automatically escalates to the manager (Dor) via WhatsApp and notifies the customer.

---

## How It Works

```
Customer → WhatsApp → Meta API → Webhook (Railway)
                                        ↓
                               Fixed-response check
                               (Wolt, catering, collab)
                                        ↓
                                  Claude AI + KB
                                        ↓
                           Confidence score ≥ 70%?
                            Yes → Reply to customer
                            No  → Escalate to manager
```

1. Customer sends a WhatsApp message to the business number.
2. Meta forwards the message to the webhook hosted on Railway.
3. The app checks for fixed-response intents (Wolt link, catering enquiries, business collaboration).
4. If no fixed match is found, the message is sent to Claude along with conversation history and the FAQ knowledge base.
5. Claude returns a reply with a confidence score:
   - **≥ 70%** → reply sent directly to the customer.
   - **< 70%** → manager (Dor) is notified via WhatsApp, and the customer is told a human will follow up.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + Express |
| AI | Anthropic Claude (`claude-sonnet-4-6`) |
| Messaging | Meta WhatsApp Business API |
| Hosting | Railway |
| Knowledge base | `kb.json` |

---

## Project Structure

```
.
├── index.js          # Main Express server — webhook, AI logic, escalation
├── kb.json           # Knowledge base: business info + FAQ entries
├── lib/
│   ├── dedup.js      # Deduplicates incoming webhook events
│   └── verifySignature.js  # Validates Meta's X-Hub-Signature-256 header
└── .env.example      # Environment variable template
```

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Receive incoming WhatsApp messages |
| `GET` | `/health` | Returns `{ status, business, uptime_s, metrics }` — metrics include `answered`, `escalated`, `sendFailed` (in-memory, reset on redeploy) |

---

## Environment Variables

Create a `.env` file from `.env.example` and fill in:

| Variable | Description |
|---|---|
| `WHATSAPP_PHONE_ID` | Meta WhatsApp Phone ID |
| `WHATSAPP_API_TOKEN` | Meta access token (expires ~24h in dev mode) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `MANAGER_PHONE` | Manager's WhatsApp number (e.g. `+9720546408547`) |
| `WEBHOOK_VERIFY_TOKEN` | Token used by Meta to verify the webhook |
| `META_APP_SECRET` | Meta App secret for HMAC signature verification |
| `DATA_DIR` | Directory for persistent files (default: `.`, Railway uses `/data`) |
| `PORT` | Server port (default: `8080` on Railway) |

> Never commit secrets to git. Set all variables in Railway → Variables.

---

## Knowledge Base

`kb.json` contains two sections:

- **`business`** — name, address, Wolt link, manager contact.
- **`faq`** — question/answer pairs covering hours, kosher status, vegan & gluten-free options, reservations, happy hour, custom cakes, catering, and more.

Edit `kb.json` and redeploy to update any FAQ entry. The app merges new seed entries automatically on startup without overwriting existing ones.

---

## Local Development

```bash
cp .env.example .env   # fill in your credentials
npm install
npm start              # runs on port 3000
```

For live reload during development:

```bash
npm run dev            # requires nodemon
```

---

## Deployment

Live URL: `https://urban-whatsapp-agent-production.up.railway.app`

Push to `Main-Branch` → Railway auto-deploys.

Persistent data files (`conversations.json`, `escalations.json`, `pending_escalations.json`, `kb.json`) are written to the Railway volume mounted at `/data`.

---

## Key Behaviors

- **Multilingual**: Detects whether the customer is writing in Hebrew or English and responds in the same language.
- **Conversation history**: Maintains per-customer message history (pruned after 60 days of inactivity) so context carries across messages.
- **Message batching**: Groups messages sent in quick succession before sending a single AI response.
- **Follow-up & close**: After a conversation goes quiet, the agent sends a follow-up and then a closing message using Claude-generated text.
- **Deduplication**: Ignores duplicate webhook deliveries from Meta.
- **Signature verification**: Validates `X-Hub-Signature-256` on every incoming webhook request (skipped with a warning if `META_APP_SECRET` is not set).

---

## Known Limitations & Roadmap

- **Token expiry**: Meta dev tokens expire every ~24h. Upgrade to a permanent System User token via Meta Business Manager for production.
- **Meta app review**: Currently in development mode — only test numbers can receive messages. Submit for Meta review to go fully live.
- **In-memory metrics**: `answered`, `escalated`, `sendFailed` counters reset on every redeploy.
- **Conversation persistence**: Stored in a JSON file on the Railway volume; consider Redis (e.g. Upstash) for higher reliability.

---

## Status

| Component | Status |
|---|---|
| Express server | Running |
| Railway deployment | Live |
| Meta webhook | Verified & subscribed |
| WhatsApp → webhook | Messages arriving |
| Claude AI responses | Working |
| Reply delivery | Working |
| Production (live mode) | Pending Meta app review |
