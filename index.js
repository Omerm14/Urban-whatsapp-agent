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
const pendingEscalations = []; // { customerPhone, customerName, question, timestamp }

let websiteContent = null;

async function fetchWebsiteKB() {
  try {
    const res = await axios.get("https://urbanbakery.co", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "he,en;q=0.9",
      },
      timeout: 8000,
    });
    const text = res.data
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    console.log("🌐 Website content fetched successfully");
    return text;
  } catch (err) {
    console.log("🌐 Website fetch skipped:", err.message);
    return null;
  }
}

function buildSystemPrompt() {
  const websiteSection = websiteContent
    ? `\nמידע נוסף מהאתר הרשמי של אורבן בייקרי (urbanbakery.co):\n${websiteContent}\n`
    : "";

  return `שמך נועה, נציגת שירות הלקוחות של אורבן בייקרי. דברי תמיד בעברית.

הטון שלך: חם, ישיר, אנושי — כמו מישהי שמכירה את המקום ואוהבת אותו. לא פורמלי, לא רובוטי.

כללי שפה חשובים:
- **אסור** להתחיל תשובה במילים: "כמובן!", "בהחלט!", "ודאי!", "שמחה לעזור!", "אשמח לעזור!", "כן, בטח!"
- תשובות קצרות — 1 עד 3 משפטים. לא יותר.
- אל תחזרי על השאלה של הלקוח/ה בתשובה שלך
- אל תזכירי שאת AI — בכלל
- דברי בגוף נקבה כשמדברת על עצמך (גוף ראשון יחיד)
- כשאת מדברת בשם העסק (אנחנו / אורבן בייקרי) — השתמשי בלשון רבים ניטרלי: "פתוחים", "מחכים", "נשמחים" — לא "פתוחות", "מחכות"
- כשפונה ללקוח/ה, פני בלשון רבים: "תגיעו", "תשלחו" — לא "תגיע/י", "תשלח/י"
- נסי לזהות מגדר הלקוח/ה מהשיחה; אם לא ברור — פני בניטרלי או רבים
- גם כשהתשובה היא "לא" — אמרי אותה בחום ועם אלטרנטיבה. לעולם אל תגידי "לא" בלבד.
- אם ההודעה קצרה מאוד או לא ברורה — שאלי בנעימות מה הם מחפשים, במקום להשיב בביטחון נמוך

דוגמאות — רובוטי vs אנושי:
❌ "בהחלט! אנחנו פתוחות בימים ראשון עד חמישי בין השעות 07:00-19:00"
✅ "ראשון עד חמישי 7 עד 7, שישי ושבת עד 4 🙂"

❌ "לא, המקום לא כשר."
✅ "אנחנו לא כשרים, אבל יש לנו המון אפשרויות מדהימות — תפריט עשיר לכולם 😊"

❌ "כמובן שיש לנו אפשרויות טבעוניות! נשמח לפרט:"
✅ "יש! כריך אבוקדו, כרובית, עוגת בננות שוקולד... תגיעו ונעדכן על מה שיש היום 😊"

❌ "אני מבינה את תסכולך ואשמח לעזור"
✅ "אוי, מצטערת! בואו נסדר את זה"

בסיס ידע:
${KB.faq.map((qa) => `שאלה: ${qa.question}\nתשובה: ${qa.answer}`).join("\n---\n")}
${websiteSection}
חוקים חשובים לפורמט התשובה:
1. שורה ראשונה חייבת להיות **בדיוק**: "Confidence: XX%" (0–100) — בלי שום דבר לפניה
2. שורה שנייה ואילך: התשובה בעברית בלבד
3. אל תכתבי את המילה "Confidence" בשום מקום אחר בתשובה — רק בשורה הראשונה
4. אם השאלה נוגעת לשעות, כשרות, טבעוני, גלוטן, כתובת, הזמנת מקום — תמיד תשיבי מהבסיס ידע עם ביטחון גבוה (85%+)
5. אם הביטחון נמוך מ-55%, כתבי: "Confidence: 20%\nרגע, אני לא בטוחה — מישהו מהצוות יחזור אלייך עוד רגע 😊"`;
}

