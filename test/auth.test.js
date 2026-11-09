const test = require("node:test");
const assert = require("node:assert");

process.env.APP_SECRET = "test-secret";
process.env.TEAM_CODES = "דור:4821, שני:7310";
const auth = require("../lib/auth");

test("parseTeamCodes", () => {
  assert.deepStrictEqual(auth.parseTeamCodes(process.env.TEAM_CODES), [
    { name: "דור", code: "4821" }, { name: "שני", code: "7310" },
  ]);
});

test("login matches a code to its member", () => {
  assert.strictEqual(auth.login("7310").name, "שני");
  assert.strictEqual(auth.login("0000"), null);
  assert.strictEqual(auth.login(""), null);
});

test("signed session round-trips and rejects tampering/expiry", () => {
  const token = auth.sign({ name: "דור", exp: Date.now() + 1000 });
  assert.strictEqual(auth.verify(token).name, "דור");
  const [body, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ name: "שני", exp: Date.now() + 1000 })).toString("base64url");
  assert.strictEqual(auth.verify(`${forged}.${mac}`), null);
  assert.strictEqual(auth.verify(auth.sign({ name: "דור", exp: Date.now() - 1 })), null);
  assert.strictEqual(auth.verify("garbage"), null);
});

test("requireTeam rejects members removed from TEAM_CODES", () => {
  const token = auth.sign({ name: "יוסי", exp: Date.now() + 1000 });
  let status = null;
  const res = { status(s) { status = s; return this; }, json() {} };
  auth.requireTeam({ headers: { cookie: `lia_team=${encodeURIComponent(token)}` } }, res, () => { status = "next"; });
  assert.strictEqual(status, 401);
  const ok = auth.sign({ name: "שני", exp: Date.now() + 1000 });
  const req = { headers: { cookie: `x=1; lia_team=${encodeURIComponent(ok)}` } };
  auth.requireTeam(req, res, () => { status = "next"; });
  assert.strictEqual(status, "next");
  assert.strictEqual(req.member.name, "שני");
});
