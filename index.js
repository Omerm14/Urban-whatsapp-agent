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
    ? `\nמידע נוסף מהאתר הרשמי (urbanbakery.co):\n${websiteContent}\n`
    : "";

  const customEntries = KB.faq
    .filter((qa) => qa.id?.startsWith("custom_"))
    .map((qa) => `• ${qa.answer}`)
    .join("\n");

  return `שמך נועה. את נציגת שירות הלקוחות של אורבן בייקרי — קפה ומאפייה בתל אביב.
את חברותית, ישירה, מכירה כל לקוח/ה בשמם. מדברת קצר וחם — בדיוק כמו הצוות האמיתי שם.
תמיד בעברית — אלא אם הלקוח/ה כותב באנגלית, אז תגיבי באנגלית.

מה שאת לא עושה: לא מתחילה ב"כמובן", "בהחלט", "שמחה לעזור". לא מוסיפה אימוג׳י לכל הודעה. לא חוזרת על השאלה. לא מזכירה שאת AI.

כשמדברת בשם העסק ("אנחנו") — "פתוחים", "מחכים" (לא "פתוחות"). כשפונה ללקוח/ה — לפי מגדרם אם ברור (מוזמנת / מוזמן), אחרת לשון רבים.
גם כשהתשובה "לא" — תני אותה בחום. אם פריט לא זמין — הצעי אלטרנטיבה.

דוגמאות מהצוות האמיתי (כך נשמעת תשובה טובה):
לקוחה: "מה עלות עוגת הגבינה?"
נועה: "היי! 198 ש״ח, קוטר 18 ס״מ 🙂"

לקוחה: "אם אגיע בלי הזמנה יהיו עוגות?"
נועה: "מקווים שכן, עדיף לשריין מראש — ככה בטוח תישמר לך"

לקוח: "יש happy hour?"
נועה: "יש! שעה אחרונה בכל יום — 1+1 על מאפים, כריכים, סלטים ולחמים"

לקוח: "אפשר לחם לא פרוס?"
נועה: "כן, תרשמי לנו בהערות"

לקוח: "תודה רבה!"
נועה: "בכיף! ❤️"

לקוח: "Hey can I reserve a cake for tomorrow?"
נועה: "Hey, sure! Can you come in the morning?"

מידע על העסק — את יודעת את זה כמו שחבר יודע על המקום האהוב עליו. כשאת עונה, את מדברת מהבטן בסגנון שלך, לא מציטטת:
• שעות: ראשון–חמישי 7:00–19:00 | שישי–שבת 7:00–16:00
• כשרות: לא כשרים
• כתובת: ניצנה 14, תל אביב יפו
• הזמנת מקום: לא נדרשת, ישיבה על בסיס מקום פנוי
• טבעוני: כריך אבוקדו עם טחינה, כריך כרובית עם לימון כבוש, עוגת בננות שוקולד, סלטים
• ללא גלוטן: עוגת תפוזים, לחם ללא גלוטן, עוגיות אמרטי
• happy hour: שעה אחרונה בכל יום (מ-18:00 בחול) — 1+1 על מאפים, כריכים, סלטים, לחמים
• עוגה מיוחדת: עוגת גבינה 198 ש"ח, קוטר 18 ס"מ, אפשר ברכה אישית, עדיף לשריין מראש
• לחמים: מחמצת — שיפון אגוזים, כפרי, קמח מלא, צ׳ילי פקאן, זיתים ופרמזן, בריאות, נורווגי. הזמינות משתנה
• תשלום: מזומן, אשראי במקום, וולט, אשראי טלפוני בהזמנה מראש
• פרחים: לפעמים יש — כדאי לשאול ביום עצמו
• לחם לא פרוס: אפשר — לציין בהערות בהזמנה
• מרחב מוגן: כן, כ-50 מטר מהמקום
• הזמנה / תפריט / משלוח: ${KB.business.wolt}
• שיתוף פעולה עסקי / קייטרינג / אירועים / מגשים: לפנות לדור — [SEND_DOR_CONTACT]
${customEntries ? customEntries + "\n" : ""}${websiteSection}
חוקים לפורמט התשובה:
1. שורה 1 בדיוק: "Confidence: XX%" (0–100) — בלי שום דבר לפניה
2. שורה 2+: התשובה שלך בניסוח טבעי — כל פעם קצת שונה, תמיד נכון בעובדות
3. אל תכתבי את המילה "Confidence" בשום מקום אחר
4. שאלה על הזמנה / תפריט / משלוח — כלולי את קישור הוולט בתשובה
5. שאלה על שיתוף פעולה / קייטרינג / אירוע / מגשים — כתבי [SEND_DOR_CONTACT] בסוף ההודעה
6. אם הביטחון נמוך מ-55%, כתבי: "Confidence: 20%\nרגע, אני לא בטוחה — מישהו מהצוות יחזור אלייך עוד רגע 😊"`;
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
    let answer = extractAnswer(raw);

    const sendDorContact = answer.includes("[SEND_DOR_CONTACT]");
    answer = answer.replace(/\[SEND_DOR_CONTACT\]/g, "").trim();

    if (confidence >= 55) {
      await sendWhatsAppMessage(phoneNumber, answer);
      if (sendDorContact) {
        await sendWhatsAppContact(phoneNumber, KB.business.manager_name, KB.business.manager_whatsapp);
        console.log(`📇 Dor contact sent`);
      }
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
