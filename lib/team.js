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

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString("hex");
const safeEqualHex = (a, b) => {
  const x = Buffer.from(String(a), "hex"), y = Buffer.from(String(b), "hex");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const isPin = (pin) => /^\d{6}$/.test(String(pin || ""));
const cleanName = (name) => String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);

class TeamStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "team.json");
    this.data = { members: [], invites: [], otp: null };
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
  verifyPin(id, pin) {
    const m = this.data.members.find(x => x.id === id);
    if (!m) return { error: "not_found" };
    if (m.lockedUntil && m.lockedUntil > Date.now()) return { error: "locked" };
    if (isPin(pin) && safeEqualHex(hashPin(pin, m.salt), m.pinHash)) {
      if (m.failed || m.lockedUntil) { m.failed = 0; m.lockedUntil = null; this.save(); }
      return { member: m };
    }
    m.failed = (m.failed || 0) + 1;
    if (m.failed >= LOCK_AFTER) { m.lockedUntil = Date.now() + LOCK_MS; m.failed = 0; }
    this.save();
    return { error: m.lockedUntil && m.lockedUntil > Date.now() ? "locked" : "wrong_pin" };
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
    m.failed = 0; m.lockedUntil = null;
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
  createOtp() {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    const salt = crypto.randomBytes(16).toString("hex");
    this.data.otp = { salt, hash: hashPin(code, salt), expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 };
    this.save();
    return code;
  }

  // Single use. Returns true when the code matches and hasn't expired.
  checkOtp(code) {
    const o = this.data.otp;
    if (!o || o.expiresAt < Date.now() || o.attempts >= OTP_MAX_ATTEMPTS) return false;
    if (isPin(code) && safeEqualHex(hashPin(code, o.salt), o.hash)) {
      this.data.otp = null; this.save();
      return true;
    }
    o.attempts++; this.save();
    return false;
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

module.exports = { TeamStore, isPin, cleanName };
