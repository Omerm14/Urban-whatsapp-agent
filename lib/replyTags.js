// Parses the control tags Claude may put in Lia's reply.
//
//   [ESCALATE]              — Lia doesn't know; nothing is sent to the customer
//   [HANDOFF: <summary>]    — hand the conversation to the team; the rest of the
//                             text is sent to the customer, the summary goes to Dor
function parseReply(raw) {
  const text = String(raw || "");
  if (text.includes("[ESCALATE]")) {
    return { escalate: true, handoff: null, text: "" };
  }
  let handoff = null;
  const cleaned = text.replace(/\[HANDOFF(?::([^\]]*))?\]/g, (_, summary) => {
    handoff = (summary || "").trim();
    return "";
  });
  return {
    escalate: false,
    handoff: handoff === null ? null : { summary: handoff },
    text: cleaned.replace(/[ \t]+\n/g, "\n").trim(),
  };
}

module.exports = { parseReply };
