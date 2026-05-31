require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(express.json());

const KB = JSON.parse(fs.readFileSync("kb.json", "utf8"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pendingEscalations = []; // { customerPhone, customerName, question, timestamp }

function loadConversations() {
  try {
    return fs.existsSync("conversations.json")
      ? JSON.parse(fs.readFileSync("conversations.json", "utf8"))
      : {};
  } catch { return {}; }
}

function saveConversations() {
  fs.writeFileSync("conversations.json", JSON.stringify(conversations, null, 2));
}

const conversations = loadConversations();
// Prune conversations not seen in 60 days
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
for (const phone of Object.keys(conversations)) {
  const last = conversations[phone].lastSeen;
  if (!last || Date.now() - new Date(last).getTime() > SIXTY_DAYS_MS) {
    delete conversations[phone];
  }
}

let websiteContent = null;

const FOLLOW_UP_AFTER_MS = 10 * 60 * 1000;
const CLOSE_AFTER_MS = 5 * 60 * 1000;

async function generateFollowUpMessage(conv, type) {
  const instruction = type === "follow_up"
    ? "כתבי הודעת המשך קצרה וטבעית ללקוח — שאלה אם נשאר משהו שאפשר לעזור. משפט אחד. בשפה של השיחה."
    : "כתבי הודעת סיום קצרה וחמה. משפט אחד. בשפה של השיחה.";
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 60,
      system: "את ליה, נציגת שירות של אורבן בייקרי. כתבי הודעה אחת בלבד, קצרה וחמה, ללא הסברים.",
      messages: [
        ...conv.messages.map(m => ({ role: m.role, content: m.content })),
        { role: "user", content: instruction }
      ]
    });
    return response.content[0].text.trim();
  } catch {
    return type === "follow_up" ? "יש עוד שאלות?" : "אוקיי! אם יצטרך משהו, אנחנו כאן";
  }
}

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

  return `שמך ליה. את נציגת שירות הלקוחות של אורבן בייקרי, קפה ומאפייה בתל אביב.
את כותבת כמו שמדברים בוואטסאפ עם מישהו שמכיר את המקום מבפנים — קצר, ישיר, חם. לא פורמלי, לא רובוטי, בלי לשון גבוהה.
כשמישהו שואל שאלה פשוטה, עונים לה פשוט. כשיש בשורה טובה, מרגישים אותה. כשהתשובה "לא", אומרים אותה בלי להתנצל יתר על המידה, ומציעים משהו אחר אם אפשר.
אל תשתמשי בניסוחים שליליים — לא "לא הכי נוח", לא "לא ממש", לא "אבל זה לא מושלם". אם משהו קיים — אמרי אותו בצורה חיובית וישירה.
אימוג'י — בקושי. לא יותר מאחד לכל שיחה. רוב ההודעות ללא אימוג'י בכלל.
שפה: ענה תמיד בשפה של ההודעה האחרונה של הלקוח. אם עברו לאנגלית — עני אנגלית. אם חזרו לעברית — עני עברית.
כשמדברים בשם העסק — "פתוחים", "מחכים" (לא "פתוחות"). כשפונים ללקוח לפי מגדר אם ברור, אחרת רבים.
לא מזכירים שזה AI.

דוגמאות מהצוות האמיתי (כך נשמעת תשובה טובה):
לקוחה: "אם אגיע בלי הזמנה יהיו עוגות?"
ליה: "מקווים שכן, עדיף לשריין מראש ככה בטוח תישמר לך"

לקוח: "יש happy hour?"
ליה: "יש! שעה אחרונה בכל יום 1+1 על מאפים, כריכים, סלטים ולחמים"

לקוח: "אפשר לחם לא פרוס?"
ליה: "כן, תרשמי לנו בהערות"

לקוח: "תודה רבה!"
ליה: "בכיף! ❤️"

לקוח: "אתם כשרים?"
ליה: "לא, אנחנו לא כשרים. אבל התפריט עשיר, רוב האנשים מוצאים המון דברים טובים"

לקוח: "מה הכתובת?"
ליה: "ניצנה 14, תל אביב. בואו!"

לקוח: "Hey can I reserve a cake for tomorrow?"
ליה: "Hey, sure! Can you come in the morning?"

מידע על העסק — את יודעת את זה כמו שחבר יודע על המקום האהוב עליו. כשאת עונה, את מדברת מהבטן בסגנון שלך, לא מציטטת:
• שעות: ראשון–חמישי 7:00–19:00 | שישי–שבת 7:00–16:00
• כשרות: לא כשרים
• כתובת: ניצנה 14, תל אביב יפו
• הזמנת מקום: לא נדרשת, ישיבה על בסיס מקום פנוי
• טבעוני: כריך אבוקדו עם טחינה, כריך כרובית עם לימון כבוש, עוגת בננות שוקולד, סלטים
• ללא גלוטן: עוגת תפוזים, לחם ללא גלוטן, עוגיות אמרטי
• happy hour: שעה אחרונה בכל יום (מ-18:00 בחול) — 1+1 על מאפים, כריכים, סלטים, לחמים
• עוגה מיוחדת: אפשר לשריין עוגת גבינה מראש, קוטר 18 ס"מ, אפשר ברכה אישית. מחיר — שאלו בחנות או ראו בוולט
• לחמים: מחמצת — שיפון אגוזים, כפרי, קמח מלא, צ׳ילי פקאן, זיתים ופרמזן, בריאות, נורווגי. הזמינות משתנה
• תשלום: מזומן, אשראי במקום, וולט, אשראי טלפוני בהזמנה מראש
• פרחים: לפעמים יש — כדאי לשאול ביום עצמו
• לחם לא פרוס: אפשר — לציין בהערות בהזמנה
• מרחב מוגן: כן, כ-50 מטר מהמקום
• הזמנה / תפריט / משלוח: ${KB.business.wolt}
• שיתוף פעולה עסקי / קייטרינג / אירועים / מגשים: לפנות לדור
• dog-friendly: כן, מוזמנים להביא כלבים
• מאצ'ה: יש
• פיצה: פיצה איטלקית ישר מהתנור
• חניה: ברחוב ובחניון בתשלום קרוב
${customEntries ? customEntries + "\n" : ""}${websiteSection}
מחירים — לעולם אל תציגי מספרים. אם שואלים על מחיר, הפני לוולט או לשאול בחנות.
שיתוף פעולה / קייטרינג / אירוע / הזמנה גדולה / מגשים — זה תחום של דור. כתבי [SEND_DOR_CONTACT] בסוף ההודעה, תמיד, בכל שאלה כזו בלי יוצא מן הכלל.
חשוב: דור לא מתחיל שיחה — הלקוח צריך לשלוח לו הודעה. הזמיני את הלקוח לפנות אליו, בצורה טבעית.
דוגמה:
לקוח: "אנחנו צריכים קייטרינג לאירוע של 50 איש"
ליה: "נשמע מגניב! שלח/י הודעה לדור — הוא מטפל בזה ויסגור איתך את כל הפרטים [SEND_DOR_CONTACT]"
אם שאלה חורגת לגמרי מכל מה שמופיע למעלה ואין לה תשובה סבירה — כתבי [ESCALATE] בשורה נפרדת ותו לא. בכל מקרה אחר, עני טבעית בסגנון שלך.
כל הודעה ייחודית — אל תחזרי על ניסוח שכבר השתמשת בו באותה שיחה.`;
}

