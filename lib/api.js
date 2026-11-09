// JSON API + static files for the team app (/app).
//
// Mounted from index.js with the shared state it needs. All /api routes except
// login require a team session cookie (see lib/auth.js).
const path = require("path");
const fs = require("fs");
const express = require("express");
const auth = require("./auth");
const { normalizePhone, parseVCard, parseCSV } = require("./contacts");

const WINDOW_MS = 24 * 60 * 60 * 1000;

function lastCustomerAt(conv) {
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === "user") return m.timestamp ? new Date(m.timestamp).getTime() : null;
  }
  return null;
}

// WhatsApp only allows free-form messages within 24h of the customer's last message.
function windowClosesAt(conv) {
  const t = lastCustomerAt(conv);
  return t ? t + WINDOW_MS : null;
}

function senderOf(m) {
  if (m.role === "user") return "user";
  if (m.sender === "system") return "system";
  if (m.sender === "team" || m.sender === "dor") return "team";
  return "lia";
}

function publicMessage(m) {
  const sender = senderOf(m);
  return {
    sender,
    senderName: sender === "team" ? (m.senderName || "דור") : undefined,
    content: m.content,
    timestamp: m.timestamp || null,
    status: m.status || null,
    media: m.media || undefined,
    template: m.template || undefined,
  };
}

