// Team members for the /app PWA, stored in DATA_DIR/team.json.
//
// Nobody configures passwords in Railway:
//  • First setup: a 6-digit code is sent to the owner's WhatsApp (MANAGER_PHONE);
//    whoever enters it picks a name + 6-digit PIN and becomes the admin.
//    The same flow resets the admin's PIN ("שכחתי קוד").
//  • Everyone else joins through a one-time invite link the admin creates
//    (valid 48h) and picks their own name + PIN.
// PINs are stored as scrypt hashes; repeated wrong PINs lock the member briefly.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

const hashPin = (pin, salt) => crypto.scryptSync(normalizeDigits(pin), salt, 32).toString("hex");
const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
// Keyboards / paste can bring spaces, dashes or non-ASCII digits (e.g. Arabic-Indic).
function normalizeDigits(v) {
  return String(v || "")
    .replace(/[\u0660-\u0669]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/\D/g, "");
}
const isPin = (pin) => /^\d{6}$/.test(normalizeDigits(pin));
const cleanName = (name) => String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);

class TeamStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "team.json");
    this.data = { members: [], invites: [], otp: null };
    this.failures = new Map(); // `${ip}|${memberId}` -> { count, lockedUntil }
    try {
      if (fs.existsSync(this.file)) this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch (e) { console.error("team.json unreadable:", e.message); }
  }

  save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.data, null, 2));
    fs.renameSync(this.file + ".tmp", this.file);
  }

  members() { return this.data.members.map(({ id, name, role, createdAt }) => ({ id, name, role, createdAt })); }
  get(id) { return this.data.members.find(m => m.id === id) || null; }
  admin() { return this.data.members.find(m => m.role === "admin") || null; }
  hasAdmin() { return Boolean(this.admin()); }
  nameTaken(name, exceptId) {
    const n = cleanName(name).toLowerCase();
    return this.data.members.some(m => m.id !== exceptId && m.name.toLowerCase() === n);
  }

  // ── PIN login ──
  // Returns { member } or { error: "wrong_pin" | "locked" | "not_found" }.
  // Lockout is per device/IP + member (in memory), so a stranger who knows a
  // member id can't lock that member out of every phone.
  verifyPin(id, pin, who = "local") {
    const m = this.data.members.find(x => x.id === id);
    if (!m) return { error: "not_found" };
    const key = `${who}|${id}`;
    const f = this.failures.get(key);
    if (f && f.lockedUntil > Date.now()) return { error: "locked" };
    if (isPin(pin) && safeEqualHex(hashPin(pin, m.salt), m.pinHash)) {
      this.failures.delete(key);
      return { member: m };
    }
    const n = (f && f.lockedUntil <= Date.now() && f.lockedUntil ? 0 : (f?.count || 0)) + 1;
    if (n >= LOCK_AFTER) { this.failures.set(key, { count: 0, lockedUntil: Date.now() + LOCK_MS }); return { error: "locked" }; }
    this.failures.set(key, { count: n, lockedUntil: 0 });
    return { error: "wrong_pin" };
  }

  addMember(name, pin, role = "member") {
    const salt = crypto.randomBytes(16).toString("hex");
    const m = {
      id: crypto.randomBytes(8).toString("hex"), name: cleanName(name), role,
      salt, pinHash: hashPin(pin, salt), createdAt: new Date().toISOString(),
    };
    this.data.members.push(m);
    this.save();
    return m;
  }

  setPin(id, pin) {
    const m = this.get(id);
    if (!m) return null;
    m.salt = crypto.randomBytes(16).toString("hex");
    m.pinHash = hashPin(pin, m.salt);
    m.sessionVersion = (m.sessionVersion || 0) + 1; // sign out other devices
    delete m.failed; delete m.lockedUntil;
    this.save();
    return m;
  }

  remove(id) {
    const m = this.get(id);
    if (!m || m.role === "admin") return false;
    this.data.members = this.data.members.filter(x => x.id !== id);
    this.save();
    return true;
  }

  // ── Owner verification code (first setup / admin PIN reset) ──
  // "Send again" re-sends the SAME code while it's still valid, so whichever
  // WhatsApp message the owner reads, the code in it works.
  createOtp() {
    const o = this.data.otp;
    if (o && o.code && o.expiresAt > Date.now() && o.attempts < OTP_MAX_ATTEMPTS) return o.code;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    this.data.otp = { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
    this.save();
    return code;
  }

  // Single use. Returns { ok } or { error: "no_code" | "expired" | "too_many" | "wrong_code" }.
  checkOtp(input) {
    const code = normalizeDigits(input);
    const o = this.data.otp;
    if (!o || !o.code) return { error: "no_code" };
    if (o.expiresAt < Date.now()) return { error: "expired" };
    if (o.attempts >= OTP_MAX_ATTEMPTS) return { error: "too_many" };
    const a = Buffer.from(code), b = Buffer.from(o.code);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      this.data.otp = null; this.save();
      return { ok: true };
    }
    o.attempts++; this.save();
    return { error: o.attempts >= OTP_MAX_ATTEMPTS ? "too_many" : "wrong_code", left: OTP_MAX_ATTEMPTS - o.attempts };
  }

  // ── Invites ──
  createInvite(createdBy) {
    const token = crypto.randomBytes(24).toString("base64url");
    this.data.invites = this.data.invites.filter(i => i.expiresAt > Date.now());
    this.data.invites.push({ token, createdBy, expiresAt: Date.now() + INVITE_TTL_MS });
    this.save();
    return { token, expiresAt: Date.now() + INVITE_TTL_MS };
  }

  findInvite(token) {
    return this.data.invites.find(i => typeof token === "string" && i.token === token && i.expiresAt > Date.now()) || null;
  }

  useInvite(token) {
    const inv = this.findInvite(token);
    if (!inv) return false;
    this.data.invites = this.data.invites.filter(i => i.token !== token);
    this.save();
    return true;
  }
}

module.exports = { TeamStore, isPin, cleanName, normalizeDigits };