async function callClaude(conversationMessages, customerName) {
  const nameNote =
    customerName && !/^\d+$/.test(customerName)
      ? `\nשם הלקוח/ה בשיחה הזו: "${customerName}". השתמשי בשם לפעמים בצורה טבעית — לא בכל משפט. אם השם באנגלית ואת עונה בעברית, תעתיקי אותו לעברית (למשל: "Omer" → "עומר"). אם את עונה באנגלית, השתמשי בשם כפי שהוא.`
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
      conversations[phoneNumber] = { messages: [], dorContactSent: false, lastSeen: null, followUpSentAt: null, conversationClosed: false };
    }
    const conv = conversations[phoneNumber];
    // Reset follow-up/close state when customer writes again
    conv.followUpSentAt = null;
    conv.conversationClosed = false;
    conv.messages.push({ role: "user", content: customerMessage });
    conv.lastSeen = new Date().toISOString();
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
    }

    // Call Claude
    const raw = await callClaude(conv.messages, customerName);

    if (raw.includes("[ESCALATE]")) {
      // Escalate to Dor silently — customer gets Dor's reply directly via handleManagerReply
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
      saveConversations();
      console.log(`⚠️  Escalated`);
    } else {
      const sendDorContact = raw.includes("[SEND_DOR_CONTACT]");
      const answer = raw.replace(/\[SEND_DOR_CONTACT\]/g, "").trim();
      await sendWhatsAppMessage(phoneNumber, answer);
      if (sendDorContact && !conv.dorContactSent) {
        await sendWhatsAppContact(phoneNumber, KB.business.manager_name, KB.business.manager_whatsapp);
        conv.dorContactSent = true;
        console.log(`📇 Dor contact sent`);
      }
      conv.messages.push({ role: "assistant", content: answer });
      saveConversations();
      console.log(`✅ Answered`);
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

// Conversations browser — protected by WEBHOOK_VERIFY_TOKEN
app.get("/conversations", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(403).send("Forbidden");
  }

  const escalations = fs.existsSync("escalations.json")
    ? JSON.parse(fs.readFileSync("escalations.json", "utf8"))
    : [];

  const convEntries = Object.entries(conversations)
    .filter(([, c]) => c.messages.length > 0)
    .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen));

  const escHtml = escalations.length === 0 ? "<p>None</p>" : escalations
    .slice().reverse().slice(0, 50)
    .map(e => `<div class="esc"><span class="ts">${new Date(e.timestamp).toLocaleString("he-IL")}</span> <strong>${e.customer}</strong> (${e.phone}): ${e.question}</div>`)
    .join("");

  const convsHtml = convEntries.map(([phone, conv]) => {
    const msgs = conv.messages.map(m => {
      const cls = m.role === "user" ? "msg user" : "msg lia";
      const label = m.role === "user" ? "👤" : "🤖 ליה";
      return `<div class="${cls}"><span class="label">${label}</span> ${m.content.replace(/</g, "&lt;")}</div>`;
    }).join("");
    const lastSeen = conv.lastSeen ? new Date(conv.lastSeen).toLocaleString("he-IL") : "—";
    return `<details><summary><strong>${phone}</strong> — ${conv.messages.length} הודעות | נראה לאחרונה: ${lastSeen}</summary><div class="thread">${msgs}</div></details>`;
  }).join("");

  res.send(`<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">
<title>ליה — שיחות</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 0 auto; padding: 24px; background: #f5f5f5; color: #111; }
  h1 { font-size: 1.4rem; margin-bottom: 4px; }
  h2 { font-size: 1rem; margin: 28px 0 8px; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  details { background: #fff; border-radius: 8px; margin-bottom: 10px; padding: 12px 16px; box-shadow: 0 1px 3px #0001; }
  summary { cursor: pointer; font-size: 0.95rem; }
  .thread { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .msg { padding: 6px 10px; border-radius: 8px; font-size: 0.9rem; max-width: 80%; line-height: 1.5; white-space: pre-wrap; }
  .msg.user { background: #e1ffc7; align-self: flex-end; }
  .msg.lia { background: #fff; border: 1px solid #e0e0e0; align-self: flex-start; }
  .label { font-weight: 600; font-size: 0.75rem; display: block; margin-bottom: 2px; color: #888; }
  .esc { background: #fff3cd; border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; font-size: 0.9rem; }
  .ts { color: #999; font-size: 0.8rem; margin-left: 8px; }
  .meta { color: #888; font-size: 0.85rem; margin-bottom: 20px; }
</style></head><body>
<h1>🥐 ליה — מרכז שיחות</h1>
<p class="meta">${convEntries.length} שיחות פעילות | ${escalations.length} escalations</p>
<h2>📋 Escalations אחרונים</h2>
${escHtml}
<h2>💬 שיחות (לפי פעילות אחרונה)</h2>
${convsHtml || "<p>אין שיחות עדיין</p>"}
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 ${KB.business.name} agent running on port ${PORT}`);
  console.log(`Webhook: http://localhost:${PORT}/webhook`);
  websiteContent = await fetchWebsiteKB();

  const managerPhone = (process.env.MANAGER_PHONE || "").replace(/^\+/, "");
  setInterval(async () => {
    const now = Date.now();
    for (const [phone, conv] of Object.entries(conversations)) {
      if (phone === managerPhone) continue;
      if (conv.conversationClosed || !conv.lastSeen || conv.messages.length === 0) continue;
      const silenceMs = now - new Date(conv.lastSeen).getTime();
      if (!conv.followUpSentAt && silenceMs > FOLLOW_UP_AFTER_MS) {
        const msg = await generateFollowUpMessage(conv, "follow_up");
        await sendWhatsAppMessage(phone, msg);
        conv.followUpSentAt = new Date().toISOString();
        saveConversations();
        console.log(`🔔 Follow-up sent to ${phone}`);
      } else if (conv.followUpSentAt) {
        const waitedMs = now - new Date(conv.followUpSentAt).getTime();
        if (waitedMs > CLOSE_AFTER_MS) {
          const msg = await generateFollowUpMessage(conv, "closing");
          await sendWhatsAppMessage(phone, msg);
          conv.conversationClosed = true;
          saveConversations();
          console.log(`👋 Conversation closed for ${phone}`);
        }
      }
    }
  }, 2 * 60 * 1000);
});
