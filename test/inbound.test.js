const test = require("node:test");
const assert = require("node:assert");
const { describeInbound, labelFor } = require("../lib/inbound");

test("image → media with id, caption and forward", () => {
  const r = describeInbound({ type: "image", image: { id: "M1", mime_type: "image/jpeg", caption: "עוגה" } });
  assert.equal(r.kind, "media");
  assert.equal(r.mediaId, "M1");
  assert.equal(r.label, "📷 תמונה: עוגה");
  assert.equal(r.notify, true);
});

test("reaction → target + emoji, no notification; empty emoji = removed", () => {
  const r = describeInbound({ type: "reaction", reaction: { message_id: "wamid.X", emoji: "❤️" } });
  assert.deepEqual([r.kind, r.target, r.emoji, r.notify], ["reaction", "wamid.X", "❤️", false]);
  assert.equal(describeInbound({ type: "reaction", reaction: { message_id: "wamid.X" } }).emoji, "");
});

test("button / interactive taps become text", () => {
  assert.deepEqual(describeInbound({ type: "button", button: { text: "בוקר טוב", payload: "p" } }), { kind: "text", type: "button", text: "בוקר טוב" });
  assert.equal(describeInbound({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "1", title: "שישי" } } }).text, "שישי");
  assert.equal(describeInbound({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "כן" } } }).text, "כן");
});

test("unsupported keeps Meta's error and sub-type", () => {
  const r = describeInbound({
    id: "wamid.U", type: "unsupported", unsupported: { type: "edit" }, context: { id: "wamid.ORIG" },
    errors: [{ code: 131051, title: "Message type unknown", error_data: { details: "Message type is currently not supported." } }],
  });
  assert.equal(r.kind, "unsupported");
  assert.equal(r.unsupportedType, "edit");
  assert.equal(r.target, "wamid.ORIG");
  assert.deepEqual(r.metaError, { code: 131051, title: "Message type unknown", details: "Message type is currently not supported." });
  assert.match(r.label, /ערך/);
  assert.equal(r.whatsapp, false); // edits: push only
});

test("unsupported with no sub-type → generic label, WhatsApp alert to Dor", () => {
  const r = describeInbound({ type: "unsupported", errors: [{ code: 131051, title: "Message type unknown" }] });
  assert.match(r.label, /WhatsApp לא מעביר/);
  assert.equal(r.whatsapp, true);
});

test("request_welcome is silent; unknown types are named", () => {
  assert.equal(describeInbound({ type: "request_welcome" }).notify, false);
  assert.equal(describeInbound({ type: "order", order: {} }).label, "הודעה (order)");
  assert.equal(labelFor("location"), "📍 מיקום");
});

test("location and contacts carry their details", () => {
  const l = describeInbound({ type: "location", location: { latitude: 32.1, longitude: 34.8, name: "אורבן" } });
  assert.deepEqual([l.kind, l.location.lat, l.label], ["location", 32.1, "📍 מיקום: אורבן"]);
  const c = describeInbound({ type: "contacts", contacts: [{ name: { formatted_name: "דנה" }, phones: [{ phone: "+972501234567" }] }] });
  assert.equal(c.label, "👤 איש קשר: דנה +972501234567");
});
