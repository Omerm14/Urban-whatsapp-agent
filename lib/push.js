// Web Push to the owner's phone (Dor) from the /app PWA.
//
// Works on Android Chrome, and on iPhone only once the app was added to the
// Home Screen (iOS 16.4+). Subscriptions are stored per team member id in
// DATA_DIR/push.json; every member switched on in "ניהול צוות" is notified
// (the admin by default, plus PUSH_OWNER by name if set).
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

class PushService {
  constructor(dataDir) {
    this.file = path.join(dataDir, "push.json");
    this.subs = {}; // memberId -> [subscription]
    try {
      if (fs.existsSync(this.file)) this.subs = JSON.parse(fs.readFileSync(this.file, "utf8")) || {};
    } catch { this.subs = {}; }

    this.publicKey = process.env.VAPID_PUBLIC_KEY || "";
    const privateKey = process.env.VAPID_PRIVATE_KEY || "";
    this.enabled = Boolean(this.publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:team@urbanbakery.co", this.publicKey, privateKey);
    } else {
      console.warn("🔕 VAPID keys not set — push notifications disabled");
    }
  }

  // Set by index.js once the team store exists: () => [member ids] who get push.
  recipients() { return this.resolveRecipients ? this.resolveRecipients() : []; }
  isRecipient(memberId) { return this.recipients().includes(memberId); }

  save() { fs.writeFileSync(this.file, JSON.stringify(this.subs, null, 2)); }

  subscribe(memberName, subscription) {
    if (!subscription || !subscription.endpoint) return false;
    const list = (this.subs[memberName] ||= []);
    if (!list.some(s => s.endpoint === subscription.endpoint)) {
      list.push(subscription);
      this.save();
    }
    return true;
  }

  unsubscribe(memberName, endpoint) {
    const list = this.subs[memberName] || [];
    this.subs[memberName] = list.filter(s => s.endpoint !== endpoint);
    this.save();
  }

  isSubscribed(memberName) { return (this.subs[memberName] || []).length > 0; }

  devices(memberId) { return (this.subs[memberId] || []).length; }

  // Push to every team member who gets notifications (or `only` these ids).
  // payload: { title, body, url, tag }
  // Returns { devices, sent, removed, errors, perMember } and remembers the last attempt.
  async notifyTeam(payload, { only } = {}) {
    const result = { devices: 0, sent: 0, removed: 0, errors: [], perMember: {} };
    if (!this.enabled) { result.errors.push("push disabled (VAPID keys missing)"); return this.remember(result); }
    const ids = only || this.recipients();
    if (!ids.length) { result.errors.push("no recipients"); return this.remember(result); }
    const body = JSON.stringify(payload);
    await Promise.all(ids.map(async (id) => {
      const list = this.subs[id] || [];
      const r = { devices: list.length, sent: 0, errors: [] };
      result.perMember[id] = r;
      result.devices += list.length;
      const dead = [];
      await Promise.all(list.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body, { TTL: 60 * 60, urgency: "high" });
          r.sent++; result.sent++;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
          const msg = `${err.statusCode || ""} ${err.body || err.message}`.trim();
          r.errors.push(msg); result.errors.push(msg);
          console.error("Push failed:", msg);
        }
      }));
      if (dead.length) {
        this.subs[id] = list.filter(s => !dead.includes(s.endpoint));
        this.save();
        result.removed += dead.length;
        console.log(`🔕 Removed ${dead.length} expired push subscription(s)`);
      }
    }));
    return this.remember(result);
  }

  remember(result) {
    this.last = { at: new Date().toISOString(), ...result };
    return result;
  }
}

module.exports = { PushService };