// Detect topics that have fixed responses (skip Claude)
function detectIntent(text) {
  const t = text.trim();
  if (/^(היי+|הי+|שלום|בוקר טוב|ערב טוב|צהריים טובים|מה נשמע|hey|hi)\s*[!?]*$/i.test(t)) return "greeting";
  if (/תפריט|משלוח|הזמנה|וולט|wolt|לאכול|מנות|מחיר|עלות/.test(t)) return "wolt";
  if (/שיתוף פעולה|ספק|לספק|סיפוק|בתי קפה|שיתוף/.test(t)) return "collab";
  if (/אירוע|מגש|אירוח|קייטרינג|catering|ארגון|חברה/.test(t)) return "catering";
  return null;
}

function buildFixedResponse(intent) {
  if (intent === "greeting") {
    return "הייי, נעים מאוד! 😊 איך אפשר לעזור?";
  }
  if (intent === "wolt") {
    return `לתפריט המלא ולהזמנת משלוח — הנה הקישור לוולט שלנו 🍽️\n${KB.business.wolt}`;
  }
  if (intent === "collab") {
    return `לשיתופי פעולה עסקיים, שלחו הודעה לדור ישירות:\n📞 ${KB.business.manager_whatsapp}`;
  }
  if (intent === "catering") {
    return `למגשי אירוח ואירועים עסקיים — שלחו הודעה לדור בוואטסאפ ויחזור אליכם בהקדם:\n📲 ${KB.business.manager_whatsapp}`;
  }
}

async function callClaude(conversationMessages) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: buildSystemPrompt(),
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

async function handleManagerReply(answer) {
  if (pendingEscalations.length === 0) {
    await sendWhatsAppMessage(process.env.MANAGER_PHONE, "אין שאלות ממתינות כרגע 🤷");
    return;
  }

  const pending = pendingEscalations.shift();

  await sendWhatsAppMessage(pending.customerPhone, answer);

  KB.faq.push({
    id: `custom_${Date.now()}`,
    question: pending.question,
    answer: answer,
  });
  fs.writeFileSync("kb.json", JSON.stringify(KB, null, 2));

  await sendWhatsAppMessage(
    process.env.MANAGER_PHONE,
    `✅ תשובה נשלחה ל${pending.customerName} ונוספה לבסיס הידע!`
  );

  console.log(`📚 KB updated: "${pending.question}"`);
}

// Strip confidence line wherever it appears and clean up separators
function extractAnswer(raw) {
  return raw
    .replace(/^Confidence:\s*\d+%?\s*\n?/im, "")
    .replace(/\n?Confidence:\s*\d+%?\s*/gim, "")
    .replace(/^---\s*\n?/gm, "")
    .trim();
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

    // Route manager replies to handleManagerReply
    const managerPhone = (process.env.MANAGER_PHONE || "").replace(/^\+/, "");
    if (phoneNumber === managerPhone) {
      await handleManagerReply(customerMessage);
      return res.status(200).send("OK");
    }

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
    const answer = extractAnswer(raw);

    if (confidence >= 55) {
      await sendWhatsAppMessage(phoneNumber, answer);
      conv.messages.push({ role: "assistant", content: answer });
      console.log(`✅ Answered (${confidence}%)`);
    } else {
      // Escalate to Dor
      pendingEscalations.push({
        customerPhone: phoneNumber,
        customerName: customerName,
        question: customerMessage,
        timestamp: new Date().toISOString(),
      });
      await sendWhatsAppMessage(
        process.env.MANAGER_PHONE,
        `❓ שאלה לא מוכרת\nמ: ${customerName}\nטלפון: ${phoneNumber}\nשאלה: ${customerMessage}\n\nענה כאן ואוסיף לבסיס הידע 📝`
      );
      logEscalation(customerName, phoneNumber, customerMessage);
      await sendWhatsAppMessage(
        phoneNumber,
        "רגע, אני לא בטוחה — מישהו מהצוות יחזור אלייך עוד רגע 😊"
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
app.listen(PORT, async () => {
  console.log(`🚀 ${KB.business.name} agent running on port ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
  websiteContent = await fetchWebsiteKB();
});
