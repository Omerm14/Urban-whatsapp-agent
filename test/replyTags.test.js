const test = require("node:test");
const assert = require("node:assert");
const { parseReply } = require("../lib/replyTags");

test("plain answer", () => {
  assert.deepStrictEqual(parseReply("פתוחים עד 19:00"), { escalate: false, handoff: null, text: "פתוחים עד 19:00" });
});

test("escalate sends nothing to the customer", () => {
  const r = parseReply("[ESCALATE]");
  assert.strictEqual(r.escalate, true);
  assert.strictEqual(r.text, "");
});

test("handoff with summary is stripped from the customer text", () => {
  const r = parseReply("מעולה, מעבירה לצוות שלנו ומישהו יחזור אלייך כאן [HANDOFF: קייטרינג · חמישי 12:00 · רוטשילד 22 · 50 איש]");
  assert.strictEqual(r.text, "מעולה, מעבירה לצוות שלנו ומישהו יחזור אלייך כאן");
  assert.deepStrictEqual(r.handoff, { summary: "קייטרינג · חמישי 12:00 · רוטשילד 22 · 50 איש" });
});

test("handoff without summary", () => {
  const r = parseReply("מישהו מהצוות יחזור אלייך\n[HANDOFF]");
  assert.strictEqual(r.text, "מישהו מהצוות יחזור אלייך");
  assert.deepStrictEqual(r.handoff, { summary: "" });
});
