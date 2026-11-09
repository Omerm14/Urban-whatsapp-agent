// Sessions for the /app PWA.
//
// Members and their PINs live in lib/team.js (DATA_DIR/team.json). Logging in
// sets a signed, httpOnly cookie carrying the member id; every request looks
// the member up again, so removing someone from the team cuts access at once.
const crypto = require("crypto");

const COOKIE = "lia_team";
const MAX_AGE_S = 90 * 24 * 60 * 60;

function secret() {
  // Prefer a dedicated secret; fall back to the existing verify token so the
  // app works without extra configuration.
  return process.env.APP_SECRET || process.env.WEBHOOK_VERIFY_TOKEN || "dev-only-secret";
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
  const token = sign({ id: member.id, exp: Date.now() + MAX_AGE_S * 1000 });
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
    if (!m) return res.status(401).json({ error: "unauthorized" });
    req.member = { id: m.id, name: m.name, role: m.role };
    next();
  };
}

function requireAdmin(req, res, next) {
  if (req.member?.role !== "admin") return res.status(403).json({ error: "admin_only" });
  next();
}

module.exports = { sign, verify, setSessionCookie, clearSessionCookie, requireTeam, requireAdmin };
