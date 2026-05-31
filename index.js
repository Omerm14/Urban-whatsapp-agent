require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(express.json());

const KB = JSON.parse(fs.readFileSync("kb.json", "utf8"));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const pendingEscalations = []; // { customerPhone, customerName, question, timestamp }

const DATA_DIR = process.env.DATA_DIR || ".";
const CONV_FILE = path.join(DATA_DIR, "conversations.json");
const ESC_FILE  = path.join(DATA_DIR, "escalations.json");

function loadConversations() {
  try {
    return fs.existsSync(CONV_FILE)
      ? JSON.parse(fs.readFileSync(CONV_FILE, "utf8"))
      : {};
  } catch { return {}; }
}

function saveConversations() {
  fs.writeFileSync(CONV_FILE, JSON.stringify(conversations, null, 2));
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
  const escalations = fs.existsSync(ESC_FILE)
    ? JSON.parse(fs.readFileSync(ESC_FILE, "utf8"))
    : [];
  escalations.push({
    timestamp: new Date().toISOString(),
    customer: customerName,
    phone: phoneNumber,
    question,
  });
  fs.writeFileSync(ESC_FILE, JSON.stringify(escalations, null, 2));
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
      conversations[phoneNumber] = { messages: [], dorContactSent: false, lastSeen: null, followUpSentAt: null, conversationClosed: false, name: customerName, humanMode: false, humanModeSince: null };
    }
    const conv = conversations[phoneNumber];
    conv.name = customerName;
    // Reset follow-up/close state when customer writes again
    conv.followUpSentAt = null;
    conv.conversationClosed = false;
    conv.messages.push({ role: "user", content: customerMessage, timestamp: new Date().toISOString() });
    conv.lastSeen = new Date().toISOString();
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
    }

    // Notify Dor on new conversation
    if (conv.messages.length === 1) {
      await sendWhatsAppMessage(
        process.env.MANAGER_PHONE,
        `💬 שיחה חדשה\n${customerName} · ${phoneNumber}\n"${customerMessage}"`
      );
    }

    // Dor has taken over — stay silent and notify him of the reply
    if (conv.humanMode) {
      if (conv.messages.length > 1) {
        await sendWhatsAppMessage(
          process.env.MANAGER_PHONE,
          `📨 ${conv.name || phoneNumber} ענה:\n"${customerMessage}"`
        );
      }
      saveConversations();
      return res.status(200).send("OK");
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
      conv.messages.push({ role: "assistant", content: answer, timestamp: new Date().toISOString() });
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

  const escalations = fs.existsSync(ESC_FILE)
    ? JSON.parse(fs.readFileSync(ESC_FILE, "utf8"))
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
      humanMode: !!conv.humanMode,
      humanModeSince: conv.humanModeSince || null,
    })),
    escalations: escalations.slice().reverse().slice(0, 100),
    stats: { total: convEntries.length, today: activeToday, escalations: escalations.length },
  };

  const jsonData = JSON.stringify(pageData).replace(/<\/script>/gi, "<\\/script>");

  const css = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, system-ui, sans-serif; background: #f0f2f5; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; color: #111; }
