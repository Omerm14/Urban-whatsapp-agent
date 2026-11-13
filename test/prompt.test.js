const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// The system prompt lives in index.js (buildSystemPrompt). Guard the Hebrew rules
// that fix real mistakes Lia made, so they don't get lost in future edits.
const src = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");

test("prompt teaches prepositions at the start of Hebrew questions", () => {
  assert.match(src, /לא "כמה אנשים זה בשביל\?" — אלא "לכמה אנשים\?"/);
});

test("prompt has a tray-order example asking all missing details at once", () => {
  assert.match(src, /לכמה אנשים, לאיזה תאריך, ואיסוף מהמאפייה או משלוח\?/);
});
