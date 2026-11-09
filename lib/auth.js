// Team login for the /app PWA.
//
// Each manager gets a personal code via TEAM_CODES ("דור:4821,שני:7310").
// Logging in sets a signed, httpOnly cookie that identifies who is writing, so
// every outgoing message can be labeled with the manager's name.
const crypto = require("crypto");

const COOKIE = "lia_team";
const MAX_AGE_S = 90 * 24 * 60 * 60;

function parseTeamCodes(raw) {
  const team = [];
  for (const part of String(raw || "").split(",")) {
    const idx = part.lastIndexOf(":");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const code = part.slice(idx + 1).trim();
    if (name && code) team.push({ name, code });
  }
  return team;
}

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

function codesEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Returns the team member for a code, or null.
function login(code, team = parseTeamCodes(process.env.TEAM_CODES)) {
  const c = String(code || "").trim();
  if (!c) return null;
  return team.find(m => codesEqual(m.code, c)) || null;
}

function setSessionCookie(res, member) {
  const token = sign({ name: member.name, exp: Date.now() + MAX_AGE_S * 1000 });
  const secure = process.env.NODE_ENV === "development" ? "" : " Secure;";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${MAX_AGE_S}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Express middleware: attaches req.member = { name } or answers 401.
// A member removed from TEAM_CODES loses access on the next request.
function requireTeam(req, res, next) {
  const payload = verify(readCookie(req, COOKIE));
  const team = parseTeamCodes(process.env.TEAM_CODES);
  if (!payload || !team.some(m => m.name === payload.name)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  req.member = { name: payload.name };
  next();
}

module.exports = { parseTeamCodes, sign, verify, login, setSessionCookie, clearSessionCookie, requireTeam };
