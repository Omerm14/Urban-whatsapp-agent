// Tracks when the morning template last went to the manager, so a redeploy
// doesn't send another one if one already went out recently.
const fs = require("fs");

const MIN_GAP_MS = 20 * 60 * 60 * 1000;

function lastPingAt(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")).lastAt || 0; } catch { return 0; }
}

function shouldSendStartupPing(file, now = Date.now()) {
  return now - lastPingAt(file) > MIN_GAP_MS;
}

function recordPing(file, now = Date.now()) {
  try { fs.writeFileSync(file, JSON.stringify({ lastAt: now })); } catch (e) { console.error("ping record failed:", e.message); }
}

module.exports = { shouldSendStartupPing, recordPing, lastPingAt };
