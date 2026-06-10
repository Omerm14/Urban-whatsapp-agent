const crypto = require("crypto");

// Verifies Meta's X-Hub-Signature-256 header against the RAW request body.
// Returns { ok, reason }.
//
// Fails OPEN when META_APP_SECRET is not configured, so the live webhook keeps
// working during the migration window (logged loudly by the caller). Once the
// secret is set in Railway, an invalid/missing signature is rejected.
function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    return { ok: true, reason: "no-secret-configured" };
  }

  const header = req.get("x-hub-signature-256") || "";
  const rawBody = req.rawBody;
  if (!header || !rawBody) {
    return { ok: false, reason: "missing-signature-or-body" };
  }

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature-mismatch" };
  }

  return { ok: true, reason: "verified" };
}

module.exports = { verifyMetaSignature };