.header { background: #075e54; color: #fff; padding: 8px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; height: 54px; }
.header-title { font-size: 1.05rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; box-shadow: 0 0 0 0 rgba(76,175,80,.7); animation: pulse-dot 2s infinite; flex-shrink: 0; }
@keyframes pulse-dot { 0%{box-shadow:0 0 0 0 rgba(76,175,80,.7)} 70%{box-shadow:0 0 0 6px rgba(76,175,80,0)} 100%{box-shadow:0 0 0 0 rgba(76,175,80,0)} }
.header-stats { display: flex; gap: 20px; margin-right: auto; margin-left: auto; }
.stat { text-align: center; }
.stat-num { font-size: 1.2rem; font-weight: 700; line-height: 1.1; }
.stat-label { font-size: 0.6rem; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.4px; }
.refresh-info { font-size: 0.72rem; opacity: 0.65; white-space: nowrap; }
.main { display: flex; flex: 1; overflow: hidden; }
.sidebar { width: 340px; background: #fff; border-left: 1px solid #e8e8e8; display: flex; flex-direction: column; flex-shrink: 0; }
.search-wrap { padding: 8px 10px; background: #f8f8f8; border-bottom: 1px solid #eee; }
.search-wrap input { width: 100%; padding: 8px 14px; border-radius: 20px; border: none; background: #fff; font-size: 0.85rem; outline: none; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.tabs { display: flex; border-bottom: 1px solid #e8e8e8; }
.tab { flex: 1; padding: 10px 4px 8px; text-align: center; font-size: 0.73rem; cursor: pointer; color: #888; border-bottom: 2px solid transparent; user-select: none; }
.tab.active { color: #075e54; border-bottom-color: #075e54; font-weight: 600; }
.tab-count { display: inline-block; background: #eee; color: #777; border-radius: 8px; padding: 0 5px; font-size: 0.63rem; font-weight: 600; margin-right: 1px; }
.tab.active .tab-count { background: rgba(7,94,84,0.15); color: #075e54; }
.conv-list { overflow-y: auto; flex: 1; }
.no-results { padding: 40px 16px; text-align: center; color: #ccc; font-size: 0.87rem; }
.conv-item { padding: 11px 12px 11px 14px; border-bottom: 1px solid #f5f5f5; cursor: pointer; transition: background 0.12s; display: flex; gap: 10px; align-items: flex-start; border-right: 3px solid transparent; }
.conv-item:hover { background: #fafafa; }
.conv-item.selected { background: #e8f4f3; border-right-color: #075e54 !important; }
.conv-item.has-esc { border-right-color: #e53935; }
.conv-item.has-human { border-right-color: #ff9800; }
.ci-avatar { width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.95rem; color: #fff; }
.ci-body { flex: 1; min-width: 0; }
.ci-row1 { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 2px; }
.ci-name { font-weight: 600; font-size: 0.87rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-time { font-size: 0.69rem; color: #bbb; flex-shrink: 0; margin-right: 4px; }
.ci-preview { font-size: 0.79rem; color: #999; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 4px; }
.ci-badges { display: flex; gap: 4px; flex-wrap: wrap; }
.unread-dot { width: 9px; height: 9px; border-radius: 50%; background: #25d366; flex-shrink: 0; margin-top: 6px; }
.badge { font-size: 0.62rem; padding: 1px 6px; border-radius: 8px; font-weight: 500; }
.b-esc { background: #ffebee; color: #c62828; }
.b-dor { background: #e3f2fd; color: #1565c0; }
.b-closed { background: #f3f3f3; color: #999; }
.b-active { background: #e8f5e9; color: #2e7d32; }
.b-fu { background: #fff8e1; color: #e65100; }
.b-human { background: #fff3e0; color: #e65100; }
.chat-panel { flex: 1; display: flex; flex-direction: column; background: #efeae2; overflow: hidden; }
.empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #bbb; }
.empty-state .icon { font-size: 2.8rem; }
.empty-state .hint { font-size: 0.84rem; }
.chat-header { background: #075e54; color: #fff; padding: 8px 16px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-height: 54px; }
.ch-back { display: none; background: none; border: none; color: #fff; font-size: 1.3rem; cursor: pointer; padding: 4px; line-height: 1; }
.ch-avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.95rem; color: #fff; }
.ch-info { flex: 1; min-width: 0; }
.ch-name { font-weight: 600; font-size: 0.95rem; }
.ch-sub { font-size: 0.72rem; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-actions { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.hbtn { border: none; padding: 6px 14px; border-radius: 14px; font-size: 0.78rem; cursor: pointer; font-weight: 600; white-space: nowrap; transition: background 0.15s; }
.hbtn.hijack { background: rgba(255,255,255,0.18); color: #fff; border: 1px solid rgba(255,255,255,0.35); }
.hbtn.hijack:hover { background: rgba(255,255,255,0.28); }
.hbtn.release { background: #e8f5e9; color: #2e7d32; }
.hbtn.release:hover { background: #c8e6c9; }
.chat-messages { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 1px; }
.human-banner { background: #fff3e0; color: #bf360c; padding: 7px 16px; font-size: 0.81rem; font-weight: 500; flex-shrink: 0; border-top: 1px solid #ffe0b2; text-align: center; }
.compose-box { display: flex; gap: 8px; padding: 10px 14px; background: #f0f2f5; border-top: 1px solid #e0e0e0; flex-shrink: 0; align-items: flex-end; }
.compose-box textarea { flex: 1; border-radius: 22px; border: none; padding: 10px 16px; font-size: 0.87rem; resize: none; outline: none; font-family: inherit; background: #fff; max-height: 120px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); line-height: 1.5; }
.compose-box button { background: #075e54; color: #fff; border: none; border-radius: 50%; width: 42px; height: 42px; font-size: 1.1rem; cursor: pointer; flex-shrink: 0; transition: background 0.15s; }
.compose-box button:hover { background: #128c7e; }
.bw { display: flex; margin-bottom: 2px; }
.bw.u { justify-content: flex-end; }
.bw.l { justify-content: flex-start; }
.bubble { max-width: 68%; padding: 7px 11px 4px; border-radius: 8px; font-size: 0.87rem; line-height: 1.55; word-break: break-word; white-space: pre-wrap; box-shadow: 0 1px 2px rgba(0,0,0,0.08); }
.bw.u .bubble { background: #d9fdd3; border-radius: 8px 2px 8px 8px; }
.bw.l .bubble { background: #fff; border-radius: 2px 8px 8px 8px; }
.dor-bubble { background: #fff8e1 !important; border: 1px solid #ffe082 !important; }
.dor-label { display: block; font-size: 0.63rem; color: #e65100; margin-top: 2px; font-weight: 500; }
.msg-time { display: block; font-size: 0.62rem; color: #aaa; margin-top: 3px; }
.bw.u .msg-time { text-align: right; }
.bw.l .msg-time { text-align: left; }
.date-sep { text-align: center; margin: 12px 0 8px; }
.date-sep span { background: rgba(255,255,255,0.75); color: #666; padding: 3px 12px; border-radius: 8px; font-size: 0.7rem; box-shadow: 0 1px 2px rgba(0,0,0,0.06); }
.sys-note { text-align: center; margin: 8px 0; }
.sys-note span { background: rgba(255,255,255,0.75); border: 1px solid rgba(0,0,0,0.06); color: #888; font-size: 0.72rem; padding: 3px 12px; border-radius: 12px; }
.esc-panel { flex: 1; overflow-y: auto; padding: 14px; }
.esc-card { background: #fff; border-radius: 10px; padding: 13px 15px; margin-bottom: 10px; border-right: 4px solid #e53935; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.esc-meta { font-size: 0.73rem; color: #bbb; margin-bottom: 4px; }
.esc-who { font-weight: 600; font-size: 0.88rem; margin-bottom: 6px; }
.esc-q { background: #fff5f5; border-radius: 6px; padding: 8px 11px; font-size: 0.86rem; color: #444; border-right: 2px solid #ffcdd2; }
::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }
@media (max-width: 700px) {
  .sidebar { width: 100%; border-left: none; }
  .chat-panel { display: none; position: fixed; inset: 0; z-index: 20; background: #efeae2; flex-direction: column; }
  .chat-panel.mobile-open { display: flex; }
  .ch-back { display: block; }
  .header-stats { gap: 12px; }
  .stat-num { font-size: 1rem; }
}
@media (min-width: 701px) {
  .chat-panel { display: flex; }
}`;

  const token = req.query.token;
  const js = `
var DATA = ` + jsonData + `;
var TOKEN = ` + JSON.stringify(token) + `;
var selectedPhone = null;
var currentTab = 'all';

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function relTime(iso) {
  if (!iso) return '';
  var diff = Date.now() - new Date(iso).getTime();
  var m = Math.floor(diff/60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return m + ' דק\'';
  var h = Math.floor(m/60);
  if (h < 24) return h + ' שע\'';
  var d = Math.floor(h/24);
  if (d === 1) return 'אתמול';
  if (d < 7) return d + ' ימים';
  return new Date(iso).toLocaleDateString('he-IL');
}
function fullTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('he-IL', {hour:'2-digit',minute:'2-digit',day:'numeric',month:'numeric',year:'2-digit'});
}
function msgTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('he-IL', {hour:'2-digit',minute:'2-digit'});
}
function sameDay(d1, d2) { return d1.toDateString() === d2.toDateString(); }
function formatDaySep(iso) {
  var d = new Date(iso), now = new Date();
  if (sameDay(d, now)) return 'היום';
  var yest = new Date(now); yest.setDate(yest.getDate()-1);
  if (sameDay(d, yest)) return 'אתמול';
  return d.toLocaleDateString('he-IL', {weekday:'long', day:'numeric', month:'long'});
}
function avatarColor(str) {
  var colors = ['#1abc9c','#2980b9','#8e44ad','#e67e22','#e74c3c','#16a085','#2c3e50','#d35400','#27ae60','#c0392b'];
  var hash = 0;
  for (var i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}
function initials(name, phone) {
  if (name && name !== phone) {
    var p = name.trim().split(/\s+/);
    if (p.length >= 2) return (p[0][0] + p[1][0]).toUpperCase();
    return p[0].slice(0, 2).toUpperCase();
  }
  return '?';
}
function isUnread(conv) {
  if (!conv.lastSeen) return false;
  var last = localStorage.getItem('lia_read_' + conv.phone);
  return !last || new Date(conv.lastSeen) > new Date(last);
}
function markRead(phone) { localStorage.setItem('lia_read_' + phone, new Date().toISOString()); }
function updateStats() {
  document.getElementById('s-total').textContent = DATA.stats.total;
  document.getElementById('s-today').textContent = DATA.stats.today;
  document.getElementById('s-esc').textContent = DATA.stats.escalations;
  var rate = DATA.stats.total > 0 ? Math.round(DATA.stats.escalations / DATA.stats.total * 100) : 0;
  document.getElementById('s-rate').textContent = rate + '%';
}
function renderTabs() {
  var counts = {all:0, active:0, human:0, escalated:0};
  DATA.conversations.forEach(function(c) {
    counts.all++;
    if (!c.conversationClosed) counts.active++;
    if (c.humanMode) counts.human++;
    if (c.escalated) counts.escalated++;
  });
  document.querySelectorAll('.tab[data-tab]').forEach(function(t) {
    var el = t.querySelector('.tab-count');
    if (el && counts[t.dataset.tab] !== undefined) el.textContent = counts[t.dataset.tab];
  });
}
function setTab(el) {
  document.querySelectorAll('.tab').forEach(function(t){ t.classList.remove('active'); });
  el.classList.add('active');
  currentTab = el.dataset.tab;
  selectedPhone = null;
  document.getElementById('chat-panel').classList.remove('mobile-open');
  document.getElementById('chat-panel').innerHTML = '<div class="empty-state"><div class="icon">💬</div><div class="hint">בחר שיחה מהרשימה</div></div>';
  renderList();
}
function mobileBack() {
  document.getElementById('chat-panel').classList.remove('mobile-open');
  selectedPhone = null;
  renderList();
}
function getConv(phone) {
  for (var i = 0; i < DATA.conversations.length; i++) { if (DATA.conversations[i].phone === phone) return DATA.conversations[i]; }
  return null;
}
function renderList() {
  renderTabs();
  var q = document.getElementById('search').value.toLowerCase();
  var items = DATA.conversations.filter(function(c) {
    if (currentTab === 'active' && c.conversationClosed) return false;
    if (currentTab === 'escalated' && !c.escalated) return false;
    if (currentTab === 'human' && !c.humanMode) return false;
    if (q && !c.phone.includes(q) && !(c.name||'').toLowerCase().includes(q)) return false;
    return true;
  });
  var container = document.getElementById('conv-list');
  if (items.length === 0) { container.innerHTML = '<div class="no-results">אין תוצאות</div>'; return; }
  container.innerHTML = items.map(function(c) {
    var lastMsg = c.messages.length ? c.messages[c.messages.length-1] : null;
    var preview = lastMsg ? (lastMsg.role==='user' ? lastMsg.content : '← ' + lastMsg.content) : '';
    if (preview.length > 55) preview = preview.slice(0, 55) + '…';
    var badges = '';
    if (c.humanMode) badges += '<span class="badge b-human">👤 Dor</span>';
    if (c.escalated) badges += '<span class="badge b-esc">🔴</span>';
    if (c.dorContactSent) badges += '<span class="badge b-dor">📇</span>';
    if (c.conversationClosed) badges += '<span class="badge b-closed">✅</span>';
    else if (c.followUpSentAt && !c.humanMode) badges += '<span class="badge b-fu">⏳</span>';
    var displayName = (c.name && c.name !== c.phone) ? esc(c.name) : c.phone;
    var sel = c.phone === selectedPhone ? ' selected' : '';
    var borderCls = c.humanMode ? ' has-human' : (c.escalated ? ' has-esc' : '');
    var av = initials(c.name, c.phone);
    var avColor = avatarColor(c.phone);
    var unreadDot = isUnread(c) && c.phone !== selectedPhone ? '<div class="unread-dot"></div>' : '';
    return '<div class="conv-item' + sel + borderCls + '" data-phone="' + esc(c.phone) + '">' +
      '<div class="ci-avatar" style="background:' + avColor + '">' + esc(av) + '</div>' +
      '<div class="ci-body">' +
        '<div class="ci-row1"><span class="ci-name">' + displayName + '</span><span class="ci-time">' + relTime(c.lastSeen) + '</span></div>' +
        '<div class="ci-preview">' + esc(preview) + '</div>' +
        '<div class="ci-badges">' + badges + '</div>' +
      '</div>' +
      unreadDot + '</div>';
  }).join('');
}
function selectConv(phone) {
  selectedPhone = phone;
  markRead(phone);
  renderList();
  var conv = getConv(phone);
  if (!conv) return;
  var displayName = (conv.name && conv.name !== conv.phone) ? esc(conv.name) : conv.phone;
  var av = initials(conv.name, conv.phone);
  var avColor = avatarColor(conv.phone);
  var hijackBtn = conv.humanMode
    ? '<button class="hbtn release" onclick="doRelease()">🤖 Return to Lia</button>'
    : '<button class="hbtn hijack" onclick="doHijack()">👤 Hijack</button>';
  var msgsHtml = '';
  var lastDate = null;
  var hasTs = conv.messages.some(function(m){ return !!m.timestamp; });
  if (!hasTs && conv.lastSeen) {
    msgsHtml += '<div class="date-sep"><span>' + formatDaySep(conv.lastSeen) + '</span></div>';
  }
  conv.messages.forEach(function(m) {
    if (m.timestamp) {
      var d = new Date(m.timestamp);
      if (!lastDate || !sameDay(lastDate, d)) {
        msgsHtml += '<div class="date-sep"><span>' + formatDaySep(m.timestamp) + '</span></div>';
        lastDate = d;
      }
    }
    var isUser = m.role === 'user';
    var isDor = m.sender === 'dor';
    var cls = isUser ? 'u' : 'l';
    var bubbleCls = isDor ? 'bubble dor-bubble' : 'bubble';
    var extra = isDor ? '<span class="dor-label">Dor</span>' : '';
    var timeStr = m.timestamp ? '<span class="msg-time">' + msgTime(m.timestamp) + '</span>' : '';
    msgsHtml += '<div class="bw ' + cls + '"><div class="' + bubbleCls + '">' + esc(m.content) + extra + timeStr + '</div></div>';
  });
  if (conv.dorContactSent) msgsHtml += '<div class="sys-note"><span>📇 כרטיס ויזיטה של דור נשלח ללקוח</span></div>';
  if (conv.conversationClosed) msgsHtml += '<div class="sys-note"><span>✅ שיחה נסגרה</span></div>';
  var composeHtml = conv.humanMode
    ? '<div class="human-banner">👤 Dor mode — Lia is silent. Replies go directly to the customer.</div>' +
      '<div class="compose-box"><textarea id="compose" placeholder="Type a message to customer..." onkeydown="composeKey(event)"></textarea>' +
      '<button onclick="doSend()">➤</button></div>'
    : '';
  var panel = document.getElementById('chat-panel');
  panel.innerHTML =
    '<div class="chat-header">' +
      '<button class="ch-back" onclick="mobileBack()">‹</button>' +
      '<div class="ch-avatar" style="background:' + avColor + '">' + esc(av) + '</div>' +
      '<div class="ch-info"><div class="ch-name">' + displayName + '</div>' +
      '<div class="ch-sub">' + conv.phone + ' · ' + conv.messages.length + ' הודעות · ' + fullTime(conv.lastSeen) + '</div></div>' +
      '<div class="ch-actions">' + hijackBtn + '</div>' +
    '</div>' +
    '<div class="chat-messages" id="msgs">' + msgsHtml + '</div>' + composeHtml;
  panel.classList.add('mobile-open');
  setTimeout(function(){ var el=document.getElementById('msgs'); if(el) el.scrollTop=el.scrollHeight; }, 0);
}
function showEscalations() {
  var panel = document.getElementById('chat-panel');
  if (!DATA.escalations.length) {
    panel.innerHTML = '<div class="empty-state"><div class="icon">🎉</div><div class="hint">אין escalations</div></div>';
    panel.classList.add('mobile-open'); return;
  }
  var html = DATA.escalations.map(function(e) {
    return '<div class="esc-card">' +
      '<div class="esc-meta">' + new Date(e.timestamp).toLocaleString('he-IL') + '</div>' +
      '<div class="esc-who">' + esc(e.customer) + ' <span style="color:#bbb;font-weight:400;font-size:0.78rem">(' + e.phone + ')</span></div>' +
      '<div class="esc-q">' + esc(e.question) + '</div></div>';
  }).join('');
  panel.innerHTML =
    '<div class="chat-header">' +
      '<button class="ch-back" onclick="mobileBack()">‹</button>' +
      '<div class="ch-avatar" style="background:#e53935;font-size:1.1rem">!</div>' +
      '<div class="ch-info"><div class="ch-name">Escalations Log</div>' +
      '<div class="ch-sub">' + DATA.escalations.length + ' שאלות</div></div></div>' +
    '<div class="esc-panel">' + html + '</div>';
  panel.classList.add('mobile-open');
  selectedPhone = null;
  renderList();
}
function composeKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } }
function doHijack() {
  fetch('/hijack?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone); if(c){c.humanMode=true;c.humanModeSince=new Date().toISOString();}
      selectConv(selectedPhone); renderList();
    });
}
function doRelease() {
  fetch('/release?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone); if(c){c.humanMode=false;c.humanModeSince=null;}
      selectConv(selectedPhone); renderList();
    });
}
function doSend() {
  var el = document.getElementById('compose');
  var msg = el ? el.value.trim() : '';
  if (!msg) return;
  if (el) el.value = '';
  fetch('/send?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone,message:msg})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone);
      if (c) c.messages.push({role:'assistant',content:msg,sender:'dor',timestamp:new Date().toISOString()});
      selectConv(selectedPhone);
    });
}
// Refresh countdown
var refreshSecs = 30;
var refreshEl = document.getElementById('refresh-timer');
setInterval(function(){
  refreshSecs--;
  if (refreshEl) refreshEl.textContent = refreshSecs + 's';
  if (refreshSecs <= 0) refreshSecs = 30;
}, 1000);
// Delegated click
document.getElementById('conv-list').addEventListener('click', function(e) {
  var item = e.target.closest('.conv-item');
  if (item && item.dataset.phone) selectConv(item.dataset.phone);
});
// Auto-refresh every 30 seconds
setInterval(function() {
  fetch('/conversations-data?token='+TOKEN)
    .then(function(r){return r.json();})
    .then(function(fresh){
      DATA.conversations = fresh.conversations;
      DATA.escalations = fresh.escalations;
      DATA.stats = fresh.stats;
      refreshSecs = 30;
      if (refreshEl) refreshEl.textContent = '30s';
      updateStats();
      renderList();
      if (selectedPhone) { var still = getConv(selectedPhone); if (still) selectConv(selectedPhone); }
    }).catch(function(){});
}, 30000);
updateStats();
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
  <span class="header-title">🥐 ליה <span class="live-dot"></span></span>
  <div class="header-stats">
    <div class="stat"><div class="stat-num" id="s-total">—</div><div class="stat-label">שיחות</div></div>
    <div class="stat"><div class="stat-num" id="s-today">—</div><div class="stat-label">היום</div></div>
    <div class="stat"><div class="stat-num" id="s-esc">—</div><div class="stat-label">escalations</div></div>
    <div class="stat"><div class="stat-num" id="s-rate">—</div><div class="stat-label">esc rate</div></div>
  </div>
  <span class="refresh-info">עדכון בעוד <span id="refresh-timer">30s</span></span>
</div>
<div class="main">
  <div class="sidebar">
    <div class="search-wrap"><input id="search" type="text" placeholder="חפש לפי שם או מספר..." oninput="renderList()"></div>
    <div class="tabs">
      <div class="tab active" data-tab="all" onclick="setTab(this)">הכל <span class="tab-count">0</span></div>
      <div class="tab" data-tab="active" onclick="setTab(this)">פעיל <span class="tab-count">0</span></div>
      <div class="tab" data-tab="human" onclick="setTab(this)">👤 <span class="tab-count">0</span></div>
      <div class="tab" data-tab="escalated" onclick="setTab(this)">🔴 <span class="tab-count">0</span></div>
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

// Hijack — Dor takes over a conversation
app.post("/hijack", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  const { phone } = req.body;
  if (!conversations[phone]) return res.status(404).json({ error: "Not found" });
  conversations[phone].humanMode = true;
  conversations[phone].humanModeSince = new Date().toISOString();
  saveConversations();
  res.json({ ok: true });
});

// Release — hand conversation back to Lia
app.post("/release", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  const { phone } = req.body;
  if (!conversations[phone]) return res.status(404).json({ error: "Not found" });
  conversations[phone].humanMode = false;
  conversations[phone].humanModeSince = null;
  saveConversations();
  res.json({ ok: true });
});

// Send — Dor sends a message to a customer
app.post("/send", async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: "Missing phone or message" });
  await sendWhatsAppMessage(phone, message);
  if (conversations[phone]) {
    conversations[phone].messages.push({ role: "assistant", content: message, sender: "dor", timestamp: new Date().toISOString() });
    conversations[phone].lastSeen = new Date().toISOString();
    saveConversations();
  }
  res.json({ ok: true });
});

// Conversations data — JSON only, used by dashboard polling
app.get("/conversations-data", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  const escalations = fs.existsSync(ESC_FILE)
    ? JSON.parse(fs.readFileSync(ESC_FILE, "utf8"))
    : [];
  const escalatedPhones = new Set(escalations.map(e => e.phone));
  const convEntries = Object.entries(conversations)
    .filter(([, c]) => c.messages.length > 0)
    .sort((a, b) => new Date(b[1].lastSeen) - new Date(a[1].lastSeen));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const activeToday = convEntries.filter(([, c]) => c.lastSeen && new Date(c.lastSeen) >= today).length;
  res.json({
    conversations: convEntries.map(([phone, conv]) => ({
      phone, name: conv.name || phone, messages: conv.messages,
      lastSeen: conv.lastSeen, dorContactSent: !!conv.dorContactSent,
      conversationClosed: !!conv.conversationClosed, followUpSentAt: conv.followUpSentAt || null,
      escalated: escalatedPhones.has(phone), humanMode: !!conv.humanMode, humanModeSince: conv.humanModeSince || null,
    })),
    escalations: escalations.slice().reverse().slice(0, 100),
    stats: { total: convEntries.length, today: activeToday, escalations: escalations.length },
  });
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

      // Auto-release human mode after 30 min of silence
      if (conv.humanMode) {
        if (silenceMs > 30 * 60 * 1000) {
          conv.humanMode = false;
          conv.humanModeSince = null;
          saveConversations();
          await sendWhatsAppMessage(
            process.env.MANAGER_PHONE,
            `🤖 ליה חזרה אוטומטית לשיחה עם ${conv.name || phone} (30 דק' של שקט)`
          );
          console.log(`🤖 Auto-released human mode for ${phone}`);
        }
        continue;
      }

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
