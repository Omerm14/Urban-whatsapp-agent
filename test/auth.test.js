const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.APP_SECRET = "test-secret";
const auth = require("../lib/auth");
const { TeamStore } = require("../lib/team");

const tmpTeam = () => new TeamStore(fs.mkdtempSync(path.join(os.tmpdir(), "team-")));

test("signed session round-trips and rejects tampering/expiry", () => {
  const token = auth.sign({ id: "abc", exp: Date.now() + 1000 });
  assert.strictEqual(auth.verify(token).id, "abc");
  const [, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ id: "admin", exp: Date.now() + 1000 })).toString("base64url");
  assert.strictEqual(auth.verify(`${forged}.${mac}`), null);
  assert.strictEqual(auth.verify(auth.sign({ id: "abc", exp: Date.now() - 1 })), null);
  assert.strictEqual(auth.verify("garbage"), null);
});

test("PINs are hashed, verified, and lock after repeated failures", () => {
  const team = tmpTeam();
  const dor = team.addMember("דור", "482193", "admin");
  assert.ok(!JSON.stringify(team.data).includes("482193"), "PIN must not be stored in clear text");
  assert.strictEqual(team.verifyPin(dor.id, "482193").member.name, "דור");
  for (let i = 0; i < 4; i++) assert.strictEqual(team.verifyPin(dor.id, "000000").error, "wrong_pin");
  assert.strictEqual(team.verifyPin(dor.id, "000000").error, "locked");
  assert.strictEqual(team.verifyPin(dor.id, "482193").error, "locked", "correct PIN refused while locked");
});

test("owner code: resend keeps the same code, single use, limited attempts", () => {
  const team = tmpTeam();
  const code = team.createOtp();
  assert.match(code, /^\d{6}$/);
  assert.strictEqual(team.createOtp(), code, "send again re-sends the same code");
  const wrong = code === "999999" ? "111111" : "999999";
  assert.deepStrictEqual(team.checkOtp(wrong), { error: "wrong_code", left: 4 });
  assert.deepStrictEqual(team.checkOtp(` ${code.slice(0, 3)} ${code.slice(3)} `), { ok: true }, "spaces tolerated");
  assert.strictEqual(team.checkOtp(code).error, "no_code", "second use rejected");
  const c2 = team.createOtp();
  for (let i = 0; i < 5; i++) team.checkOtp("abcdef");
  assert.strictEqual(team.checkOtp(c2).error, "too_many");
  assert.notStrictEqual(team.createOtp(), undefined, "a fresh code can be requested after lockout");
});

test("Arabic-Indic digits are accepted for PINs and codes", () => {
  const { normalizeDigits } = require("../lib/team");
  assert.strictEqual(normalizeDigits("٠٥٥٧٦٨"), "055768");
  const team = tmpTeam();
  const m = team.addMember("שני", "055768");
  assert.ok(team.verifyPin(m.id, "٠٥٥٧٦٨").member);
});

test("invites are single use; admin can't be removed; names unique", () => {
  const team = tmpTeam();
  const dor = team.addMember("דור", "111111", "admin");
  const { token } = team.createInvite(dor.id);
  assert.ok(team.findInvite(token));
  assert.strictEqual(team.useInvite(token), true);
  assert.strictEqual(team.useInvite(token), false);
  assert.strictEqual(team.nameTaken(" דור "), true);
  const shani = team.addMember("שני", "222222");
  assert.strictEqual(team.remove(dor.id), false);
  assert.strictEqual(team.remove(shani.id), true);
});

test("requireTeam: valid cookie passes, removed member is cut off", () => {
  const team = tmpTeam();
  const shani = team.addMember("שני", "222222");
  const mw = auth.requireTeam(team);
  const cookie = `x=1; lia_team=${encodeURIComponent(auth.sign({ id: shani.id, exp: Date.now() + 1000 }))}`;
  let status = null;
  const res = { status(s) { status = s; return this; }, json() {} };
  const req = { headers: { cookie } };
  mw(req, res, () => { status = "next"; });
  assert.strictEqual(status, "next");
  assert.strictEqual(req.member.name, "שני");
  team.remove(shani.id);
  mw({ headers: { cookie } }, res, () => { status = "next"; });
  assert.strictEqual(status, 401);
});
