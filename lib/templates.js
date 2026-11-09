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

class TemplateService {
  constructor() {
    this.cache = null;
    this.cachedAt = 0;
    this.wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || null;
  }

  async discoverWaba() {
    if (this.wabaId) return this.wabaId;
    const token = process.env.WHATSAPP_API_TOKEN;
    const res = await axios.get(`${GRAPH}/debug_token`, { params: { input_token: token, access_token: token }, timeout: 10000 });
    const scopes = res.data?.data?.granular_scopes || [];
    const s = scopes.find(x => x.scope === "whatsapp_business_management") || scopes.find(x => x.scope === "whatsapp_business_messaging");
    this.wabaId = s?.target_ids?.[0] || null;
    if (this.wabaId) console.log(`📋 WhatsApp Business Account: ${this.wabaId}`);
    return this.wabaId;
  }

  // Returns { templates, error }. Cached for a few minutes; ?refresh bypasses.
  async list({ refresh = false } = {}) {
    if (!refresh && this.cache && Date.now() - this.cachedAt < CACHE_MS) return this.cache;
    try {
      const waba = await this.discoverWaba();
      if (!waba) return { templates: [], error: "no_waba" };
      const all = [];
      let url = `${GRAPH}/${waba}/message_templates`;
      let params = { fields: "name,status,language,category,components,parameter_format", limit: 100 };
      while (url && all.length < 500) {
        const res = await axios.get(url, { headers: auth(), params, timeout: 15000 });
        all.push(...(res.data?.data || []));
        url = res.data?.paging?.next || null;
        params = undefined; // `next` already carries the query
      }
      const templates = all
        .filter(t => t.status === "APPROVED" && !INTERNAL.has(t.name))
        .map(toAppTemplate)
        .filter(Boolean);
      this.cache = { templates, error: null };
      this.cachedAt = Date.now();
      return this.cache;
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error("Template list failed:", msg);
      // Keep serving the last good list if Meta hiccups.
      return this.cache ? { ...this.cache, stale: true } : { templates: [], error: "meta_error", detail: msg };
    }
  }

  async find(name, language) {
    const { templates } = await this.list();
    return templates.find(t => t.name === name && (!language || t.language === language)) || null;
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
