require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(express.json());

const KB = JSON.parse(fs.readFileSync("kb.json", "utf8"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversations = {};

const SYSTEM_PROMPT = `את סוכנת שירות לקוחות של אורבן בייקרי. דברי תמיד בעברית, בלשון נקבה. הטון שלך חם, יומיומי ואנושי — לא רובוטי, לא ציני, ולא חצוף.

בסיס ידע:
${KB.faq.map((qa) => `שאלה: ${qa.question}\nתשובה: ${qa.answer}`).join("\n---\n")}

חוקים חשובים:
1. התחילי כל תשובה בשורה: "Confidence: XX%" (0–100) — בלי טקסט נוסף בשורה הזו
2. אחר כך תני את התשובה בעברית
3. אם הביטחון שלך נמוך מ-70%, כתבי בדיוק: "Confidence: 20%\\nאני לא בטוחה בתשובה, עוד רגע מישהו מהצוות יחזור אלייך 😊"
4. אל תזכירי שאת AI
5. דברי בגוף נקבה בכל עת`;

// Detect topics that have fixed responses (skip Claude)
function detectIntent(text) {
  const t = text;
  if (/תפריט|משלוח|הזמנה|וולט|wolt|לאכול|מנות|מחיר|עלות/.test(t)) return "wolt";
  if (/שיתוף פעולה|ספק|לספק|סיפוק|בתי קפה|שיתוף/.test(t)) return "collab";
  if (/אירוע|מגש|אירוח|קייטרינג|catering|ארגון|חברה/.test(t)) return "catering";
  return null;
}

function buildFixedResponse(intent) {
  if (intent === "wolt") {
    return `לתפריט המלא ולהזמנת משלוח — הנה הקישור לוולט שלנו 🍽️\n${KB.business.wolt}`;
  }
  if (intent === "collab") {
    return `לשיתופי פעולה עסקיים, שלחי הודעה לדור ישירות:\n📞 ${KB.business.manager_whatsapp}`;
  }
  if (intent === "catering") {
    return `למגשי אירוח ואירועים עסקיים — שלחי הודעה לדור בוואטסאפ ויחזור אלייך בהקדם:\n📲 ${KB.business.manager_whatsapp}`;
  }
}

async function callClaude(conversationMessages) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: conversationMessages.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content[0].text;
}

async function sendWhatsAppMessage(phoneNumber, message) {
  const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        type: "text",
        text: { preview_url: false, body: message },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } }
    );
    console.log(`✉️  Sent to ${phoneNumber}`);
  } catch (error) {
    console.error("Failed to send:", error.response?.data || error.message);
  }
}

function logEscalation(customerName, phoneNumber, question) {
  const escalations = fs.existsSync("escalations.json")
    ? JSON.parse(fs.readFileSync("escalations.json", "utf8"))
    : [];
  escalations.push({
    timestamp: new Date().toISOString(),
    customer: customerName,
    phone: phoneNumber,
    question,
  });
  fs.writeFileSync("escalations.json", JSON.stringify(escalations, null, 2));
}

// Receive messages from WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message || !contact || message.type !== "text") {
      return res.status(200).send("OK");
    }

    const phoneNumber = message.from;
    const customerMessage = message.text.body;
    const customerName = contact.profile?.name || phoneNumber;

    console.log(`📱 ${customerName}: ${customerMessage}`);

    // Fixed-response routing (no Claude needed)
    const intent = detectIntent(customerMessage);
    if (intent) {
      const fixedReply = buildFixedResponse(intent);
      await sendWhatsAppMessage(phoneNumber, fixedReply);
      console.log(`🔀 Routed (${intent})`);
      return res.status(200).send("OK");
    }

    // Maintain conversation history
    if (!conversations[phoneNumber]) {
      conversations[phoneNumber] = { messages: [] };
    }
    const conv = conversations[phoneNumber];
    conv.messages.push({ role: "user", content: customerMessage });
    if (conv.messages.length > 10) {
      conv.messages = conv.messages.slice(-10);
    }

    // Call Claude
    const raw = await callClaude(conv.messages);

    const confidenceMatch = raw.match(/Confidence:\s*(\d+)/i);
    const confidence = confidenceMatch ? parseInt(confidenceMatch[1]) : 50;
    const answer = raw.replace(/^Confidence:\s*\d+%?\s*/i, "").trim();

    if (confidence >= 70) {
      await sendWhatsAppMessage(phoneNumber, answer);
      conv.messages.push({ role: "assistant", content: answer });
      console.log(`✅ Answered (${confidence}%)`);
    } else {
      // Escalate to Dor
      await sendWhatsAppMessage(
        process.env.MANAGER_PHONE,
        `❓ שאלה לא מוכרת\nמ: ${customerName}\nטלפון: ${phoneNumber}\nשאלה: ${customerMessage}\n\nענה כאן ואוסיף לבסיס הידע 📝`
      );
      logEscalation(customerName, phoneNumber, customerMessage);
      await sendWhatsAppMessage(
        phoneNumber,
        "אני לא בטוחה בתשובה, עוד רגע מישהו מהצוות יחזור אלייך 😊"
      );
      console.log(`⚠️  Escalated (${confidence}%)`);
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(200).send("OK");
  }
});

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", business: KB.business.name });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 ${KB.business.name} agent running on port ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
});
