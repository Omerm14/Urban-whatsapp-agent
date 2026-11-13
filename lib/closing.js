// Detecting the end of a conversation, and deciding whether Lia's single
// "anything else?" follow-up is appropriate. Keeps Lia from "digging" after
// a customer has already said thanks / goodbye.

// Short sign-off phrases (Hebrew + English). Matched as whole words.
// (Not "בוקר טוב"/"ערב טוב" — those usually open a conversation.)
const CLOSING_WORDS = [
  "תודה", "תודה רבה", "תודות", "תנקס", "שבת שלום", "שבוע טוב", "סופ\"ש נעים", "סופש נעים", "סופ״ש נעים",
  "לילה טוב", "יום טוב", "ביי", "ביביי", "להתראות", "נתראה", "סבבה", "מעולה", "אחלה",
  "יופי", "אוקיי", "אוקי", "אוקיי תודה", "קיבלתי", "מושלם", "מצוין", "בסדר", "בכיף", "חג שמח", "שבוע מבורך",
  "thanks", "thank you", "thx", "ok", "okay", "bye", "great", "perfect", "cool", "cheers", "have a good day",
];
const FILLER = ["רבה", "ענקית", "מאוד", "לך", "לכם", "גם", "ו", "וגם", "!", ".", ",", "so", "much", "you", "a", "lot"];

// Pictographic emoji / hearts / thumbs etc.
const EMOJI_RE = /[\p{Extended_Pictographic}❤️‍]/gu;

function normalize(text) {
  return String(text || "").toLowerCase().replace(EMOJI_RE, " ").replace(/[!.,~?…:;()\-–—"'״׳]+/g, " ").replace(/\s+/g, " ").trim();
}

// True for a short message that only says thanks / goodbye / ok (or just emoji).
function isClosingMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (/\?|？/.test(raw)) return false; // a question keeps the conversation going
  const plain = normalize(raw);
  if (!plain) return true; // emoji only (❤️ 👍 🙏)
  const words = plain.split(" ");
  if (words.length > 6) return false;
  // Remove known sign-off phrases (longest first), then filler words; nothing else may remain.
  let rest = ` ${plain} `;
  for (const p of [...CLOSING_WORDS].sort((a, b) => b.length - a.length)) {
    rest = rest.split(` ${normalize(p)} `).join(" ");
    rest = rest.replace(new RegExp(`(^| )ו${normalize(p)}( |$)`, "g"), " ");
  }
  const left = rest.trim().split(" ").filter(w => w && !FILLER.includes(w));
  return left.length === 0 && rest.trim() !== plain;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Should Lia send her one "anything else?" now? conv: the stored conversation.
function shouldFollowUp(conv, now = Date.now(), silenceMs = 10 * 60 * 1000) {
  if (!conv || conv.humanMode || conv.conversationClosed) return false;
  if (conv.followUpSentAt || conv.followUpAsked) return false;
  if (conv.lastFollowUpAt && now - new Date(conv.lastFollowUpAt).getTime() < DAY_MS) return false;
  if (!conv.lastSeen || now - new Date(conv.lastSeen).getTime() < silenceMs) return false;
  const msgs = (conv.messages || []).filter(m => m.sender !== "system");
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== "assistant" || last.sender === "team") return false; // only after Lia answered
  if (last.closing) return false;                         // Lia already said goodbye ([END])
  if (/\?\s*\S{0,3}\s*$/.test(String(last.content || ""))) return false; // Lia asked; she's waiting
  if (isClosingMessage(last.content)) return false;
  const lastUser = [...msgs].reverse().find(m => m.role === "user");
  if (lastUser && isClosingMessage(lastUser.content)) return false;
  return true;
}

// Natural, pre-written follow-ups (no model call → no odd phrasing).
const FOLLOW_UPS_HE = ["צריכים עוד משהו?", "יש עוד שאלות?", "עוד משהו?", "אפשר לעזור בעוד משהו?"];
const FOLLOW_UPS_EN = ["Need anything else?", "Anything else?", "Any other questions?"];
function followUpText(conv) {
  const lastUser = [...(conv.messages || [])].reverse().find(m => m.role === "user");
  const t = String(lastUser?.content || "");
  const english = (t.match(/[a-zA-Z]/g) || []).length / (t.length || 1) > 0.5;
  const list = english ? FOLLOW_UPS_EN : FOLLOW_UPS_HE;
  const n = (conv.followUpCount || 0) % list.length;
  return list[n];
}

module.exports = { isClosingMessage, shouldFollowUp, followUpText };
