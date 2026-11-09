// Contacts ("phone book") for the team app.
//
// WhatsApp Cloud API gives no access to contacts, so the app keeps its own
// book in DATA_DIR/contacts.json, keyed by normalized phone (E.164 digits,
// no "+", e.g. "972541234567" — the same shape Meta uses for `wa_id`).
const fs = require("fs");
const path = require("path");

// "054-123 4567" / "+972 54..." / "00972..." / "972..." → "972541234567".
// Returns null for anything that isn't a plausible phone number.
function normalizePhone(raw) {
  if (raw === undefined || raw === null) return null;
  let d = String(raw).replace(/[^\d+]/g, "");
  if (d.startsWith("+")) d = d.slice(1);
  else if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = "972" + d.slice(1);
  d = d.replace(/\D/g, "");
  if (d.length < 9 || d.length > 15) return null;
  return d;
}

// Israeli mobile numbers start with 9725 after normalization. Used to skip
// landlines on import (they can't receive WhatsApp in practice).
function isMobile(phone) {
  if (!phone) return false;
  if (phone.startsWith("972")) return phone.startsWith("9725");
  return true; // foreign numbers: can't tell, keep them
}

// Minimal vCard parser: handles FN / N, TEL (with or without params),
// folded lines and multiple cards. Each phone on a card becomes an entry.
function parseVCard(text) {
  const unfolded = String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const out = [];
  let card = null;
  for (const line of unfolded.split("\n")) {
    const l = line.trim();
    if (/^BEGIN:VCARD/i.test(l)) { card = { name: "", n: "", phones: [] }; continue; }
    if (/^END:VCARD/i.test(l)) {
      if (card) {
        const name = card.name || card.n;
        for (const p of card.phones) out.push({ name, phone: p });
      }
      card = null;
      continue;
    }
    if (!card) continue;
    const idx = l.indexOf(":");
    if (idx === -1) continue;
    const key = l.slice(0, idx).toUpperCase();
    const value = decodeVCardValue(l.slice(idx + 1), key);
    const prop = key.split(";")[0].replace(/^ITEM\d+\./, "");
    if (prop === "FN") card.name = value.trim();
    else if (prop === "N" && !card.n) {
      const [last = "", first = ""] = value.split(";");
      card.n = [first, last].filter(Boolean).join(" ").trim();
    } else if (prop === "TEL") card.phones.push(value.trim());
  }
  return out;
}

function decodeVCardValue(value, key) {
  let v = value.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, " ");
  if (/ENCODING=QUOTED-PRINTABLE/i.test(key)) {
    try {
      const bytes = [];
      v.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})|([^=])/gi, (m, hex, ch) => {
        if (hex) bytes.push(parseInt(hex, 16));
        else bytes.push(...Buffer.from(ch, "utf8"));
        return "";
      });
      v = Buffer.from(bytes).toString("utf8");
    } catch { /* keep raw */ }
  }
  return v;
}

// CSV parser with quoted fields. Header row is matched loosely in Hebrew or
// English: name/שם, phone/טלפון/נייד, type/סוג, notes/note/הערה/הערות.
function parseCSV(text) {
  const rows = splitCSV(String(text || "").replace(/^﻿/, ""));
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim().toLowerCase());
  const find = (...names) => header.findIndex(h => names.some(n => h.includes(n)));
  let iName = find("name", "שם");
  let iPhone = find("phone", "mobile", "טלפון", "נייד");
  const iType = find("type", "סוג");
  const iNotes = find("note", "הערה", "הערות");
  let start = 1;
  if (iPhone === -1) {
    // No header — assume "name,phone,..."
    iName = 0; iPhone = 1; start = 0;
  }
  const out = [];
  for (const r of rows.slice(start)) {
    if (!r.some(c => c.trim())) continue;
    out.push({
      name: (r[iName] || "").trim(),
      phone: (r[iPhone] || "").trim(),
      type: parseType(iType === -1 ? "" : r[iType]),
      notes: iNotes === -1 ? "" : (r[iNotes] || "").trim(),
    });
  }
  return out;
}

function splitCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === "," || c === "\t" || c === ";") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return undefined;
  if (/(עסק|business|b2b|חברה|company)/.test(s)) return "business";
  if (/(פרטי|private|personal)/.test(s)) return "private";
  return undefined;
}

class ContactStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "contacts.json");
    this.data = { contacts: {}, settings: { autoSave: true } };
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
        this.data.contacts = parsed.contacts || {};
        this.data.settings = { ...this.data.settings, ...(parsed.settings || {}) };
      }
    } catch (e) {
      console.error("contacts.json unreadable, starting empty:", e.message);
    }
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  get(phone) { return this.data.contacts[phone] || null; }

  list() {
    return Object.values(this.data.contacts)
      .sort((a, b) => (a.name || a.phone).localeCompare(b.name || b.phone, "he"));
  }

  search(q) {
    const term = String(q || "").trim().toLowerCase();
    if (!term) return this.list();
    const digits = term.replace(/\D/g, "");
    const digitsLocal = digits.startsWith("0") ? "972" + digits.slice(1) : digits;
    return this.list().filter(c =>
      (c.name || "").toLowerCase().includes(term) ||
      (c.notes || "").toLowerCase().includes(term) ||
      (digits.length >= 3 && (c.phone.includes(digits) || c.phone.includes(digitsLocal)))
    );
  }

  // Create or update. Only fields that are provided overwrite existing ones.
  upsert({ phone, name, type, notes, source }) {
    const p = normalizePhone(phone);
    if (!p) return null;
    const existing = this.data.contacts[p];
    const now = new Date().toISOString();
    const c = existing || { phone: p, name: "", type: "private", notes: "", createdAt: now, source: source || "manual" };
    if (name) c.name = String(name).trim().slice(0, 120);
    if (type === "business" || type === "private") c.type = type;
    if (notes !== undefined && notes !== null) c.notes = String(notes).slice(0, 500);
    c.updatedAt = now;
    this.data.contacts[p] = c;
    this.save();
    return c;
  }

  remove(phone) {
    const p = normalizePhone(phone);
    if (p && this.data.contacts[p]) { delete this.data.contacts[p]; this.save(); return true; }
    return false;
  }

  // Called for every inbound customer message. Never overwrites a name the
  // team typed in by hand.
  autoSaveFromWhatsApp(phone, profileName) {
    if (!this.data.settings.autoSave) return;
    const p = normalizePhone(phone);
    if (!p) return;
    const existing = this.data.contacts[p];
    if (existing) {
      if (!existing.name && profileName && !/^\d+$/.test(profileName)) {
        existing.name = profileName; existing.updatedAt = new Date().toISOString(); this.save();
      }
      return;
    }
    this.upsert({ phone: p, name: /^\d+$/.test(profileName || "") ? "" : profileName, source: "whatsapp" });
  }

  setAutoSave(on) { this.data.settings.autoSave = !!on; this.save(); }

  // Dry-run (commit=false) returns the summary shown before importing.
  importEntries(entries, { commit = false, source = "import" } = {}) {
    const seen = new Set();
    const summary = { total: 0, added: 0, merged: 0, skipped: 0, toAdd: [], toMerge: [] };
    for (const e of entries || []) {
      summary.total++;
      const p = normalizePhone(e.phone);
      if (!p || !isMobile(p) || seen.has(p)) { summary.skipped++; continue; }
      seen.add(p);
      const row = { phone: p, name: (e.name || "").trim(), type: e.type, notes: e.notes };
      if (this.data.contacts[p]) { summary.merged++; summary.toMerge.push(row); }
      else { summary.added++; summary.toAdd.push(row); }
    }
    if (commit) {
      for (const row of summary.toAdd) this.upsert({ ...row, source });
      // Merge: fill in blanks only — never clobber what the team already has.
      for (const row of summary.toMerge) {
        const c = this.data.contacts[row.phone];
        if (!c.name && row.name) c.name = row.name;
        if (!c.notes && row.notes) c.notes = row.notes;
        if (row.type && c.source === "whatsapp") c.type = row.type;
      }
      this.save();
    }
    const { toAdd, toMerge, ...counts } = summary;
    return counts;
  }
}

module.exports = { normalizePhone, isMobile, parseVCard, parseCSV, ContactStore };
