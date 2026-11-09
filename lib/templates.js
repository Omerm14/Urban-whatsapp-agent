// Approved WhatsApp message templates, read live from Meta.
//
// The team app only offers templates Meta has actually APPROVED for this
// business, with their real text. The WhatsApp Business Account (WABA) id is
// taken from WHATSAPP_BUSINESS_ACCOUNT_ID, or discovered from the access token.
const axios = require("axios");

const GRAPH = "https://graph.facebook.com/v21.0";
const CACHE_MS = 5 * 60 * 1000;
// Templates used by the system itself, never offered to the team.
const INTERNAL = new Set(["urban_morning_ping"]);

const auth = () => ({ Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` });

// "{{1}}" / "{{first_name}}" placeholders in order of appearance.
function placeholders(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/\{\{\s*([\w]+)\s*\}\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// Turn Meta's template object into what the app needs, or null when the app
// can't fill it (media header, header variables, dynamic URL buttons).
function toAppTemplate(t) {
  const comps = t.components || [];
  const body = comps.find(c => c.type === "BODY");
  if (!body) return null;
  const header = comps.find(c => c.type === "HEADER");
  if (header && (header.format !== "TEXT" || placeholders(header.text).length)) return null;
  const buttons = comps.find(c => c.type === "BUTTONS");
  if (buttons && (buttons.buttons || []).some(b => b.type === "URL" && /\{\{/.test(b.url || ""))) return null;
  const keys = placeholders(body.text);
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    named: t.parameter_format === "NAMED",
    label: t.name.replace(/^urban_/, "").replace(/_/g, " "),
    header: header?.text || null,
    text: body.text,
    params: keys.map((key, i) => ({ key, firstName: i === 0 })), // first one = customer's first name
  };
}

const STATUS_HE = {
  APPROVED: "מאושרת", PENDING: "ממתינה לאישור", IN_APPEAL: "בערעור", REJECTED: "נדחתה",
  PAUSED: "מושהית", DISABLED: "מושבתת", LIMIT_EXCEEDED: "חרגה ממגבלה",
};

function metaError(e) {
  const err = e.response?.data?.error;
  return err ? `${err.message}${err.code ? ` (code ${err.code})` : ""}` : e.message;
}

class TemplateService {
  constructor() {
    this.cache = null;
    this.cachedAt = 0;
    this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null;
    this.lastDiscoveryError = null;
  }

  // WABA id: env var, else from the token's granted scopes, else from the
  // businesses the token can see.
  async discoverWaba() {
    if (process.env.WHATSAPP_BUSINESS_ACCOUNT_ID) return (this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID);
    if (this.wabaId) return this.wabaId;
    const token = process.env.WHATSAPP_API_TOKEN;
    const errors = [];
    try {
      const res = await axios.get(`${GRAPH}/debug_token`, { params: { input_token: token, access_token: token }, timeout: 10000 });
      const scopes = res.data?.data?.granular_scopes || [];
      const s = scopes.find(x => x.scope === "whatsapp_business_management" && x.target_ids?.length)
        || scopes.find(x => x.scope === "whatsapp_business_messaging" && x.target_ids?.length);
      if (s) this.wabaId = s.target_ids[0];
      else errors.push("debug_token: no WhatsApp account in the token's scopes");
    } catch (e) { errors.push(`debug_token: ${metaError(e)}`); }
    if (!this.wabaId) {
      try {
        const res = await axios.get(`${GRAPH}/me/businesses`, {
          headers: auth(), timeout: 10000,
          params: { fields: "owned_whatsapp_business_accounts{id},client_whatsapp_business_accounts{id}" },
        });
        for (const b of res.data?.data || []) {
          const w = b.owned_whatsapp_business_accounts?.data?.[0] || b.client_whatsapp_business_accounts?.data?.[0];
          if (w) { this.wabaId = w.id; break; }
        }
        if (!this.wabaId) errors.push("me/businesses: no WhatsApp account found");
      } catch (e) { errors.push(`me/businesses: ${metaError(e)}`); }
    }
    this.lastDiscoveryError = this.wabaId ? null : errors.join(" | ");
    if (this.wabaId) console.log(`📋 WhatsApp Business Account: ${this.wabaId}`);
    else console.error("📋 Could not find the WhatsApp Business Account id:", this.lastDiscoveryError);
    return this.wabaId;
  }

  // Returns { templates, others, error, detail }:
  //   templates — APPROVED and fillable (selectable in the app)
  //   others    — pending / rejected / unsupported, shown for information
  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    try {
      const waba = await this.discoverWaba();
      if (!waba) return { templates: [], others: [], error: "no_waba", detail: this.lastDiscoveryError };
      const all = [];
      let url = `${GRAPH}/${waba}/message_templates`;
      let params = { fields: "name,status,language,category,components,parameter_format", limit: 100 };
      while (url && all.length < 500) {
        const res = await axios.get(url, { headers: auth(), params, timeout: 15000 });
        all.push(...(res.data?.data || []));
        url = res.data?.paging?.next || null;
        params = undefined; // `next` already carries the query
      }
      const templates = [];
      const others = [];
      for (const t of all) {
        if (INTERNAL.has(t.name)) continue;
        const app = toAppTemplate(t);
        if (t.status === "APPROVED" && app) templates.push(app);
        else others.push({
          name: t.name, language: t.language,
          status: STATUS_HE[t.status] || t.status,
          reason: app ? null : "כותרת עם מדיה או כפתור עם קישור משתנה — לא נתמך באפליקציה",
        });
      }
      this.cache = { templates, others, error: null };
      this.cachedAt = Date.now();
      return this.cache;
    } catch (e) {
      const detail = metaError(e);
      console.error("Template list failed:", detail);
      if (e.response?.status === 400 || e.response?.status === 404) this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null;
      // Keep serving the last good list if Meta hiccups.
      return this.cache ? { ...this.cache, stale: true } : { templates: [], others: [], error: "meta_error", detail };
    }
  }

  async find(name, language) {
    const { templates } = await this.list();
    return templates.find(t => t.name === name && (!language || t.language === language)) || null;
  }

  // Admin "check connection to Meta": what works and what's missing.
  async diagnostics() {
    const token = process.env.WHATSAPP_API_TOKEN;
    const out = { token: null, phone: null, waba: null, templates: null };
    if (!token) { out.token = { ok: false, detail: "WHATSAPP_API_TOKEN חסר" }; return out; }
    try {
      const d = (await axios.get(`${GRAPH}/debug_token`, { params: { input_token: token, access_token: token }, timeout: 10000 })).data?.data || {};
      out.token = {
        ok: !!d.is_valid,
        expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null, // 0 = never
        neverExpires: d.expires_at === 0,
        scopes: d.scopes || [],
      };
    } catch (e) { out.token = { ok: false, detail: metaError(e) }; }
    try {
      const p = (await axios.get(`${GRAPH}/${process.env.WHATSAPP_PHONE_ID}`, { headers: auth(), params: { fields: "display_phone_number,verified_name" }, timeout: 10000 })).data;
      out.phone = { ok: true, number: p.display_phone_number, name: p.verified_name };
    } catch (e) { out.phone = { ok: false, detail: metaError(e) }; }
    this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null;
    const waba = await this.discoverWaba();
    out.waba = waba ? { ok: true, id: waba, fromEnv: !!process.env.WHATSAPP_BUSINESS_ACCOUNT_ID } : { ok: false, detail: this.lastDiscoveryError };
    if (waba) {
      const l = await this.list({ refresh: true });
      out.templates = l.error ? { ok: false, detail: l.detail } : { ok: true, approved: l.templates.length, others: l.others };
    }
    return out;
  }
}

// Body parameters for the send API from the values the app collected.
function buildParams(tpl, values) {
  return tpl.params.map((p, i) => {
    const text = String(values[i] ?? "").trim() || "-";
    return tpl.named ? { type: "text", parameter_name: p.key, text } : { type: "text", text };
  });
}

// The message as the customer will see it, for the chat history.
function renderText(tpl, values) {
  const map = new Map(tpl.params.map((p, idx) => [p.key, String(values[idx] ?? "").trim()]));
  const body = tpl.text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (_, k) => map.get(k) ?? `{{${k}}}`);
  return tpl.header ? `${tpl.header}\n${body}` : body;
}

module.exports = { TemplateService, toAppTemplate, placeholders, buildParams, renderText };
