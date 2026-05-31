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
חשוב: דור לא מתחיל שיחה — הלקוח צריך ליצור איתו קשר. הזמיני את הלקוח לפנות אליו, בצורה טבעית, בלי "שלח/י".
דוגמה:
לקוח: "אנחנו צריכים קייטרינג לאירוע של 50 איש"
ליה: "נשמע מגניב! אפשר ליצור קשר עם דור — הוא מטפל בזה ויסגור את כל הפרטים [SEND_DOR_CONTACT]"
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
      conversations[phoneNumber] = { messages: [], dorContactSent: false, lastSeen: null, followUpSentAt: null, conversationClosed: false, name: customerName };
    }
    const conv = conversations[phoneNumber];
    conv.name = customerName;
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

// Conversations dashboard — protected by WEBHOOK_VERIFY_TOKEN
app.get("/conversations", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) {
    return res.status(403).send("Forbidden");
  }

  const escalations = fs.existsSync("escalations.json")
    ? JSON.parse(fs.readFileSync("escalations.json", "utf8"))
    : [];

  const escalatedPhones = new Set(escalations.map(e => e.phone));

  const convEntries = Object.entries(conversations)
    .filter(([, c]) => c.messages.length > 0)
    .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const activeToday = convEntries.filter(([, c]) => c.lastSeen && new Date(c.lastSeen) >= today).length;

  const pageData = {
    conversations: convEntries.map(([phone, conv]) => ({
      phone,
      name: conv.name || phone,
      messages: conv.messages,
      lastSeen: conv.lastSeen,
      dorContactSent: !!conv.dorContactSent,
      conversationClosed: !!conv.conversationClosed,
      followUpSentAt: conv.followUpSentAt || null,
      escalated: escalatedPhones.has(phone),
    })),
    escalations: escalations.slice().reverse().slice(0, 100),
    stats: { total: convEntries.length, today: activeToday, escalations: escalations.length },
  };

  const jsonData = JSON.stringify(pageData).replace(/<\/script>/gi, "<\\/script>");

  const css = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5; height: 100vh; display: flex; flex-direction: column; overflow: hidden; color: #111; }
