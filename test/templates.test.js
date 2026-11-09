const test = require("node:test");
const assert = require("node:assert");
const { toAppTemplate, placeholders, buildParams, renderText } = require("../lib/templates");

const meta = (over) => ({ name: "urban_open_chat", status: "APPROVED", language: "he", category: "UTILITY",
  components: [{ type: "BODY", text: "היי {{1}}, כאן אורבן בייקרי. ההזמנה ל-{{2}} מוכנה" }], ...over });

test("placeholders in order, unique", () => {
  assert.deepStrictEqual(placeholders("{{1}} {{2}} {{1}} {{ first_name }}"), ["1", "2", "first_name"]);
});

test("positional template → params, text, send payload", () => {
  const t = toAppTemplate(meta());
  assert.strictEqual(t.label, "open chat");
  assert.deepStrictEqual(t.params.map(p => p.key), ["1", "2"]);
  assert.deepStrictEqual(buildParams(t, ["נועה", "שבת"]), [{ type: "text", text: "נועה" }, { type: "text", text: "שבת" }]);
  assert.strictEqual(renderText(t, ["נועה", "שבת"]), "היי נועה, כאן אורבן בייקרי. ההזמנה ל-שבת מוכנה");
});

test("named template uses parameter_name", () => {
  const t = toAppTemplate(meta({ parameter_format: "NAMED", components: [{ type: "BODY", text: "היי {{first_name}}" }] }));
  assert.deepStrictEqual(buildParams(t, ["דנה"]), [{ type: "text", parameter_name: "first_name", text: "דנה" }]);
});

test("templates the app can't fill are skipped", () => {
  assert.strictEqual(toAppTemplate(meta({ components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }] })), null);
  assert.strictEqual(toAppTemplate(meta({ components: [{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://a.co/{{1}}" }] }] })), null);
  const withHeader = toAppTemplate(meta({ components: [{ type: "HEADER", format: "TEXT", text: "אורבן" }, { type: "BODY", text: "שלום" }] }));
  assert.strictEqual(renderText(withHeader, []), "אורבן\nשלום");
});

test("list: approved selectable, pending shown separately, WABA via fallback, real error surfaced", async () => {
  const axios = require("axios");
  const orig = axios.get;
  const { TemplateService } = require("../lib/templates");
  try {
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    axios.get = async (url) => {
      if (url.includes("debug_token")) return { data: { data: { granular_scopes: [] } } };
      if (url.includes("/me/businesses")) return { data: { data: [{ owned_whatsapp_business_accounts: { data: [{ id: "777" }] } }] } };
      if (url.includes("/777/message_templates")) return { data: { data: [
        meta(),
        meta({ name: "urban_new_message", status: "PENDING" }),
        meta({ name: "urban_morning_ping" }),
      ] } };
      throw new Error("unexpected " + url);
    };
    const svc = new TemplateService();
    const l = await svc.list();
    assert.deepStrictEqual(l.templates.map(t => t.name), ["urban_open_chat"]);
    assert.deepStrictEqual(l.others.map(t => [t.name, t.status]), [["urban_new_message", "ממתינה לאישור"]]);
    assert.strictEqual(await svc.find("urban_new_message"), null, "pending can't be sent");

    axios.get = async () => { const e = new Error("x"); e.response = { status: 400, data: { error: { message: "Missing permissions", code: 10 } } }; throw e; };
    const bad = await new TemplateService().list();
    assert.strictEqual(bad.error, "no_waba");
    assert.match(bad.detail, /Missing permissions \(code 10\)/);
  } finally {
    axios.get = orig;
  }
});
