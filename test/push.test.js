const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const webpush = require("web-push");
const { TeamStore } = require("../lib/team");

test("notify defaults: admin on, new members off; switch persists", () => {
  const team = new TeamStore(fs.mkdtempSync(path.join(os.tmpdir(), "team-")));
  const dor = team.addMember("דור", "111111", "admin");
  const niko = team.addMember("ניקו", "222222");
  const byName = (n) => team.members().find(m => m.name === n);
  assert.strictEqual(byName("דור").notify, true);
  assert.strictEqual(byName("ניקו").notify, false);
  team.setNotify(niko.id, true);
  assert.strictEqual(new TeamStore(path.dirname(team.file)).members().find(m => m.id === niko.id).notify, true);
  void dor;
});

test("notifyTeam sends to every recipient's devices; only= limits to one member", async () => {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  delete require.cache[require.resolve("../lib/push")];
  const { PushService } = require("../lib/push");
  const orig = webpush.sendNotification;
  const sentTo = [];
  webpush.sendNotification = async (sub) => {
    if (sub.endpoint === "https://push/gone") { const e = new Error("gone"); e.statusCode = 410; throw e; }
    sentTo.push(sub.endpoint);
  };
  try {
    const push = new PushService(fs.mkdtempSync(path.join(os.tmpdir(), "push-")));
    push.resolveRecipients = () => ["dor", "niko"];
    push.subscribe("dor", { endpoint: "https://push/dor-iphone" });
    push.subscribe("niko", { endpoint: "https://push/niko-iphone" });
    push.subscribe("niko", { endpoint: "https://push/gone" });
    push.subscribe("other", { endpoint: "https://push/other" });
    const r = await push.notifyTeam({ title: "x" });
    assert.deepStrictEqual(sentTo.sort(), ["https://push/dor-iphone", "https://push/niko-iphone"]);
    assert.strictEqual(r.sent, 2);
    assert.strictEqual(r.removed, 1, "expired subscription cleaned up");
    assert.strictEqual(push.devices("niko"), 1);
    sentTo.length = 0;
    const t = await push.notifyTeam({ title: "test" }, { only: ["niko"] });
    assert.deepStrictEqual(sentTo, ["https://push/niko-iphone"]);
    assert.strictEqual(t.perMember.niko.sent, 1);
  } finally {
    webpush.sendNotification = orig;
  }
});
