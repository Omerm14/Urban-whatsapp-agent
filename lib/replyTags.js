// Parses the control tags Claude may put in Lia's reply.
//
//   [ESCALATE]              — Lia doesn't know; nothing is sent to the customer
//   [HANDOFF: <summary>]    — hand the conversation to the team; the rest of the
//                             text is sent to the customer, the summary goes to Dor
//   [END]                   — the customer is wrapping up (thanks / goodbye); the
//                             conversation closes and no follow-up is sent
function parseReply(raw) {
  const text = String(raw || "");
  if (text.includes("[ESCALATE]")) {
    return { escalate: true, end: false, handoff: null, text: "" };
  }
  let handoff = null;
  const end = /\[END\]/.test(text);
  const cleaned = text.replace(/\[END\]/g, "").replace(/\[HANDOFF(?::([^\]]*))?\]/g, (_, summary) => {
    handoff = (summary || "").trim();
    return "";
  });
  return {
    escalate: false,
    end,
    handoff: handoff === null ? null : { summary: handoff },
    text: cleaned.replace(/[ \t]+\n/g, "\n").trim(),
  };
}

module.exports = { parseReply };
