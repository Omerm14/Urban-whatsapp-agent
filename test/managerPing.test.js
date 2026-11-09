const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { shouldSendStartupPing, recordPing } = require("../lib/managerPing");

test("startup ping is skipped if one went out in the last 20h", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ping-")), "manager_ping.json");
  assert.strictEqual(shouldSendStartupPing(file), true, "never sent → send");
  const now = Date.now();
  recordPing(file, now);
  assert.strictEqual(shouldSendStartupPing(file, now + 10 * 60 * 1000), false, "redeploy 10 min later → skip");
  assert.strictEqual(shouldSendStartupPing(file, now + 21 * 60 * 60 * 1000), true, "next day → send");
});
