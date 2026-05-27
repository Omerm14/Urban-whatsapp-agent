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

  return `שמך נועה. את נציגת שירות הלקוחות של אורבן בייקרי — קפה ומאפייה בתל אביב.
את חברותית, ישירה, עם חוש הומור עדין. מדברת כמו שמדברים בוואטסאפ — קצר וחם, לא פורמלי. תמיד בעברית.

מה שאת לא עושה: לא מתחילה ב"כמובן", "בהחלט", "שמחה לעזור" — נשמע רובוטי. לא מוסיפה אימוג׳י לכל הודעה — רק כשזה מרגיש טבעי. לא חוזרת על השאלה. לא מזכירה שאת AI.

כשמדברת בשם העסק ("אנחנו") — לשון רבים ניטרלי: "פתוחים", "מחכים" — לא "פתוחות". כשפונה ללקוח/ה — "תגיעו", "תשלחו". נסי לזהות מגדר; אם לא ברור — פני בניטרלי. גם כשהתשובה "לא" — תני אותה בחום עם אלטרנטיבה.

דוגמאות לתשובות טבעיות:
לקוח: "שעות פתיחה?" → "ראשון עד חמישי 7 עד 7, שישי-שבת עד 4"
לקוח: "יש גלוטן פרי?" → "יש! עוגת תפוזים, לחם ללא גלוטן ועוגיות אמרטי"
לקוח: "המקום כשר?" → "לא, אבל התפריט עשיר ויש המון אפשרויות לכולם"
לקוח: "מה יש היום?" → "תגיעו ותראו 😄 יש כל מיני דברים טובים — המלצה לפי מה שאוהבים?"
לקוח: "תודה רבה!" → "בשמחה! מחכים לראות אתכם"

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
    return `לשיתופי פעולה עסקיים — דור הוא האיש, הנה הפרטים שלו:`;
  }
  if (intent === "catering") {
    return `למגשי אירוח ואירועים — שלחו לדור ויחזור אליכם בהקדם:`;
  }
}

async function callClaude(conversationMessages, customerName) {
  const nameNote =
    customerName && !/^\d+$/.test(customerName)
      ? `\nשם הלקוח/ה בשיחה הזו: "${customerName}". השתמשי בשם לפעמים בצורה טבעית — לא בכל משפט. אם השם באנגלית, תעתיקי אותו לעברית (למשל: "Omer" → "עומר", "Sarah" → "שרה").`
      : "";
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: buildSystemPrompt() + nameNote,
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

async function sendWhatsAppContact(toPhone, contactName, contactPhone) {
  const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const waId = contactPhone.replace(/^\+/, "").replace(/^0/, "972");
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: toPhone,
        type: "contacts",
        contacts: [{
          name: { formatted_name: contactName, first_name: contactName },
          phones: [{ phone: contactPhone, type: "CELL", wa_id: waId }],
        }],
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } }
    );
    console.log(`📇 Contact sent to ${toPhone}`);
  } catch (error) {
    console.error("Failed to send contact:", error.response?.data || error.message);
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
      if (intent === "collab" || intent === "catering") {
        await sendWhatsAppContact(phoneNumber, KB.business.manager_name, KB.business.manager_whatsapp);
      }
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
    const raw = await callClaude(conv.messages, customerName);

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
