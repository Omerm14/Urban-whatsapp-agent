const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { normalizePhone, parseVCard, parseCSV, ContactStore } = require("../lib/contacts");

test("normalizePhone handles Israeli formats", () => {
  assert.strictEqual(normalizePhone("054-123-4567"), "972541234567");
  assert.strictEqual(normalizePhone("+972 54 123 4567"), "972541234567");
  assert.strictEqual(normalizePhone("00972541234567"), "972541234567");
  assert.strictEqual(normalizePhone("972541234567"), "972541234567");
  assert.strictEqual(normalizePhone("12"), null);
  assert.strictEqual(normalizePhone(""), null);
});

test("parseVCard reads FN/N and every TEL, including folded lines", () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:דנה לוין", "TEL;TYPE=CELL:054-111-2222", "TEL;TYPE=HOME:03-555-1234", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "N:Cohen;Yossi;;;", "item1.TEL:+972 52", " 333 4444", "END:VCARD",
  ].join("\r\n");
  const rows = parseVCard(vcf);
  assert.deepStrictEqual(rows, [
    { name: "דנה לוין", phone: "054-111-2222" },
    { name: "דנה לוין", phone: "03-555-1234" },
    { name: "Yossi Cohen", phone: "+972 52333 4444" },
  ]);
});

test("parseCSV matches Hebrew headers and quoted fields", () => {
  const csv = '﻿שם,טלפון,סוג,הערה\n"קפה רוטשילד, סניף 2",03-555-1234,עסק,"מזמינים ""כל"" שישי"\nדנה,054-111-2222,,\n';
  const rows = parseCSV(csv);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], { name: "קפה רוטשילד, סניף 2", phone: "03-555-1234", type: "business", notes: 'מזמינים "כל" שישי' });
  assert.strictEqual(rows[1].type, undefined);
});

test("ContactStore import: dry run, merge without clobbering, skip landlines/dupes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
  const store = new ContactStore(dir);
  store.upsert({ phone: "0541112222", name: "דנה", notes: "אלרגיה לאגוזים" });
  const entries = [
    { name: "Dana L", phone: "054-111-2222", notes: "other" },  // existing → merge
    { name: "אבי", phone: "050-111-2233" },                      // new
    { name: "אבי שוב", phone: "+972501112233" },                 // duplicate in file → skip
    { name: "משרד", phone: "03-555-1234" },                      // landline → skip
    { name: "?", phone: "abc" },                                 // invalid → skip
  ];
  const dry = store.importEntries(entries);
  assert.deepStrictEqual(dry, { total: 5, added: 1, merged: 1, skipped: 3 });
  assert.strictEqual(store.list().length, 1, "dry run must not write");
  store.importEntries(entries, { commit: true });
  assert.strictEqual(store.list().length, 2);
  const dana = store.get("972541112222");
  assert.strictEqual(dana.name, "דנה");
  assert.strictEqual(dana.notes, "אלרגיה לאגוזים");
  assert.ok(fs.existsSync(path.join(dir, "contacts.json")));
});

test("ContactStore search by name, notes and phone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
  const store = new ContactStore(dir);
  store.upsert({ phone: "0521234567", name: "קפה רוטשילד", type: "business" });
  store.upsert({ phone: "0547654321", name: "דנה לוין", notes: "קפה בלי חלב" });
  store.upsert({ phone: "0500000000", name: "אבי" });
  assert.strictEqual(store.search("קפה").length, 2);
  assert.strictEqual(store.search("765").length, 1);
  assert.strictEqual(store.search("054-765").length, 1);
});

test("autoSaveFromWhatsApp never overwrites a hand-typed name and respects the setting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-"));
  const store = new ContactStore(dir);
  store.upsert({ phone: "0541112222", name: "דנה (קבועה)" });
  store.autoSaveFromWhatsApp("972541112222", "Dana");
  assert.strictEqual(store.get("972541112222").name, "דנה (קבועה)");
  store.setAutoSave(false);
  store.autoSaveFromWhatsApp("972549999999", "New");
  assert.strictEqual(store.get("972549999999"), null);
});