module.exports = function mountTeamApp(app, deps) {
  const {
    conversations, saveConversations, ensureConversation, pushOutgoing,
    contacts, push, KB, saveKB, pendingEscalations, clearPendingEscalation,
    sendWhatsAppMessage, sendWhatsAppTemplate,
  } = deps;

  const api = express.Router();

  // ── Session ────────────────────────────────────────────────────────────────
  const loginAttempts = new Map(); // ip -> { count, resetAt }
  api.post("/login", (req, res) => {
    const ip = req.ip || "?";
    const now = Date.now();
    const a = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    if (now > a.resetAt) { a.count = 0; a.resetAt = now + 15 * 60 * 1000; }
    if (a.count >= 10) return res.status(429).json({ error: "too_many_attempts" });
    const member = auth.login(req.body?.code);
    if (!member) {
      a.count++; loginAttempts.set(ip, a);
      return res.status(401).json({ error: "wrong_code" });
    }
    loginAttempts.delete(ip);
    auth.setSessionCookie(res, member);
    res.json({ name: member.name });
  });

  api.post("/logout", (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  api.use(auth.requireTeam);

  api.get("/me", (req, res) => {
    res.json({
      name: req.member.name,
      isPushOwner: req.member.name === push.owner(),
      push: { enabled: push.enabled, publicKey: push.publicKey, subscribed: push.isSubscribed(req.member.name) },
    });
  });

  // ── Conversations ──────────────────────────────────────────────────────────
  function summary(phone, conv) {
    const msgs = conv.messages || [];
    const last = [...msgs].reverse().find(m => m.sender !== "system") || msgs[msgs.length - 1];
    const closes = windowClosesAt(conv);
    return {
      phone,
      name: contacts.get(phone)?.name || conv.name || phone,
      lastMessage: last ? publicMessage(last) : null,
      lastSeen: conv.lastSeen || null,
      unread: conv.unread || 0,
      humanMode: !!conv.humanMode,
      humanBy: conv.humanBy || null,
      waitingForTeam: !!conv.waitingForTeam,
      handoffSummary: conv.handoffSummary || null,
      windowOpen: closes ? closes > Date.now() : false,
      windowClosesAt: closes ? new Date(closes).toISOString() : null,
    };
  }

  api.get("/conversations", (req, res) => {
    const list = Object.entries(conversations)
      .filter(([, c]) => Array.isArray(c.messages) && c.messages.length > 0)
      .map(([phone, c]) => summary(phone, c))
      .sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
    res.json({ conversations: list });
  });

  function getConv(req, res) {
    const phone = normalizePhone(req.params.phone);
    const conv = phone && conversations[phone];
    if (!conv) { res.status(404).json({ error: "not_found" }); return null; }
    return { phone, conv };
  }

  api.get("/conversations/:phone", (req, res) => {
    const found = getConv(req, res); if (!found) return;
    const { phone, conv } = found;
    if (req.query.markRead !== "0" && conv.unread) { conv.unread = 0; saveConversations(); }
    const pending = pendingEscalations.find(e => e.customerPhone === phone) || null;
    res.json({
      ...summary(phone, conv),
      contact: contacts.get(phone),
      pendingQuestion: pending ? pending.question : null,
      messages: conv.messages.map(publicMessage),
    });
  });

  function takeOver(conv, memberName) {
    if (!conv.humanMode) {
      conv.humanMode = true;
      conv.humanModeSince = new Date().toISOString();
      conv.messages.push({ role: "assistant", sender: "system", content: `[השיחה אצל ${memberName} · ליה בהמתנה]`, timestamp: new Date().toISOString() });
    }
    conv.humanBy = memberName;
  }

  // Writing in a chat takes it over from Lia.
  api.post("/conversations/:phone/send", async (req, res) => {
    const found = getConv(req, res); if (!found) return;
    const { phone, conv } = found;
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "empty" });
    if (text.length > 4096) return res.status(400).json({ error: "too_long" });
    const closes = windowClosesAt(conv);
    if (!closes || closes < Date.now()) return res.status(409).json({ error: "window_closed" });

    const result = await sendWhatsAppMessage(phone, text);
    if (!result.ok) {
      pushOutgoing(conv, { content: text, sender: "team", senderName: req.member.name, result });
      saveConversations();
      return res.status(502).json({ error: "send_failed", detail: result.error });
    }
    takeOver(conv, req.member.name);
    pushOutgoing(conv, { content: text, sender: "team", senderName: req.member.name, result });
    conv.humanBy = req.member.name;
    conv.waitingForTeam = false;
    conv.unread = 0;
    conv.lastSeen = new Date().toISOString();

    // "Save for Lia next time": teach the KB from the answer to an escalated question.
    if (req.body?.saveToKB) {
      const pending = pendingEscalations.find(e => e.customerPhone === phone);
      if (pending) {
        KB.faq.push({ id: `custom_${Date.now()}`, question: pending.question, answer: text });
        saveKB();
        console.log(`📚 KB updated from app: "${pending.question}"`);
      }
    }
    clearPendingEscalation(phone);
    saveConversations();
    res.json({ ok: true });
  });

  api.post("/conversations/:phone/take", (req, res) => {
    const found = getConv(req, res); if (!found) return;
    takeOver(found.conv, req.member.name);
    saveConversations();
    res.json({ ok: true });
  });

  api.post("/conversations/:phone/release", (req, res) => {
    const found = getConv(req, res); if (!found) return;
    const { phone, conv } = found;
    conv.humanMode = false;
    conv.humanModeSince = null;
    conv.humanBy = null;
    conv.waitingForTeam = false;
    conv.handoffSummary = null;
    conv.messages.push({ role: "assistant", sender: "system", content: "[השיחה חזרה לליה]", timestamp: new Date().toISOString() });
    clearPendingEscalation(phone);
    saveConversations();
    res.json({ ok: true });
  });

  // Start (or reopen) a conversation: always via an approved template, which
  // is the only thing WhatsApp allows outside the 24h window.
  async function sendTemplate(req, res, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) return res.status(400).json({ error: "bad_phone" });
    const tpl = (KB.templates || []).find(t => t.name === req.body?.template);
    if (!tpl) return res.status(400).json({ error: "bad_template" });
    const name = String(req.body?.name || "").trim();
    if (name) contacts.upsert({ phone, name, source: "manual" });
    const firstName = (name || contacts.get(phone)?.name || "").split(" ")[0];
    const params = (tpl.params || []).map(p => (p === "name" ? (firstName || "שלום") : p));

    const result = await sendWhatsAppTemplate(phone, tpl.name, tpl.language || "he", params);
    if (!result.ok) return res.status(502).json({ error: "send_failed", detail: result.error });

    const conv = ensureConversation(phone, name || contacts.get(phone)?.name || phone);
    const preview = (tpl.preview || tpl.label).replace(/\[שם\]/g, firstName || "");
    pushOutgoing(conv, { content: preview, sender: "team", senderName: req.member.name, result, template: tpl.name });
    conv.humanMode = true;
    conv.humanModeSince = conv.humanModeSince || new Date().toISOString();
    conv.humanBy = req.member.name;
    conv.waitingForTeam = false;
    conv.conversationClosed = false;
    conv.lastSeen = new Date().toISOString();
    saveConversations();
    res.json({ ok: true, phone });
  }

  api.post("/conversations/new", (req, res) => sendTemplate(req, res, req.body?.phone));
  api.post("/conversations/:phone/template", (req, res) => sendTemplate(req, res, req.params.phone));

  api.get("/templates", (req, res) => res.json({ templates: KB.templates || [] }));

  // ── Contacts ───────────────────────────────────────────────────────────────
  api.get("/contacts", (req, res) => {
    const list = contacts.search(req.query.q);
    const lastSeen = (p) => conversations[p]?.lastSeen || null;
    res.json({
      total: contacts.list().length,
      autoSave: contacts.data.settings.autoSave,
      contacts: list.map(c => ({ ...c, lastSeen: lastSeen(c.phone) })),
    });
  });

  api.post("/contacts", (req, res) => {
    const c = contacts.upsert({ ...req.body, source: "manual" });
    if (!c) return res.status(400).json({ error: "bad_phone" });
    if (conversations[c.phone] && c.name) { conversations[c.phone].name = c.name; saveConversations(); }
    res.json({ contact: c });
  });

  api.delete("/contacts/:phone", (req, res) => res.json({ ok: contacts.remove(req.params.phone) }));

  api.post("/contacts/settings", (req, res) => {
    if (typeof req.body?.autoSave === "boolean") contacts.setAutoSave(req.body.autoSave);
    res.json({ autoSave: contacts.data.settings.autoSave });
  });

  // body: { format: "vcard" | "csv" | "entries", text?, entries?, commit }
  api.post("/contacts/import", express.json({ limit: "5mb" }), (req, res) => {
    const { format, text, entries, commit } = req.body || {};
    let rows;
    if (format === "vcard") rows = parseVCard(text);
    else if (format === "csv") rows = parseCSV(text);
    else if (format === "entries") rows = Array.isArray(entries) ? entries : [];
    else return res.status(400).json({ error: "bad_format" });
    const source = format === "entries" ? "phone" : format;
    res.json(contacts.importEntries(rows, { commit: !!commit, source }));
  });

  // ── Push ───────────────────────────────────────────────────────────────────
  api.post("/push/subscribe", (req, res) => {
    if (!push.enabled) return res.status(503).json({ error: "push_disabled" });
    if (req.member.name !== push.owner()) return res.status(403).json({ error: "not_owner" });
    res.json({ ok: push.subscribe(req.member.name, req.body?.subscription) });
  });

  api.post("/push/unsubscribe", (req, res) => {
    push.unsubscribe(req.member.name, req.body?.endpoint);
    res.json({ ok: true });
  });

  api.post("/push/test", async (req, res) => {
    await push.notifyOwner({ title: "ליה · בדיקה", body: "ההתראות עובדות 🎉", url: "/app/" });
    res.json({ ok: true });
  });

  app.use("/api", express.json({ limit: "5mb" }), api);

  // ── Static app ─────────────────────────────────────────────────────────────
  const dir = path.join(__dirname, "..", "public", "app");
  // Express routing isn't strict about trailing slashes, so check the raw path.
  app.get("/app", (req, res, next) => (req.path === "/app" && !req.originalUrl.startsWith("/app/") ? res.redirect(301, "/app/") : next()));
  app.use("/app", express.static(dir, {
    setHeaders(res, file) {
      // Always revalidate the shell so updates reach installed PWAs quickly.
      if (/\.(html|js|css|webmanifest)$/.test(file)) res.setHeader("Cache-Control", "no-cache");
      if (file.endsWith("sw.js")) res.setHeader("Service-Worker-Allowed", "/app/");
    },
  }));
  if (!fs.existsSync(dir)) console.warn("⚠️  public/app missing — team app not served");
};
