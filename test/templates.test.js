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