.header { background: #075e54; color: #fff; padding: 10px 20px; display: flex; align-items: center; gap: 16px; flex-shrink: 0; }
.header-title { font-size: 1.05rem; font-weight: 700; }
.header-stats { display: flex; gap: 24px; margin-right: auto; }
.stat { text-align: center; line-height: 1.2; }
.stat-num { font-size: 1.25rem; font-weight: 700; }
.stat-label { font-size: 0.63rem; opacity: 0.75; }
.refresh-btn { background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.3); color: #fff; padding: 5px 14px; border-radius: 16px; cursor: pointer; font-size: 0.82rem; }
.refresh-btn:hover { background: rgba(255,255,255,0.25); }
.main { display: flex; flex: 1; overflow: hidden; }
.sidebar { width: 320px; background: #fff; border-left: 1px solid #e0e0e0; display: flex; flex-direction: column; flex-shrink: 0; }
.search-wrap { padding: 8px 12px; background: #f8f8f8; border-bottom: 1px solid #f0f0f0; }
.search-wrap input { width: 100%; padding: 7px 14px; border-radius: 18px; border: none; background: #fff; font-size: 0.87rem; outline: none; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.tabs { display: flex; border-bottom: 1px solid #e0e0e0; }
.tab { flex: 1; padding: 9px 4px; text-align: center; font-size: 0.77rem; cursor: pointer; color: #888; border-bottom: 2px solid transparent; user-select: none; }
.tab.active { color: #075e54; border-bottom-color: #075e54; font-weight: 600; }
.conv-list { overflow-y: auto; flex: 1; }
.no-results { padding: 32px 16px; text-align: center; color: #bbb; font-size: 0.87rem; }
.conv-item { padding: 11px 16px; border-bottom: 1px solid #f5f5f5; cursor: pointer; transition: background 0.1s; }
.conv-item:hover { background: #f9f9f9; }
.conv-item.selected { background: #ecf5f4; }
.conv-item.has-esc { border-right: 3px solid #e53935; }
.ci-row1 { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.ci-name { font-weight: 600; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px; }
.ci-time { font-size: 0.71rem; color: #aaa; flex-shrink: 0; margin-right: 6px; }
.ci-preview { font-size: 0.80rem; color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 5px; }
.badges { display: flex; gap: 4px; flex-wrap: wrap; }
.badge { font-size: 0.65rem; padding: 2px 7px; border-radius: 10px; font-weight: 500; }
.b-esc { background: #ffebee; color: #c62828; }
.b-dor { background: #e3f2fd; color: #1565c0; }
.b-closed { background: #f3f3f3; color: #888; }
.b-active { background: #e8f5e9; color: #2e7d32; }
.b-fu { background: #fff8e1; color: #e65100; }
.chat-panel { flex: 1; display: flex; flex-direction: column; background: #efeae2; overflow: hidden; }
.empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #bbb; }
.empty-state .icon { font-size: 2.5rem; }
.chat-header { background: #075e54; color: #fff; padding: 10px 20px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.ch-avatar { width: 38px; height: 38px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-size: 1.1rem; flex-shrink: 0; }
.ch-info { flex: 1; }
.ch-name { font-weight: 600; font-size: 0.95rem; }
.ch-sub { font-size: 0.73rem; opacity: 0.8; }
.ch-badges { display: flex; gap: 6px; }
.ch-badge { font-size: 0.7rem; padding: 2px 9px; border-radius: 12px; background: rgba(255,255,255,0.18); }
.chat-messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 2px; }
.bw { display: flex; margin-bottom: 1px; }
.bw.u { justify-content: flex-end; }
.bw.l { justify-content: flex-start; }
.bubble { max-width: 65%; padding: 7px 11px 5px; border-radius: 8px; font-size: 0.88rem; line-height: 1.55; word-break: break-word; white-space: pre-wrap; box-shadow: 0 1px 2px rgba(0,0,0,0.07); }
.bw.u .bubble { background: #d9fdd3; border-radius: 8px 2px 8px 8px; }
.bw.l .bubble { background: #fff; border-radius: 2px 8px 8px 8px; }
.date-sep { text-align: center; margin: 10px 0 6px; }
.date-sep span { background: #d4d2ce; color: #555; padding: 3px 12px; border-radius: 10px; font-size: 0.71rem; }
.sys-note { text-align: center; margin: 6px 0; }
.sys-note span { background: #fff; border: 1px solid #e0ddd8; color: #888; font-size: 0.73rem; padding: 3px 12px; border-radius: 12px; }
.esc-panel { flex: 1; overflow-y: auto; padding: 14px; }
.esc-card { background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; border-right: 4px solid #e53935; box-shadow: 0 1px 3px rgba(0,0,0,0.07); }
.esc-meta { font-size: 0.74rem; color: #aaa; margin-bottom: 5px; }
.esc-who { font-weight: 600; font-size: 0.9rem; margin-bottom: 6px; }
.esc-q { background: #fff8f8; border-radius: 6px; padding: 8px 11px; font-size: 0.87rem; color: #444; border-right: 2px solid #ffcdd2; }
::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }`;

  const js = `
var DATA = ` + jsonData + `;
var selectedPhone = null;
var currentTab = 'all';

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relTime(iso) {
  if (!iso) return '';
  var diff = Date.now() - new Date(iso).getTime();
  var m = Math.floor(diff / 60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return m + ' דק';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' שע';
  var d = Math.floor(h / 24);
  if (d === 1) return 'אתמול';
  if (d < 7) return d + ' ימים';
  return new Date(iso).toLocaleDateString('he-IL');
}

function fullTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('he-IL', {hour:'2-digit',minute:'2-digit',day:'numeric',month:'numeric',year:'2-digit'});
}

function setTab(el) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  currentTab = el.dataset.tab;
  selectedPhone = null;
  showEmpty();
  renderList();
}

function showEmpty() {
  document.getElementById('chat-panel').innerHTML = '<div class="empty-state"><div class="icon">💬</div><div>בחר שיחה</div></div>';
}

function renderList() {
  var q = document.getElementById('search').value.toLowerCase();
  var items = DATA.conversations.filter(function(c) {
    if (currentTab === 'active' && c.conversationClosed) return false;
    if (currentTab === 'escalated' && !c.escalated) return false;
    if (q && !c.phone.includes(q) && !(c.name||'').toLowerCase().includes(q)) return false;
    return true;
  });
  var container = document.getElementById('conv-list');
  if (items.length === 0) { container.innerHTML = '<div class="no-results">אין תוצאות</div>'; return; }
  container.innerHTML = items.map(function(c) {
    var lastMsg = c.messages.length ? c.messages[c.messages.length-1] : null;
    var preview = lastMsg ? (lastMsg.role==='user' ? lastMsg.content : '← ' + lastMsg.content) : '';
    if (preview.length > 55) preview = preview.slice(0,55) + '…';
    var badges = '';
    if (c.escalated) badges += '<span class="badge b-esc">🔴 Escalated</span>';
    if (c.dorContactSent) badges += '<span class="badge b-dor">📇 דור</span>';
    if (c.conversationClosed) badges += '<span class="badge b-closed">✅ סגור</span>';
    else if (c.followUpSentAt) badges += '<span class="badge b-fu">⏳ follow-up</span>';
    else badges += '<span class="badge b-active">🟢 פעיל</span>';
    var displayName = (c.name && c.name !== c.phone) ? esc(c.name) : c.phone;
    var sel = c.phone === selectedPhone ? ' selected' : '';
    var hasEsc = c.escalated ? ' has-esc' : '';
    return '<div class="conv-item' + sel + hasEsc + '" onclick="selectConv(' + JSON.stringify(c.phone) + ')">' +
      '<div class="ci-row1"><span class="ci-name">' + displayName + '</span><span class="ci-time">' + relTime(c.lastSeen) + '</span></div>' +
      '<div class="ci-preview">' + esc(preview) + '</div>' +
      '<div class="badges">' + badges + '</div></div>';
  }).join('');
}

function selectConv(phone) {
  selectedPhone = phone;
  renderList();
  var conv = null;
  for (var i=0; i<DATA.conversations.length; i++) { if (DATA.conversations[i].phone === phone) { conv = DATA.conversations[i]; break; } }
  if (!conv) return;
  var displayName = (conv.name && conv.name !== conv.phone) ? esc(conv.name) : conv.phone;
  var badges = '';
  if (conv.escalated) badges += '<span class="ch-badge">🔴 Escalated</span>';
  if (conv.dorContactSent) badges += '<span class="ch-badge">📇 דור נשלח</span>';
  if (conv.conversationClosed) badges += '<span class="ch-badge">✅ סגור</span>';
  var msgsHtml = '';
  if (conv.lastSeen) {
    msgsHtml += '<div class="date-sep"><span>' + new Date(conv.lastSeen).toLocaleDateString('he-IL', {weekday:'long',day:'numeric',month:'long'}) + '</span></div>';
  }
  conv.messages.forEach(function(m) {
    var isUser = m.role === 'user';
    msgsHtml += '<div class="bw ' + (isUser?'u':'l') + '"><div class="bubble">' + esc(m.content) + '</div></div>';
  });
  if (conv.dorContactSent) msgsHtml += '<div class="sys-note"><span>📇 כרטיס ויזיטה של דור נשלח ללקוח</span></div>';
  if (conv.conversationClosed) msgsHtml += '<div class="sys-note"><span>✅ שיחה נסגרה</span></div>';
  var panel = document.getElementById('chat-panel');
  panel.innerHTML =
    '<div class="chat-header">' +
      '<div class="ch-avatar">👤</div>' +
      '<div class="ch-info"><div class="ch-name">' + displayName + '</div>' +
      '<div class="ch-sub">' + conv.phone + ' · ' + conv.messages.length + ' הודעות · ' + fullTime(conv.lastSeen) + '</div></div>' +
      '<div class="ch-badges">' + badges + '</div>' +
    '</div>' +
    '<div class="chat-messages" id="msgs">' + msgsHtml + '</div>';
  setTimeout(function(){ var el=document.getElementById('msgs'); if(el) el.scrollTop=el.scrollHeight; }, 0);
}

function showEscalations() {
  var panel = document.getElementById('chat-panel');
  if (!DATA.escalations.length) { panel.innerHTML = '<div class="empty-state"><div class="icon">🎉</div><div>אין escalations</div></div>'; return; }
  var html = DATA.escalations.map(function(e) {
    return '<div class="esc-card">' +
      '<div class="esc-meta">' + new Date(e.timestamp).toLocaleString('he-IL') + '</div>' +
      '<div class="esc-who">' + esc(e.customer) + ' <span style="color:#aaa;font-weight:400;font-size:0.8rem">(' + e.phone + ')</span></div>' +
      '<div class="esc-q">' + esc(e.question) + '</div></div>';
  }).join('');
  panel.innerHTML = '<div class="chat-header"><div class="ch-avatar">🔴</div><div class="ch-info"><div class="ch-name">Escalations Log</div><div class="ch-sub">' + DATA.escalations.length + ' שאלות שלא ידעתי לענות</div></div></div><div class="esc-panel">' + html + '</div>';
  selectedPhone = null;
  renderList();
}

// Init stats
document.getElementById('s-total').textContent = DATA.stats.total;
document.getElementById('s-today').textContent = DATA.stats.today;
document.getElementById('s-esc').textContent = DATA.stats.escalations;
var rate = DATA.stats.total > 0 ? Math.round(DATA.stats.escalations / DATA.stats.total * 100) : 0;
document.getElementById('s-rate').textContent = rate + '%';

renderList();`;

  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ליה — לוח בקרה</title>
<style>${css}</style>
</head>
<body>
<div class="header">
  <span class="header-title">🥐 ליה</span>
  <div class="header-stats">
    <div class="stat"><div class="stat-num" id="s-total">—</div><div class="stat-label">שיחות</div></div>
    <div class="stat"><div class="stat-num" id="s-today">—</div><div class="stat-label">היום</div></div>
    <div class="stat"><div class="stat-num" id="s-esc">—</div><div class="stat-label">escalations</div></div>
    <div class="stat"><div class="stat-num" id="s-rate">—</div><div class="stat-label">esc rate</div></div>
  </div>
  <button class="refresh-btn" onclick="location.reload()">🔄 רענן</button>
</div>
<div class="main">
  <div class="sidebar">
    <div class="search-wrap"><input id="search" type="text" placeholder="חפש לפי שם או מספר..." oninput="renderList()"></div>
    <div class="tabs">
      <div class="tab active" data-tab="all" onclick="setTab(this)">הכל</div>
      <div class="tab" data-tab="active" onclick="setTab(this)">פעיל</div>
      <div class="tab" data-tab="escalated" onclick="setTab(this)">Escalated</div>
      <div class="tab" data-tab="log" onclick="setTab(this);showEscalations()">Log</div>
    </div>
    <div class="conv-list" id="conv-list"></div>
  </div>
  <div class="chat-panel" id="chat-panel">
    <div class="empty-state"><div class="icon">💬</div><div>בחר שיחה מהרשימה</div></div>
  </div>
</div>
<script>${js}</script>
</body>
</html>`);
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
