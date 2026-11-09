// Web Push to the owner's phone (Dor) from the /app PWA.
//
// Works on Android Chrome, and on iPhone only once the app was added to the
// Home Screen (iOS 16.4+). Subscriptions are stored per team member id in
// DATA_DIR/push.json; only the owner is notified — the team admin (Dor), or
// the member named in PUSH_OWNER.
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

class PushService {
  constructor(dataDir) {
    this.file = path.join(dataDir, "push.json");
    this.subs = {}; // memberName -> [subscription]
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

  // Set by index.js once the team store exists: () => member id of the owner.
  ownerKey() { return this.resolveOwner ? this.resolveOwner() : null; }

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

  // payload: { title, body, url, tag }
  // Returns { devices, sent, removed, errors } and remembers the last attempt.
  async notifyOwner(payload) {
    const result = { devices: 0, sent: 0, removed: 0, errors: [] };
    if (!this.enabled) { result.errors.push("push disabled (VAPID keys missing)"); return this.remember(result); }
    const name = this.ownerKey();
    if (!name) { result.errors.push("no owner"); return this.remember(result); }
    const list = this.subs[name] || [];
    result.devices = list.length;
    if (list.length === 0) return this.remember(result);
    const body = JSON.stringify(payload);
    const dead = [];
    await Promise.all(list.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, body, { TTL: 60 * 60, urgency: "high" });
        result.sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
        const msg = `${err.statusCode || ""} ${err.body || err.message}`.trim();
        result.errors.push(msg);
        console.error("Push failed:", msg);
      }
    }));
    if (dead.length) {
      this.subs[name] = list.filter(s => !dead.includes(s.endpoint));
      this.save();
      result.removed = dead.length;
      console.log(`🔕 Removed ${dead.length} expired push subscription(s)`);
    }
    return this.remember(result);
  }

  remember(result) {
    this.last = { at: new Date().toISOString(), ...result };
    return result;
  }
}

module.exports = { PushService };
