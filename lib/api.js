// JSON API + static files for the team app (/app).
//
// Mounted from index.js with the shared state it needs. All /api routes except
// login require a team session cookie (see lib/auth.js).
const path = require("path");
const fs = require("fs");
const express = require("express");
const auth = require("./auth");
const { isPin, cleanName } = require("./team");
const { normalizePhone, parseVCard, parseCSV } = require("./contacts");
const { classify, MAX_UPLOAD } = require("./media");
const { buildParams, renderText } = require("./templates");

const MEDIA_LABELS = { image: "📷 תמונה", video: "🎥 סרטון", audio: "🎤 הקלטה", document: "📄 קובץ" };

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
    mediaId: m.mediaId || undefined,
    mimeType: m.mimeType || undefined,
    filename: m.filename || undefined,
    caption: m.caption || undefined,
    location: m.location || undefined,
    template: m.template || undefined,
  };
}

module.exports = function mountTeamApp(app, deps) {
  const {
    conversations, saveConversations, ensureConversation, pushOutgoing,
    contacts, push, media, KB, saveKB, getRev, pendingEscalations, clearPendingEscalation,
    sendWhatsAppMessage, sendWhatsAppTemplate,
  } = deps;

  const api = express.Router();

  // ── Session & team ─────────────────────────────────────────────────────────
  const { team } = deps;
  auth.initSecret(deps.dataDir || ".");
  const requireTeam = auth.requireTeam(team);

  // Per-IP throttle on everything that checks a secret (PIN, owner code, invite).
  const attempts = new Map(); // ip -> { count, resetAt }
  // Only failed attempts count; the bucket is per client IP (trust proxy is on).
  function throttled(req, res) {
    const a = attempts.get(req.ip || "?");
    if (a && Date.now() < a.resetAt && a.count >= 20) { res.status(429).json({ error: "too_many_attempts" }); return true; }
    return false;
  }
  function failed(req) {
    const ip = req.ip || "?";
    const now = Date.now();
    const a = attempts.get(ip);
    if (!a || now > a.resetAt) attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    else a.count++;
  }
  const loggedIn = (res, m) => { auth.setSessionCookie(res, m); res.json({ id: m.id, name: m.name, role: m.role }); };

  // Login screen: who can log in, and whether first setup is still needed.
  api.get("/team/status", (req, res) => {
    res.json({ needsSetup: !team.hasAdmin(), members: team.members().map(({ id, name, role }) => ({ id, name, role })) });
  });

  api.post("/login", (req, res) => {
    if (throttled(req, res)) return;
    const r = team.verifyPin(String(req.body?.id || ""), String(req.body?.pin || ""), req.ip);
    if (r.error) { failed(req); return res.status(r.error === "locked" ? 423 : 401).json({ error: r.error }); }
    loggedIn(res, r.member);
  });

  api.post("/logout", (req, res) => { auth.clearSessionCookie(res); res.json({ ok: true }); });

  // Owner verification: a 6-digit code to MANAGER_PHONE's WhatsApp. Used for
  // the very first setup and for "forgot my code" of the admin.
  let lastOtpAt = 0;
  api.post("/team/owner-code", async (req, res) => {
    if (throttled(req, res)) return;
    if (Date.now() - lastOtpAt < 60 * 1000) return res.status(429).json({ error: "wait" });
    if (!deps.MANAGER_PHONE) return res.status(500).json({ error: "no_manager_phone" });
    lastOtpAt = Date.now();
    const code = team.createOtp();
    const r = await sendWhatsAppMessage(deps.MANAGER_PHONE, `🔐 קוד הכניסה לאפליקציה של ליה: ${code}\nבתוקף ל-10 דקות. אם לא ביקשת — אפשר להתעלם.`);
    if (!r.ok) return res.status(502).json({ error: "send_failed" });
    const last4 = String(deps.MANAGER_PHONE).slice(-4);
    res.json({ ok: true, sentTo: `****${last4}` });
  });

  // body: { code, name, pin } — creates the admin, or resets the admin's PIN.
  api.post("/team/owner-verify", (req, res) => {
    if (throttled(req, res)) return;
    const { code, name, pin } = req.body || {};
    if (!isPin(pin)) return res.status(400).json({ error: "bad_pin" });
    const check = team.checkOtp(code);
    if (!check.ok) {
      failed(req);
      console.warn(`🔐 owner code rejected: ${check.error}`);
      return res.status(401).json({ error: check.error, left: check.left });
    }
    const admin = team.admin();
    if (admin) return loggedIn(res, team.setPin(admin.id, pin));
    const n = cleanName(name) || "דור";
    loggedIn(res, team.addMember(n, pin, "admin"));
  });

  // Invite links: /app/#/join/<token>
  api.get("/team/invite/:token", (req, res) => {
    const inv = team.findInvite(req.params.token);
    if (!inv) return res.status(404).json({ error: "invalid_invite" });
    res.json({ ok: true, invitedBy: team.get(inv.createdBy)?.name || null });
  });

  api.post("/team/join", (req, res) => {
    if (throttled(req, res)) return;
    const { token, name, pin } = req.body || {};
    if (!team.findInvite(token)) { failed(req); return res.status(404).json({ error: "invalid_invite" }); }
    const n = cleanName(name);
    if (!n) return res.status(400).json({ error: "bad_name" });
    if (!isPin(pin)) return res.status(400).json({ error: "bad_pin" });
    if (team.nameTaken(n)) return res.status(409).json({ error: "name_taken" });
    team.useInvite(token);
    const m = team.addMember(n, pin, "member");
    console.log(`👥 ${n} joined the team app`);
    loggedIn(res, m);
  });

  api.use(requireTeam);

  api.get("/me", (req, res) => {
    const canPush = push.isRecipient(req.member.id);
    res.json({
      id: req.member.id,
      name: req.member.name,
      role: req.member.role,
      canPush,
      push: { enabled: push.enabled, publicKey: push.publicKey, subscribed: push.isSubscribed(req.member.id), devices: push.devices(req.member.id) },
    });
  });

  api.post("/me/pin", (req, res) => {
    const { current, pin } = req.body || {};
    if (!isPin(pin)) return res.status(400).json({ error: "bad_pin" });
    const r = team.verifyPin(req.member.id, String(current || ""), req.ip);
    if (r.error) return res.status(403).json({ error: r.error });
    const m = team.setPin(req.member.id, pin);
    auth.setSessionCookie(res, m); // keep this device signed in; others are signed out
    res.json({ ok: true });
  });

  api.get("/team", auth.requireAdmin, (req, res) => res.json({ members: team.members() }));
  api.post("/team/invite", auth.requireAdmin, (req, res) => res.json(team.createInvite(req.member.id)));
  api.delete("/team/:id", auth.requireAdmin, (req, res) => res.json({ ok: team.remove(req.params.id) }));
  // Admin switches push notifications on/off for a member.
  api.patch("/team/:id", auth.requireAdmin, (req, res) => {
    if (typeof req.body?.notify !== "boolean") return res.status(400).json({ error: "bad_request" });
    const m = team.setNotify(req.params.id, req.body.notify);
    if (!m) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true, notify: team.wantsPush(m) });
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

  // The app polls this every few seconds, so keep it cheap:
  //  - `rev` unchanged since the last poll → tiny { unchanged: true } reply
  //  - only the most recent LIST_LIMIT chats, plus every chat that needs the
  //    team now (waiting for the team, or unread) — older ones via search (q)
  const LIST_LIMIT = 150;
  api.get("/conversations", (req, res) => {
    const rev = getRev();
    const q = String(req.query.q || "").trim().toLowerCase();
    if (!q && String(req.query.rev) === String(rev)) return res.json({ rev, unchanged: true });
    let entries = Object.entries(conversations)
      .filter(([, c]) => Array.isArray(c.messages) && c.messages.length > 0)
      .sort((a, b) => new Date(b[1].lastSeen || 0) - new Date(a[1].lastSeen || 0));
    const total = entries.length;
    if (q) {
      const digits = q.replace(/\D/g, "");
      const local = digits.startsWith("0") ? "972" + digits.slice(1) : digits;
      entries = entries.filter(([phone, c]) => {
        const name = (contacts.get(phone)?.name || c.name || "").toLowerCase();
        if (name.includes(q)) return true;
        if (digits.length >= 3 && (phone.includes(digits) || phone.includes(local))) return true;
        return c.messages.some(m => typeof m.content === "string" && m.content.toLowerCase().includes(q));
      }).slice(0, LIST_LIMIT);
    } else {
      entries = entries.filter(([, c], i) => i < LIST_LIMIT || c.waitingForTeam || c.unread);
    }
    res.json({ rev, total, conversations: entries.map(([phone, c]) => summary(phone, c)) });
  });

  function getConv(req, res) {
    const phone = normalizePhone(req.params.phone);
    const conv = phone && conversations[phone];
    if (!conv) { res.status(404).json({ error: "not_found" }); return null; }
    return { phone, conv };
  }

  // Long chats: send the last CHAT_PAGE messages unless ?all=1.
  const CHAT_PAGE = 200;
  api.get("/conversations/:phone", (req, res) => {
    const found = getConv(req, res); if (!found) return;
    const { phone, conv } = found;
    if (req.query.markRead !== "0" && conv.unread) { conv.unread = 0; saveConversations(); }
    const rev = getRev();
    if (String(req.query.rev) === String(rev)) return res.json({ rev, unchanged: true });
    const pending = pendingEscalations.find(e => e.customerPhone === phone) || null;
    const all = req.query.all === "1";
    const msgs = all ? conv.messages : conv.messages.slice(-CHAT_PAGE);
    res.json({
      ...summary(phone, conv),
      rev,
      contact: contacts.get(phone),
      pendingQuestion: pending ? pending.question : null,
      olderCount: conv.messages.length - msgs.length,
      messages: msgs.map(publicMessage),
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

  // Send a photo / video / voice / file. The app posts the raw bytes with
  // Content-Type, X-Filename and X-Caption (URI-encoded) headers.
  api.post("/conversations/:phone/media", express.raw({ type: () => true, limit: MAX_UPLOAD }), async (req, res) => {
    const found = getConv(req, res); if (!found) return;
    const { phone, conv } = found;
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return res.status(400).json({ error: "empty" });
    if (buffer.length > MAX_UPLOAD) return res.status(413).json({ error: "too_large" });
    const closes = windowClosesAt(conv);
    if (!closes || closes < Date.now()) return res.status(409).json({ error: "window_closed" });

    const mimeType = String(req.get("content-type") || "application/octet-stream").split(";")[0].trim();
    const decode = (v) => { try { return decodeURIComponent(v || ""); } catch { return ""; } };
    const filename = decode(req.get("x-filename")).replace(/[\\/\r\n]/g, "_").slice(0, 200) || "file";
    const caption = decode(req.get("x-caption")).trim().slice(0, 1024);
    const kind = classify(mimeType, buffer.length);

    const up = await media.upload(buffer, mimeType, filename);
    if (!up.ok) return res.status(502).json({ error: "upload_failed", detail: up.error });
    const result = await media.send(phone, kind, up.id, { caption, filename });
    if (!result.ok) return res.status(502).json({ error: "send_failed", detail: result.error });

    takeOver(conv, req.member.name);
    pushOutgoing(conv, {
      content: caption || (kind === "document" ? `📄 ${filename}` : MEDIA_LABELS[kind]),
      sender: "team", senderName: req.member.name, result,
      media: { media: kind, mediaId: up.id, mimeType, filename, caption: caption || undefined },
    });
    conv.waitingForTeam = false;
    conv.unread = 0;
    conv.lastSeen = new Date().toISOString();
    clearPendingEscalation(phone);
    saveConversations();
    res.json({ ok: true, kind });
  });

  // Serve inbound/outbound media to the app (cookie-authenticated).
  api.get("/media/:id", async (req, res) => {
    const file = await media.get(req.params.id);
    if (!file) return res.status(404).json({ error: "not_found" });
    res.setHeader("Content-Type", file.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Never render active content (svg/html) inline from customer uploads.
    const inline = /^(image\/(jpeg|png|webp|gif)|video\/|audio\/|application\/pdf)/.test(file.mimeType || "");
    const name = req.query.name ? String(req.query.name) : (file.filename || "file");
    res.setHeader("Content-Disposition", `${inline && !req.query.download ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.send(file.buffer);
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
  // body: { template, language, values: [..] } — values[0] defaults to the
  // customer's first name; other variables come from the app.
  async function sendTemplate(req, res, rawPhone) {
    const phone = normalizePhone(rawPhone);
    if (!phone) return res.status(400).json({ error: "bad_phone" });
    const tpl = await deps.templates.find(req.body?.template, req.body?.language);
    if (!tpl) return res.status(400).json({ error: "bad_template" });
    const name = String(req.body?.name || "").trim();
    if (name) contacts.upsert({ phone, name, source: "manual" });
    const firstName = (name || contacts.get(phone)?.name || conversations[phone]?.name || "").split(" ")[0];
    const values = Array.isArray(req.body?.values) ? req.body.values.map(v => String(v ?? "").slice(0, 200)) : [];
    if (tpl.params.length && !String(values[0] || "").trim()) values[0] = /^\d+$/.test(firstName) ? "" : firstName;
    const missing = tpl.params.findIndex((p, i) => !String(values[i] || "").trim());
    if (missing !== -1) return res.status(400).json({ error: "missing_value", index: missing });

    const result = await sendWhatsAppTemplate(phone, tpl.name, tpl.language, buildParams(tpl, values));
    if (!result.ok) return res.status(502).json({ error: "send_failed", detail: result.error });

    const conv = ensureConversation(phone, name || contacts.get(phone)?.name || phone);
    takeOver(conv, req.member.name);
    pushOutgoing(conv, { content: renderText(tpl, values), sender: "team", senderName: req.member.name, result, template: tpl.name });
    conv.waitingForTeam = false;
    conv.conversationClosed = false;
    conv.lastSeen = new Date().toISOString();
    saveConversations();
    res.json({ ok: true, phone });
  }

  api.post("/conversations/new", (req, res) => sendTemplate(req, res, req.body?.phone));
  api.post("/conversations/:phone/template", (req, res) => sendTemplate(req, res, req.params.phone));

  // Only templates Meta has APPROVED, with their real text (lib/templates.js).
  api.get("/templates", async (req, res) => res.json(await deps.templates.list({ refresh: req.query.refresh === "1" })));

  // Admin: check the connection to Meta (token, number, business account, templates, push).
  api.get("/diagnostics", auth.requireAdmin, async (req, res) => {
    const d = await deps.templates.diagnostics();
    d.push = {
      ok: push.enabled,
      recipients: team.members().filter(m => push.isRecipient(m.id)).map(m => ({ name: m.name, devices: push.devices(m.id) })),
      last: push.last ? { at: push.last.at, sent: push.last.sent, devices: push.last.devices, errors: push.last.errors } : null,
    };
    res.json(d);
  });

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
    if (!push.isRecipient(req.member.id)) return res.status(403).json({ error: "not_recipient" });
    res.json({ ok: push.subscribe(req.member.id, req.body?.subscription) });
  });

  api.post("/push/unsubscribe", (req, res) => {
    push.unsubscribe(req.member.id, req.body?.endpoint);
    res.json({ ok: true });
  });

  api.post("/push/test", async (req, res) => {
    // Test only the phone(s) of whoever pressed the button.
    const r = await push.notifyTeam({ title: "ליה · בדיקה", body: "ההתראות עובדות 🎉", url: "/app/", tag: "test" }, { only: [req.member.id] });
    res.json({ ok: r.sent > 0, ...r });
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
