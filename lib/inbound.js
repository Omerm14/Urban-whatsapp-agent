// Classifies an inbound WhatsApp message that isn't plain text, so the webhook
// knows how to record it and whom to tell. Pure — no I/O.
//
// kind:
//   "media"    — image / video / audio / voice / document / sticker (has a media id)
//   "location" / "contacts"
//   "reaction" — an emoji on an earlier message (target: message id, emoji: "" = removed)
//   "text"     — a button / list tap; `text` is what the customer chose
//   "welcome"  — the customer opened the chat (request_welcome); nothing to answer
//   "unsupported" — WhatsApp didn't pass the content (view-once, poll, edit…)
//   "unknown"  — a type we don't know yet

const MEDIA_LABELS = {
  image: "📷 תמונה", audio: "🎤 הקלטה", voice: "🎤 הקלטה", video: "🎥 סרטון",
  document: "📄 קובץ", sticker: "סטיקר",
};

// unsupported.type values we've seen documented / reported.
const UNSUPPORTED_LABELS = {
  edit: "✏️ הלקוח ערך הודעה — WhatsApp לא מעביר את הנוסח החדש",
  revoke: "🚫 הלקוח מחק הודעה",
  poll_creation: "📊 סקר — WhatsApp לא מעביר סקרים",
  poll: "📊 סקר — WhatsApp לא מעביר סקרים",
  view_once: "👁 תמונה/סרטון לצפייה חד-פעמית — WhatsApp לא מעביר אותם",
  event: "📅 הזמנה לאירוע — WhatsApp לא מעביר אותה",
};
const UNSUPPORTED_GENERIC = "⚠️ הודעה ש-WhatsApp לא מעביר (כנראה תמונה לצפייה חד-פעמית, סקר או הודעה שנערכה)";

// Label for a stored message (also used by the app for messages saved before this existed).
function labelFor(type, unsupportedType) {
  if (type === "unsupported") return UNSUPPORTED_LABELS[unsupportedType] || UNSUPPORTED_GENERIC;
  if (MEDIA_LABELS[type]) return MEDIA_LABELS[type];
  if (type === "location") return "📍 מיקום";
  if (type === "contacts") return "👤 איש קשר";
  return `הודעה (${type || "לא ידוע"})`;
}

function metaErrorOf(message) {
  const e = Array.isArray(message?.errors) ? message.errors[0] : null;
  if (!e) return null;
  return {
    code: e.code ?? null,
    title: e.title || e.message || null,
    details: e.error_data?.details || null,
  };
}

function describeInbound(message) {
  const type = message?.type;
  const part = (message && message[type]) || {};
  if (MEDIA_LABELS[type]) {
    return {
      kind: "media", type, label: MEDIA_LABELS[type] + (part.caption ? `: ${part.caption}` : ""),
      mediaId: part.id || null, mimeType: part.mime_type || null, filename: part.filename || null,
      caption: part.caption || null, notify: true,
    };
  }
  if (type === "location") {
    return {
      kind: "location", type, label: "📍 מיקום" + (part.name ? `: ${part.name}` : ""),
      location: { lat: part.latitude, lng: part.longitude, name: part.name || null, address: part.address || null },
      notify: true,
    };
  }
  if (type === "contacts") {
    const c = Array.isArray(message.contacts) ? message.contacts : [];
    const people = c.map(x => [x.name?.formatted_name, x.phones?.[0]?.phone].filter(Boolean).join(" ")).filter(Boolean);
    return { kind: "contacts", type, label: "👤 איש קשר" + (people.length ? `: ${people.join(", ")}` : ""), notify: true };
  }
  if (type === "reaction") {
    return { kind: "reaction", type, target: part.message_id || null, emoji: part.emoji || "", notify: false };
  }
  if (type === "button") {
    const text = part.text || part.payload || "";
    return text ? { kind: "text", type, text } : { kind: "unknown", type, label: labelFor(type), notify: true };
  }
  if (type === "interactive") {
    const r = part.button_reply || part.list_reply || part.nfm_reply || {};
    const text = r.title || r.body || "";
    return text ? { kind: "text", type, text } : { kind: "unknown", type, label: labelFor(type), notify: true };
  }
  if (type === "request_welcome") {
    return { kind: "welcome", type, label: "הלקוח פתח צ'אט", notify: false };
  }
  if (type === "unsupported") {
    const sub = part.type || null;
    // The original message (for edit / revoke), if Meta tells us which one.
    const target = message.context?.id || part.original_message_id || part.message_id || null;
    return {
      kind: "unsupported", type, unsupportedType: sub, target,
      label: labelFor(type, sub), metaError: metaErrorOf(message),
      // Edits / deletions: push only — no WhatsApp message to Dor.
      notify: true, whatsapp: sub !== "edit" && sub !== "revoke",
    };
  }
  return { kind: "unknown", type, label: labelFor(type), metaError: metaErrorOf(message), notify: true };
}

module.exports = { describeInbound, labelFor, MEDIA_LABELS };
