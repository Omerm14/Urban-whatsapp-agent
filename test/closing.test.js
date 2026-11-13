const test = require("node:test");
const assert = require("node:assert");
const { isClosingMessage, shouldFollowUp, followUpText } = require("../lib/closing");

test("sign-offs are detected", () => {
  for (const t of ["שבת שלום ❤️", "תודה רבה!", "👍", "סבבה תודה", "❤️", "אוקיי תודה", "Thanks!", "תודה רבה לך"]) {
    assert.strictEqual(isClosingMessage(t), true, t);
  }
});

test("messages that keep the conversation going are not sign-offs", () => {
  for (const t of ["תודה, יש לכם גם טבעוני?", "מעולה, אז מחר ב-9?", "מעולה אז מחר ב 9", "בוקר טוב", "תודה ואפשר גם לשמור לי חלה", "אני רוצה להזמין עוגה"]) {
    assert.strictEqual(isClosingMessage(t), false, t);
  }
});

const MIN = 60 * 1000;
const conv = (msgs, extra = {}) => ({
  messages: msgs.map(([role, content, more]) => ({ role, content, sender: role === "user" ? "user" : "lia", ...more })),
  lastSeen: new Date(Date.now() - 11 * MIN).toISOString(), ...extra,
});

test("follow-up only after a real answer", () => {
  assert.strictEqual(shouldFollowUp(conv([["user", "עד מתי פתוחים?"], ["assistant", "עד 16:00"]])), true);
  assert.strictEqual(shouldFollowUp(conv([["user", "אני רוצה מגש"], ["assistant", "לכמה אנשים?"]])), false, "Lia asked — she's waiting");
  assert.strictEqual(shouldFollowUp(conv([["user", "שבת שלום ❤️"], ["assistant", "שבת שלום!", { closing: true }]])), false, "after a goodbye");
  assert.strictEqual(shouldFollowUp(conv([["user", "עד מתי?"], ["assistant", "עד 16:00"]], { conversationClosed: true })), false);
  assert.strictEqual(shouldFollowUp(conv([["user", "עד מתי?"], ["assistant", "עד 16:00"]], { humanMode: true })), false);
});

test("at most one follow-up a day, and not before 10 minutes of silence", () => {
  const c = conv([["user", "עד מתי?"], ["assistant", "עד 16:00"]], { lastFollowUpAt: new Date(Date.now() - 3 * 60 * MIN).toISOString() });
  assert.strictEqual(shouldFollowUp(c), false);
  c.lastFollowUpAt = new Date(Date.now() - 25 * 60 * MIN).toISOString();
  assert.strictEqual(shouldFollowUp(c), true);
  const fresh = conv([["user", "עד מתי?"], ["assistant", "עד 16:00"]], { lastSeen: new Date().toISOString() });
  assert.strictEqual(shouldFollowUp(fresh), false);
});

test("follow-up text is a fixed natural phrase, English for English speakers", () => {
  assert.match(followUpText(conv([["user", "עד מתי?"]])), /\?$/);
  assert.match(followUpText(conv([["user", "until when are you open?"]])), /^[A-Z]/);
});
