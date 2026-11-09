// Sessions for the /app PWA.
//
// Members and their PINs live in lib/team.js (DATA_DIR/team.json). Logging in
// sets a signed, httpOnly cookie carrying the member id; every request looks
// the member up again, so removing someone from the team cuts access at once.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE = "lia_team";
const MAX_AGE_S = 90 * 24 * 60 * 60;

// Signing key: APP_SECRET if set, otherwise a random key generated once and
// kept on the volume (DATA_DIR/app_secret). Never a value that appears in the repo.
let generatedSecret = null;
function initSecret(dataDir) {
  if (process.env.APP_SECRET) return;
  const file = path.join(dataDir, "app_secret");
  try {
    if (fs.existsSync(file)) generatedSecret = fs.readFileSync(file, "utf8").trim();
    if (!generatedSecret || generatedSecret.length < 32) {
      generatedSecret = crypto.randomBytes(48).toString("base64url");
      fs.writeFileSync(file, generatedSecret, { mode: 0o600 });
    }
  } catch (e) {
    console.error("Could not persist app secret (sessions reset on restart):", e.message);
    generatedSecret = generatedSecret || crypto.randomBytes(48).toString("base64url");
  }
}
function secret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  if (!generatedSecret) generatedSecret = crypto.randomBytes(48).toString("base64url");
  return generatedSecret;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res, member) {
  const token = sign({ id: member.id, v: member.sessionVersion || 0, exp: Date.now() + MAX_AGE_S * 1000 });
  const secure = process.env.NODE_ENV === "development" ? "" : " Secure;";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${MAX_AGE_S}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Express middleware factory: attaches req.member = { id, name, role } or answers 401.
function requireTeam(team) {
  return (req, res, next) => {
    const payload = verify(readCookie(req, COOKIE));
    const m = payload && team.get(payload.id);
    // A PIN change bumps sessionVersion and signs out every other device.
    if (!m || (payload.v || 0) !== (m.sessionVersion || 0)) return res.status(401).json({ error: "unauthorized" });
    req.member = { id: m.id, name: m.name, role: m.role };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.member?.role !== "admin") return res.status(403).json({ error: "admin_only" });
  next();
}

module.exports = { initSecret, sign, verify, setSessionCookie, clearSessionCookie, requireTeam, requireAdmin };
