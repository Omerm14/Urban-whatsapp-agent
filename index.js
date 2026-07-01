require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;
const { verifyMetaSignature } = require("./lib/verifySignature");
const { isDuplicate } = require("./lib/dedup");

const app = express();
// Capture the raw body so we can verify Meta's HMAC signature over the exact
// bytes Meta signed (JSON re-serialization would change them).
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DATA_DIR = process.env.DATA_DIR || ".";
const CONV_FILE = path.join(DATA_DIR, "conversations.json");
const ESC_FILE  = path.join(DATA_DIR, "escalations.json");
const KB_FILE   = path.join(DATA_DIR, "kb.json");
const PENDING_ESC_FILE = path.join(DATA_DIR, "pending_escalations.json");

// In-process counters for at-a-glance monitoring via GET /health.
// Reset on redeploy — acceptable for a quick health snapshot, not analytics.
const metrics = { answered: 0, escalated: 0, sendFailed: 0 };

const MANAGER_PHONE = (process.env.MANAGER_PHONE || "").replace(/^\+/, "");

function loadKB() {
  const seed = JSON.parse(fs.readFileSync("kb.json", "utf8"));
  if (!fs.existsSync(KB_FILE)) {
    fs.writeFileSync(KB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  const stored = JSON.parse(fs.readFileSync(KB_FILE, "utf8"));
  // Merge any new seed FAQ entries that aren't in the stored KB yet
  const storedIds = new Set(stored.faq.map(e => e.id));
  const newEntries = seed.faq.filter(e => !storedIds.has(e.id));
  if (newEntries.length > 0) {
    stored.faq.push(...newEntries);
    fs.writeFileSync(KB_FILE, JSON.stringify(stored, null, 2));
    console.log(`📚 KB merged ${newEntries.length} new entries from seed`);
  }
  // Always keep business info in sync with seed
  stored.business = seed.business;
  return stored;
}

function loadPendingEscalations() {
  try {
    return fs.existsSync(PENDING_ESC_FILE)
      ? JSON.parse(fs.readFileSync(PENDING_ESC_FILE, "utf8"))
      : [];
  } catch { return []; }
}
function savePendingEscalations() {
  fs.writeFileSync(PENDING_ESC_FILE, JSON.stringify(pendingEscalations, null, 2));
}

const KB = loadKB();
const pendingEscalations = loadPendingEscalations();
let managerAwaitingConfirmation = null; // set when Dor's first message triggers a question prompt
const messageQueues = {}; // phone → { messages: [{text, name}], timer }

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
  const lastUserMsg = [...conv.messages].reverse().find(m => m.role === 'user');
  const lastContent = lastUserMsg ? lastUserMsg.content : '';
  const latinRatio = (lastContent.match(/[a-zA-Z]/g) || []).length / (lastContent.length || 1);
  const isEnglish = latinRatio > 0.5;

  let instruction;
  if (type === "follow_up") {
    instruction = isEnglish
      ? "Do NOT introduce yourself or say your name. Do NOT say 'Is there anything else I can help you with?' — that sounds like a bot. Write one casual, human sentence checking in. Examples: 'Need anything else?' / 'All good? 😊' / 'Anything else on your mind?'"
      : "אל תציגי את עצמך ואל תאמרי את שמך. אסור לכתוב 'יש עוד משהו שאוכל לעזור?' — זה נשמע כמו בוט. כתבי משפט אחד קצר וטבעי. לדוגמה: 'הכל טוב? 😊' / 'יש עוד שאלות?' / 'צריכים עוד משהו?'";
  } else {
    instruction = isEnglish
      ? "Do NOT introduce yourself or say your name. Write one short goodbye wishing them a great day and that you look forward to seeing them. Keep it simple and genuine. Nothing else."
      : "אל תציגי את עצמך ואל תאמרי את שמך. כתבי פרידה קצרה — ברכה ליום נהדר ושמחכים לראותם. פשוט ואמיתי. משפט אחד בלבד.";
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 80,
      system: "You are Lia, a friendly human rep at Urban Bakery Tel Aviv. Write one message only — casual, warm, zero corporate language.",
      messages: [
        { role: "user", content: instruction }
      ]
    });
    return response.content[0].text.trim();
  } catch {
    return type === "follow_up"
      ? (isEnglish ? "Is there anything else I can help with?" : "יש עוד שאלות?")
      : (isEnglish ? "If you need anything, we're here!" : "אם יצטרך משהו, אנחנו כאן");
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
אל תתחילי הודעה עם "כמובן!", "מצוין!", "בשמחה!", "נהדר!", "ודאי!" — זה נשמע כמו בוט.
לא לסיים כל הודעה בשאלה. לפעמים אפשר פשוט לענות ולסיים.
לפעמים התשובה היא שתי מילים. לפעמים שני משפטים. תלוי בשאלה — לא כל תשובה צריכה להיות אותו אורך.
אל תחזרי על מידע שכבר שיתפת בשיחה הזאת. אם כבר שלחת קישור או פרט — אל תשלחי אותו שוב בתשובה אחרת.
ענה רק על מה שנשאל. אל תוסיפי מידע שלא ביקשו — לדוגמה, אם שאלו על שתייה בכלל, אל תפרטי סוגי חלב אלא אם שאלו על זה ספציפית.
שפה: ענה תמיד בשפה של ההודעה האחרונה של הלקוח. אם עברו לאנגלית — עני אנגלית. אם חזרו לעברית — עני עברית.
עברית: כתבי עברית טבעית ונכונה — לא תרגום ממבנים אנגליים. לדוגמה: לא "הבוקרים" (אין מילה כזו) אלא "בבוקר" / "שעות הבוקר". לא "הערבים" אלא "בערב". כתבי כמו שישראלים מדברים בוואטסאפ.
כשמדברים בשם העסק — "פתוחים", "מחכים" (לא "פתוחות"). מגדר: אל תניחי מגדר לפי שם. השתמשי תמיד בלשון רבים (לדוגמה: "בואו", "בחרו", "תכתבו") — אף פעם לא בצורה ניטרלית כמו "בחר/י" או "בוא/י". היוצא מן הכלל: אם הלקוח ציין את מגדרו בצורה מפורשת בשיחה.
לא מזכירים שזה AI. אם שואלים *ישירות* אם את בוט או AI (למשל "את בוט?", "are you a bot?") — עני "אני ליה 😊 מה אפשר לעזור?". אם שואלים "את פה?" / "is anyone there?" — עני קצר וחם, כמו "כן! 😊 מה אפשר לעזור?" בלי להציג את עצמך. לא להשתמש במילים AI, בוט, chat assistant, מערכת.

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

לקוח: "מתי סגורים?"
ליה: "19:00 בימי חול, 16:00 בשישי שבת"

לקוח: "יש wifi?"
ליה: "כן"

Customer: "are you open on saturday?"
Lia: "yes, till 4"

Customer: "is it busy right now?"
Lia: "honestly no idea — depends on the day. mornings are usually calmer"

Customer: "do you have oat milk?"
Lia: "yes!"

לקוח: "תודה, היה מעולה כרגיל"
ליה: "❤️"

לקוח: "יש לכם קרואסון שוקולד?"
ליה: "לרוב כן, אבל הזמינות משתנה — כדאי לקנות מוקדם ביום"

מידע על העסק — את יודעת את זה כמו שחבר יודע על המקום האהוב עליו. כשאת עונה, את מדברת מהבטן בסגנון שלך, לא מציטטת:
• שעות: ראשון–חמישי 7:00–19:00 | שישי–שבת 7:00–16:00
• כשרות: לא כשרים
• כתובת: ניצנה 14, תל אביב יפו
• הזמנת מקום: לא נדרשת, ישיבה על בסיס מקום פנוי
• טבעוני: כריך אבוקדו עם טחינה, כריך כרובית עם לימון כבוש, עוגת בננות שוקולד, סלטים
• ללא גלוטן: עוגת תפוזים, לחם ללא גלוטן, עוגיות אמרטי
• happy hour: שעה אחרונה בכל יום (מ-18:00 בחול) — 1+1 על מאפים, כריכים, סלטים, לחמים
• עוגה מיוחדת: יש כמה סוגים של עוגת גבינה, מחירים משתנים — כדאי לבדוק בוולט או להגיע. אפשר לשריין מראש עם ברכה אישית
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
• חלות: כל יום שישי מ-7:00, אי אפשר לשריין מראש — מומלץ להגיע מוקדם לפני שנגמר
• סוגי חלב: שיבולת שועל, סויה, שקדים, אורז
${customEntries ? customEntries + "\n" : ""}${websiteSection}
מחירים — לעולם אל תציגי מספרים. אם שואלים על מחיר, הפני לוולט או לשאול בחנות.
שיתוף פעולה / קייטרינג / אירוע / הזמנה גדולה / מגשים / גיוס / עבודה / קורות חיים / שאלה על מספר של דור / בקשה לפרטי קשר של דור — זה תחום של דור. כתבי [SEND_DOR_CONTACT] בסוף ההודעה, תמיד, בכל שאלה כזו בלי יוצא מן הכלל.
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
  const lastUserMsg = [...conversationMessages].reverse().find(m => m.role === 'user');
  const lastContent = lastUserMsg ? lastUserMsg.content : '';
  const latinRatio = (lastContent.match(/[a-zA-Z]/g) || []).length / (lastContent.length || 1);
  const langNote = latinRatio > 0.5
    ? "\nIMPORTANT: The customer's last message is in English. Respond in English only. Keep the same casual, warm WhatsApp tone — short, direct, like a real person at the bakery texting back. Not formal, not customer-service-scripted."
    : "";
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: buildSystemPrompt() + nameNote + langNote,
    messages: conversationMessages.map((m) => ({ role: m.role, content: m.content })),
  });
  return response.content[0].text;
}

async function sendWhatsAppMessage(phoneNumber, message) {
  const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  try {
    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        type: "text",
        text: { preview_url: false, body: message },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } }
    );
    const status = res.data?.messages?.[0]?.message_status;
    console.log(`✉️  Sent to ${phoneNumber}${status ? ` [${status}]` : ""}`);
    if (status && status !== "accepted") {
      console.warn(`⚠️  Unexpected message status for ${phoneNumber}:`, JSON.stringify(res.data));
    }
  } catch (error) {
    metrics.sendFailed++;
    console.error("Failed to send:", error.response?.data || error.message);
  }
}

async function sendWhatsAppTemplate(phoneNumber, templateName, languageCode = "he") {
  const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  try {
    const res = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        type: "template",
        template: { name: templateName, language: { code: languageCode } },
      },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } }
    );
    const status = res.data?.messages?.[0]?.message_status;
    console.log(`📋 Template "${templateName}" sent to ${phoneNumber}${status ? ` [${status}]` : ""}`);
    if (status && status !== "accepted") {
      console.warn(`⚠️  Unexpected template status:`, JSON.stringify(res.data));
    }
  } catch (error) {
    console.error("Failed to send template:", error.response?.data || error.message);
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
  // Step 2: Dor already saw the question — this message IS the answer
  if (managerAwaitingConfirmation) {
    const pending = managerAwaitingConfirmation;
    managerAwaitingConfirmation = null;

    const idx = pendingEscalations.findIndex(e => e.customerPhone === pending.customerPhone);
    if (idx !== -1) pendingEscalations.splice(idx, 1);
    savePendingEscalations();

    await sendWhatsAppMessage(pending.customerPhone, answer);
    if (conversations[pending.customerPhone]) {
      conversations[pending.customerPhone].messages.push({
        role: 'assistant', content: answer, sender: 'dor', timestamp: new Date().toISOString()
      });
      conversations[pending.customerPhone].lastSeen = new Date().toISOString();
      saveConversations();
    }
    KB.faq.push({ id: `custom_${Date.now()}`, question: pending.question, answer });
    fs.writeFileSync(KB_FILE, JSON.stringify(KB, null, 2));
    await sendWhatsAppMessage(MANAGER_PHONE, `✅ תשובה נשלחה ל${pending.customerName} ונוספה לבסיס הידע!`);
    console.log(`📚 KB updated: "${pending.question}"`);
    return;
  }

  // Step 1: first message from Dor — show him the pending question, don't send anything to customer yet
  if (pendingEscalations.length === 0) {
    await sendWhatsAppMessage(MANAGER_PHONE, "אין שאלות ממתינות כרגע 🤷");
    return;
  }

  const pending = pendingEscalations[pendingEscalations.length - 1]; // peek, don't pop yet
  managerAwaitingConfirmation = pending;
  await sendWhatsAppMessage(
    MANAGER_PHONE,
    `❓ שאלה ממתינה מ-${pending.customerName}:\n"${pending.question}"\n\nשלח את תשובתך 👇`
  );
}

async function processMessage(phoneNumber, customerMessage, customerName) {
  try {
    if (!conversations[phoneNumber]) {
      conversations[phoneNumber] = { messages: [], dorContactSent: false, lastSeen: null, followUpSentAt: null, conversationClosed: false, name: customerName, humanMode: false, humanModeSince: null };
    }
    const conv = conversations[phoneNumber];
    conv.name = customerName;
    if (conv.conversationClosed) {
      conv.messages = [];
      conv.dorContactSent = false;
      conv.lastSeen = null;
    }
    conv.followUpSentAt = null;
    conv.conversationClosed = false;
    // Capture lastSeen before updating it — used below to detect a new session.
    const prevLastSeen = conv.lastSeen;
    conv.messages.push({ role: "user", content: customerMessage, timestamp: new Date().toISOString() });
    conv.lastSeen = new Date().toISOString();
    if (conv.messages.length > 20) {
      conv.messages = conv.messages.slice(-20);
    }

    // Notify Dor on any new session (first ever message, or returning after 4h gap).
    const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
    const isNewSession = !prevLastSeen ||
      (Date.now() - new Date(prevLastSeen).getTime() > SESSION_GAP_MS);
    if (isNewSession) {
      await sendWhatsAppMessage(MANAGER_PHONE, `💬 שיחה חדשה\n${customerName} · ${phoneNumber}\n"${customerMessage}"`);
    }

    if (conv.humanMode) {
      if (conv.messages.length > 1) {
        await sendWhatsAppMessage(MANAGER_PHONE, `📨 ${conv.name || phoneNumber} ענה:\n"${customerMessage}"`);
      }
      saveConversations();
      return;
    }

    const raw = await callClaude(conv.messages, customerName);

    if (raw.includes("[ESCALATE]")) {
      // De-dupe by customer so a repeated escalation doesn't queue multiple
      // pending entries for the same person.
      const existingIdx = pendingEscalations.findIndex(
        (e) => e.customerPhone === phoneNumber
      );
      if (existingIdx !== -1) pendingEscalations.splice(existingIdx, 1);
      pendingEscalations.push({
        customerPhone: phoneNumber,
        customerName: customerName,
        question: customerMessage,
        timestamp: new Date().toISOString(),
      });
      await sendWhatsAppMessage(MANAGER_PHONE, `❓ שאלה לא מוכרת\nמ: ${customerName}\nטלפון: ${phoneNumber}\nשאלה: ${customerMessage}\n\nענה כאן ואוסיף לבסיס הידע 📝`);
      logEscalation(customerName, phoneNumber, customerMessage);
      savePendingEscalations();
      conv.messages.push({ role: 'assistant', content: '[הועבר לדור]', sender: 'system', timestamp: new Date().toISOString() });
      saveConversations();
      metrics.escalated++;
      console.log(`⚠️  Escalated`);
    } else {
      const sendDorContact = raw.includes("[SEND_DOR_CONTACT]");
      const answer = raw.replace(/\[SEND_DOR_CONTACT\]/g, "").trim();
      await sendWhatsAppMessage(phoneNumber, answer);
      if (sendDorContact) {
        await sendWhatsAppContact(phoneNumber, KB.business.manager_name, KB.business.manager_whatsapp);
        conv.dorContactSent = true;
        console.log(`📇 Dor contact sent`);
      }
      conv.messages.push({ role: "assistant", content: answer, timestamp: new Date().toISOString() });
      saveConversations();
      metrics.answered++;
      console.log(`✅ Answered`);
    }
  } catch (error) {
    console.error("❌ processMessage error:", error.message);
  }
}

// Receive messages from WhatsApp
app.post("/webhook", async (req, res) => {
  // Verify Meta's signature over the raw body before doing anything. Fails open
  // if META_APP_SECRET isn't configured yet (see lib/verifySignature.js).
  const sig = verifyMetaSignature(req);
  if (!sig.ok) {
    console.warn(`🔒 Webhook signature rejected: ${sig.reason}`);
    return res.status(401).send("Unauthorized");
  }
  if (sig.reason === "no-secret-configured") {
    console.warn(
      "🔒 META_APP_SECRET not set — skipping signature verification. Set it in Railway to enable."
    );
  }

  res.status(200).send("OK");
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    const contact = value?.contacts?.[0];

    if (!message || !contact || message.type !== "text") return;

    // Drop duplicate deliveries (Meta retries) before any processing.
    if (isDuplicate(message.id)) {
      console.log(`🔁 Duplicate message ${message.id} ignored`);
      return;
    }

    const phoneNumber = message.from;
    const customerMessage = message.text.body;
    const customerName = contact.profile?.name || phoneNumber;

    console.log(`📱 ${customerName}: ${customerMessage}`);

    if (phoneNumber === MANAGER_PHONE) {
      await handleManagerReply(customerMessage);
      return;
    }

    if (!messageQueues[phoneNumber]) messageQueues[phoneNumber] = { messages: [], timer: null };
    const queue = messageQueues[phoneNumber];
    queue.messages.push({ text: customerMessage, name: customerName });
    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(async () => {
      const batch = messageQueues[phoneNumber]?.messages || [];
      delete messageQueues[phoneNumber];
      const combined = batch.map(m => m.text).join('\n');
      const name = batch[batch.length - 1].name;
      await processMessage(phoneNumber, combined, name);
    }, 10 * 1000);
  } catch (error) {
    console.error("❌ Webhook error:", error.message);
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
  res.status(200).json({
    status: "ok",
    business: KB.business.name,
    uptime_s: Math.round(process.uptime()),
    metrics,
  });
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
:root {
  --wa-header: #075e54;
  --wa-green: #25d366;
  --wa-send: #00a884;
  --wa-bg: #e5ddd5;
  --wa-out: #dcf8c6;
  --wa-in: #ffffff;
  --wa-divider: #e9edef;
  --wa-text: #111b21;
  --wa-muted: #667781;
  --wa-red: #e53935;
  --wa-orange: #f57c00;
  --shadow-msg: 0 1px 0.5px rgba(11,20,26,.13);
}
body { font-family: -apple-system, system-ui, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--wa-bg); height: 100dvh; overflow: hidden; color: var(--wa-text); }
.app { display: flex; height: 100dvh; overflow: hidden; }
/* ── LIST SCREEN ── */
.list-screen { display: flex; flex-direction: column; width: 100%; background: #fff; overflow: hidden; flex-shrink: 0; }
.ls-header { background: var(--wa-header); color: #fff; height: 56px; padding: 0 16px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.ls-title { font-size: 1.1rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--wa-green); animation: pulse 2s infinite; }
@keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(37,211,102,.7)} 70%{box-shadow:0 0 0 6px rgba(37,211,102,0)} 100%{box-shadow:0 0 0 0 rgba(37,211,102,0)} }
.ls-stats { flex: 1; font-size: 0.7rem; opacity: 0.75; text-align: center; }
.ls-refresh { font-size: 0.62rem; opacity: 0.5; white-space: nowrap; }
.ls-search { padding: 8px 12px; background: #f0f2f5; }
.ls-search input { width: 100%; padding: 8px 14px; border-radius: 8px; border: none; background: #fff; font-size: 0.9rem; outline: none; color: var(--wa-text); }
.ls-search input::placeholder { color: var(--wa-muted); }
.ls-tabs { display: flex; background: #fff; border-bottom: 1px solid var(--wa-divider); }
.tab { flex: 1; padding: 11px 4px 10px; text-align: center; font-size: 0.7rem; color: var(--wa-muted); cursor: pointer; border-bottom: 2px solid transparent; font-weight: 500; user-select: none; }
.tab.active { color: var(--wa-send); border-bottom-color: var(--wa-send); font-weight: 700; }
.tab-count { display: inline-block; background: #eee; color: var(--wa-muted); border-radius: 10px; padding: 0 5px; font-size: 0.58rem; font-weight: 700; }
.tab.active .tab-count { background: rgba(0,168,132,.12); color: var(--wa-send); }
.ls-list { flex: 1; overflow-y: auto; }
.no-results { padding: 48px 16px; text-align: center; color: #ccc; font-size: 0.9rem; }
/* Conversation rows */
.conv-item { display: flex; align-items: center; gap: 13px; padding: 10px 16px; cursor: pointer; background: #fff; position: relative; min-height: 72px; }
.conv-item::after { content: ''; position: absolute; bottom: 0; left: 78px; right: 0; height: 1px; background: var(--wa-divider); }
.conv-item:active, .conv-item.selected { background: #f0f2f5; }
.conv-item.has-esc { border-left: 3px solid var(--wa-red); }
.conv-item.has-human { border-left: 3px solid var(--wa-orange); }
.ci-avatar { width: 49px; height: 49px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1.05rem; color: #fff; }
.ci-body { flex: 1; min-width: 0; padding-top: 2px; }
.ci-row1 { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.ci-name { font-weight: 600; font-size: 0.97rem; color: var(--wa-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-time { font-size: 0.72rem; color: var(--wa-muted); flex-shrink: 0; margin-left: 6px; }
.ci-time.unread { color: var(--wa-green); font-weight: 600; }
.ci-row2 { display: flex; align-items: center; justify-content: space-between; }
.ci-preview { font-size: 0.84rem; color: var(--wa-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.ci-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; margin-left: 8px; flex-shrink: 0; }
.unread-badge { width: 20px; height: 20px; border-radius: 50%; background: var(--wa-green); color: #fff; font-size: 0.65rem; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.badge { font-size: 0.6rem; padding: 2px 6px; border-radius: 10px; font-weight: 600; }
.b-esc { background: #ffebee; color: #c62828; }
.b-dor { background: #e3f2fd; color: #1565c0; }
.b-human { background: #fff3e0; color: #e65100; }
.b-closed { background: #f3f3f3; color: #999; }
/* ── CHAT SCREEN ── */
.chat-screen { flex: 1; display: none; flex-direction: column; overflow: hidden; background: var(--wa-bg); }
.chat-screen.open { display: flex; position: fixed; inset: 0; z-index: 200; }
.cs-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #b8b8b8; background: #f0f2f5; }
.cs-empty .icon { font-size: 4rem; opacity: 0.35; }
.cs-empty .hint { font-size: 0.95rem; }
/* Chat header */
.cs-header { background: var(--wa-header); color: #fff; height: 56px; padding: 0 8px 0 4px; display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.cs-back { background: none; border: none; color: #fff; font-size: 1.5rem; cursor: pointer; padding: 8px; line-height: 1; display: flex; align-items: center; justify-content: center; min-width: 40px; min-height: 44px; }
.cs-avatar { width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.9rem; color: #fff; }
.cs-info { flex: 1; min-width: 0; }
.cs-name { font-weight: 600; font-size: 0.97rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cs-sub { font-size: 0.72rem; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.cs-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.hbtn { border: none; padding: 7px 14px; border-radius: 20px; font-size: 0.78rem; font-weight: 700; cursor: pointer; white-space: nowrap; min-height: 36px; }
.hbtn.hijack { background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.4); }
.hbtn.release { background: #e8f5e9; color: #1b5e20; }
/* Messages */
.cs-messages { flex: 1; overflow-y: auto; padding: 8px 3% 4px; display: flex; flex-direction: column; gap: 2px; }
.dor-banner { background: #fff3e0; color: #bf360c; padding: 7px 16px; font-size: 0.8rem; font-weight: 600; text-align: center; flex-shrink: 0; }
.mw { display: flex; margin-bottom: 2px; }
.mw.out { justify-content: flex-end; }
.mw.in  { justify-content: flex-start; }
.mw.sys { justify-content: center; }
.bubble { max-width: 78%; padding: 6px 9px 20px; border-radius: 7.5px; font-size: 0.9rem; line-height: 1.5; word-break: break-word; white-space: pre-wrap; box-shadow: var(--shadow-msg); position: relative; }
.mw.out .bubble { background: var(--wa-out); border-top-right-radius: 0; }
.mw.out .bubble::before { content: ''; position: absolute; top: 0; right: -8px; width: 0; height: 0; border-style: solid; border-width: 8px 0 0 8px; border-color: transparent transparent transparent var(--wa-out); }
.mw.in .bubble { background: var(--wa-in); border-top-left-radius: 0; }
.mw.in .bubble::before { content: ''; position: absolute; top: 0; left: -8px; width: 0; height: 0; border-style: solid; border-width: 8px 8px 0 0; border-color: transparent var(--wa-in) transparent transparent; }
.bubble.dor-b { background: #fff8e1; border: 1px solid #ffe082; }
.mw.out .bubble.dor-b::before { border-color: transparent transparent transparent #fff8e1; }
.bubble.sys-b { max-width: 85%; background: rgba(255,255,255,.76); font-size: 0.75rem; color: #667781; text-align: center; padding: 5px 14px; border-radius: 7px; box-shadow: none; font-style: italic; }
.bubble.sys-b::before { display: none; }
.dor-lbl { display: block; font-size: 0.62rem; color: #e65100; font-weight: 700; margin-bottom: 2px; }
.msg-ts { position: absolute; bottom: 4px; right: 8px; font-size: 0.65rem; color: var(--wa-muted); white-space: nowrap; }
.mw.out .msg-ts { color: #7fc77f; }
.date-sep { text-align: center; margin: 10px 0 6px; }
.date-sep span { background: rgba(255,255,255,.82); color: #667781; padding: 4px 14px; border-radius: 7px; font-size: 0.72rem; box-shadow: var(--shadow-msg); }
.sys-ev { text-align: center; margin: 6px 0; }
.sys-ev span { background: rgba(255,255,255,.75); color: #667781; font-size: 0.72rem; padding: 4px 14px; border-radius: 7px; box-shadow: var(--shadow-msg); }
/* Compose */
.cs-compose { display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px; padding-bottom: max(8px, env(safe-area-inset-bottom)); background: #f0f2f5; flex-shrink: 0; }
.cs-compose textarea { flex: 1; border: none; border-radius: 22px; padding: 10px 16px; font-size: 0.9rem; font-family: inherit; resize: none; outline: none; background: #fff; max-height: 130px; line-height: 1.5; color: var(--wa-text); }
.cs-compose textarea::placeholder { color: var(--wa-muted); }
.cs-send { width: 46px; height: 46px; border-radius: 50%; background: var(--wa-send); border: none; color: #fff; font-size: 1.1rem; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.cs-send:active { background: #008f72; }
/* Escalation log */
.esc-panel { flex: 1; overflow-y: auto; padding: 16px; background: #f0f2f5; }
.esc-card { background: #fff; border-radius: 8px; padding: 14px 16px; margin-bottom: 10px; border-left: 4px solid var(--wa-red); box-shadow: var(--shadow-msg); }
.esc-meta { font-size: 0.72rem; color: var(--wa-muted); margin-bottom: 4px; }
.esc-who { font-weight: 700; font-size: 0.9rem; margin-bottom: 7px; }
.esc-q { background: #fff5f5; border-radius: 6px; padding: 9px 12px; font-size: 0.87rem; color: #444; border-left: 2px solid #ffcdd2; line-height: 1.5; }
::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.15); border-radius: 2px; }
/* Desktop */
@media (min-width: 768px) {
  .list-screen { width: 360px; max-width: 360px; border-right: 1px solid var(--wa-divider); }
  .chat-screen { display: flex; position: static; }
  .cs-back { display: none; }
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
  closeChatScreen();
  renderList();
}
function closeChatScreen() {
  var cs = document.getElementById('chat-screen');
  cs.classList.remove('open');
  cs.innerHTML = '<div class="cs-empty"><div class="icon">🥐</div><div class="hint">בחר שיחה</div></div>';
}
function mobileBack() {
  closeChatScreen();
  selectedPhone = null;
  renderList();
}
function getConv(phone) {
  for (var i = 0; i < DATA.conversations.length; i++) {
    if (DATA.conversations[i].phone === phone) return DATA.conversations[i];
  }
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
    var preview = '';
    if (lastMsg) {
      var isFromCustomer = lastMsg.role === 'user';
      preview = isFromCustomer ? lastMsg.content : ('✓ ' + lastMsg.content);
    }
    if (preview.length > 52) preview = preview.slice(0, 52) + '…';
    var displayName = (c.name && c.name !== c.phone) ? esc(c.name) : c.phone;
    var av = initials(c.name, c.phone);
    var avColor = avatarColor(c.phone);
    var sel = c.phone === selectedPhone ? ' selected' : '';
    var borderCls = c.humanMode ? ' has-human' : (c.escalated ? ' has-esc' : '');
    var unread = isUnread(c) && c.phone !== selectedPhone;
    var timeHtml = '<span class="ci-time' + (unread ? ' unread' : '') + '">' + relTime(c.lastSeen) + '</span>';
    var badges = '';
    if (c.humanMode) badges += '<span class="badge b-human">👤</span>';
    else if (c.escalated) badges += '<span class="badge b-esc">🔴</span>';
    if (c.dorContactSent) badges += '<span class="badge b-dor">📇</span>';
    var rightCol = (unread ? '<div class="unread-badge">!</div>' : '') + badges;
    return '<div class="conv-item' + sel + borderCls + '" data-phone="' + esc(c.phone) + '">' +
      '<div class="ci-avatar" style="background:' + avColor + '">' + esc(av) + '</div>' +
      '<div class="ci-body">' +
        '<div class="ci-row1"><span class="ci-name" dir="auto">' + displayName + '</span>' + timeHtml + '</div>' +
        '<div class="ci-row2"><span class="ci-preview" dir="auto">' + esc(preview) + '</span>' +
        (rightCol ? '<div class="ci-right">' + rightCol + '</div>' : '') +
        '</div>' +
      '</div></div>';
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
    ? '<button class="hbtn release" onclick="doRelease()">🤖 החזר לליה</button>'
    : '<button class="hbtn hijack" onclick="doHijack()">👤 השתלט</button>';
  var msgsHtml = '';
  var lastDate = null;
  conv.messages.forEach(function(m) {
    if (m.timestamp) {
      var d = new Date(m.timestamp);
      if (!lastDate || !sameDay(lastDate, d)) {
        msgsHtml += '<div class="date-sep"><span>' + formatDaySep(m.timestamp) + '</span></div>';
        lastDate = d;
      }
    }
    var isCustomer = m.role === 'user';
    var isDor = m.sender === 'dor';
    var isSystem = m.sender === 'system';
    var wrapCls = isSystem ? 'sys' : (isCustomer ? 'in' : 'out');
    var bubCls = isSystem ? 'bubble sys-b' : (isDor ? 'bubble dor-b' : 'bubble');
    var dorLabel = isDor ? '<span class="dor-lbl">Dor</span>' : '';
    var ts = (m.timestamp && !isSystem) ? '<span class="msg-ts">' + msgTime(m.timestamp) + '</span>' : '';
    msgsHtml += '<div class="mw ' + wrapCls + '"><div class="' + bubCls + '" dir="auto">' + dorLabel + esc(m.content) + ts + '</div></div>';
  });
  if (conv.dorContactSent) msgsHtml += '<div class="sys-ev"><span>📇 כרטיס ויזיטה של דור נשלח ללקוח</span></div>';
  if (conv.conversationClosed) msgsHtml += '<div class="sys-ev"><span>✅ שיחה נסגרה</span></div>';
  var composeHtml = conv.humanMode
    ? '<div class="dor-banner">👤 מצב Dor — ליה שותקת. הודעות הולכות ישירות ללקוח.</div>' +
      '<div class="cs-compose"><textarea id="compose" rows="1" placeholder="כתוב הודעה..." onkeydown="composeKey(event)" oninput="autoResize(this)"></textarea>' +
      '<button class="cs-send" onclick="doSend()">➤</button></div>'
    : '';
  var cs = document.getElementById('chat-screen');
  cs.innerHTML =
    '<div class="cs-header">' +
      '<button class="cs-back" onclick="mobileBack()">&#8249;</button>' +
      '<div class="cs-avatar" style="background:' + avColor + '">' + esc(av) + '</div>' +
      '<div class="cs-info"><div class="cs-name" dir="auto">' + displayName + '</div>' +
      '<div class="cs-sub">' + conv.phone + ' &middot; ' + conv.messages.length + ' הודעות</div></div>' +
      '<div class="cs-actions">' + hijackBtn + '</div>' +
    '</div>' +
    '<div class="cs-messages" id="msgs">' + msgsHtml + '</div>' + composeHtml;
  cs.classList.add('open');
  setTimeout(function(){ var el=document.getElementById('msgs'); if(el) el.scrollTop=el.scrollHeight; }, 0);
}
function showEscalations() {
  selectedPhone = null;
  renderList();
  var cs = document.getElementById('chat-screen');
  if (!DATA.escalations.length) {
    cs.innerHTML = '<div class="cs-header"><button class="cs-back" onclick="mobileBack()">&#8249;</button><div class="cs-info"><div class="cs-name">Escalations</div></div></div><div class="cs-empty"><div class="icon">🎉</div><div class="hint">אין escalations</div></div>';
    cs.classList.add('open');
    return;
  }
  var html = DATA.escalations.map(function(e) {
    return '<div class="esc-card">' +
      '<div class="esc-meta">' + new Date(e.timestamp).toLocaleString('he-IL') + '</div>' +
      '<div class="esc-who">' + esc(e.customer) + ' <span style="color:#bbb;font-weight:400;font-size:0.78rem">(' + e.phone + ')</span></div>' +
      '<div class="esc-q">' + esc(e.question) + '</div></div>';
  }).join('');
  cs.innerHTML =
    '<div class="cs-header">' +
      '<button class="cs-back" onclick="mobileBack()">&#8249;</button>' +
      '<div class="cs-avatar" style="background:#e53935">❗</div>' +
      '<div class="cs-info"><div class="cs-name">Escalations Log</div>' +
      '<div class="cs-sub">' + DATA.escalations.length + ' שאלות</div></div></div>' +
    '<div class="esc-panel">' + html + '</div>';
  cs.classList.add('open');
}
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 130) + 'px';
}
function composeKey(e) {
  var isMobile = navigator.maxTouchPoints > 0;
  if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); doSend(); }
}
function doHijack() {
  fetch('/hijack?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone);
      if(c){c.humanMode=true;c.humanModeSince=new Date().toISOString();}
      selectConv(selectedPhone); renderList();
    });
}
function doRelease() {
  fetch('/release?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone);
      if(c){c.humanMode=false;c.humanModeSince=null;}
      selectConv(selectedPhone); renderList();
    });
}
function doSend() {
  var el = document.getElementById('compose');
  var msg = el ? el.value.trim() : '';
  if (!msg) return;
  if (el) { el.value = ''; el.style.height = 'auto'; }
  fetch('/send?token='+TOKEN, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:selectedPhone,message:msg})})
    .then(function(r){return r.json();}).then(function(){
      var c = getConv(selectedPhone);
      if (c) c.messages.push({role:'assistant',content:msg,sender:'dor',timestamp:new Date().toISOString()});
      selectConv(selectedPhone);
    });
}
var REFRESH_INTERVAL = 5;
var refreshSecs = REFRESH_INTERVAL;
var refreshEl = document.getElementById('refresh-timer');
setInterval(function(){
  refreshSecs--;
  if (refreshEl) refreshEl.textContent = refreshSecs;
  if (refreshSecs <= 0) refreshSecs = REFRESH_INTERVAL;
}, 1000);
document.getElementById('conv-list').addEventListener('click', function(e) {
  var item = e.target.closest('.conv-item');
  if (item && item.dataset.phone) selectConv(item.dataset.phone);
});
setInterval(function() {
  fetch('/conversations-data?token='+TOKEN)
    .then(function(r){return r.json();})
    .then(function(fresh){
      DATA.conversations = fresh.conversations;
      DATA.escalations = fresh.escalations;
      DATA.stats = fresh.stats;
      refreshSecs = REFRESH_INTERVAL;
      if (refreshEl) refreshEl.textContent = REFRESH_INTERVAL;
      updateStats();
      renderList();
      var unreadCount = DATA.conversations.filter(function(c){ return isUnread(c) && c.phone !== selectedPhone; }).length;
      document.title = unreadCount > 0 ? '(' + unreadCount + ') ליה' : 'ליה';
      if (selectedPhone) { var still = getConv(selectedPhone); if (still) selectConv(selectedPhone); }
    }).catch(function(){});
}, 5000);
document.addEventListener('keydown', function(e) {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    var s = document.getElementById('search');
    if (s) { s.focus(); s.select(); }
  }
});
updateStats();
renderList();`;

  res.send(`<!DOCTYPE html>
<html lang="he">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>ליה</title>
<style>${css}</style>
</head>
<body>
<div class="app">
  <div class="list-screen" id="list-screen">
    <div class="ls-header">
      <div class="ls-title">🥐 ליה <span class="live-dot"></span></div>
      <div class="ls-stats"><span id="s-total">—</span> שיחות · <span id="s-today">—</span> היום · <span id="s-esc">—</span> esc</div>
      <div class="ls-refresh"><span id="refresh-timer">5</span>s</div>
    </div>
    <div class="ls-search"><input id="search" type="search" placeholder="🔍  חפש שם או מספר..." oninput="renderList()"></div>
    <div class="ls-tabs">
      <div class="tab active" data-tab="all" onclick="setTab(this)">הכל <span class="tab-count">0</span></div>
      <div class="tab" data-tab="active" onclick="setTab(this)">פעיל <span class="tab-count">0</span></div>
      <div class="tab" data-tab="human" onclick="setTab(this)">👤 <span class="tab-count">0</span></div>
      <div class="tab" data-tab="escalated" onclick="setTab(this)">🔴 <span class="tab-count">0</span></div>
      <div class="tab" data-tab="log" onclick="setTab(this);showEscalations()">Log</div>
    </div>
    <div class="ls-list" id="conv-list"></div>
  </div>
  <div class="chat-screen" id="chat-screen">
    <div class="cs-empty"><div class="icon">🥐</div><div class="hint">בחר שיחה</div></div>
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

app.post("/morning-ping", async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  await sendWhatsAppTemplate(MANAGER_PHONE, "urban_morning_ping");
  res.json({ ok: true, sent_to: MANAGER_PHONE });
});

// Debug: send a plain-text test message to Dor and return the raw Meta response
app.post("/ping-dor", async (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_VERIFY_TOKEN) return res.status(403).json({ error: "Forbidden" });
  const url = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
  try {
    const result = await axios.post(
      url,
      { messaging_product: "whatsapp", to: MANAGER_PHONE, type: "text", text: { body: "🔔 בדיקה טכנית מהבוט — אם קיבלת את זה הכל תקין" } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` } }
    );
    res.json({ ok: true, manager_phone: MANAGER_PHONE, meta_response: result.data });
  } catch (error) {
    res.json({ ok: false, manager_phone: MANAGER_PHONE, error: error.response?.data || error.message });
  }
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

  setInterval(async () => {
    const now = Date.now();
    for (const [phone, conv] of Object.entries(conversations)) {
      if (phone === MANAGER_PHONE) continue;
      if (conv.conversationClosed || !conv.lastSeen || conv.messages.length === 0) continue;
      const silenceMs = now - new Date(conv.lastSeen).getTime();

      if (conv.humanMode) continue;

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

  // Send the morning template to Dor daily at 07:30 Israel time (UTC+3 summer / UTC+2 winter).
  // This opens the 24h WhatsApp messaging window so all manager alerts arrive as plain text.
  // Send immediately on startup to reopen the 24h window after any redeploy.
  sendWhatsAppTemplate(MANAGER_PHONE, "urban_morning_ping")
    .then(() => console.log("🌅 Startup ping sent to manager"))
    .catch((e) => console.error("Startup ping failed:", e.message));

  function scheduleMorningPing() {
    const now = new Date();
    const israelOffset = 3 * 60; // UTC+3 (IDT); adjust to 2 in winter if needed
    const israelNow = new Date(now.getTime() + israelOffset * 60 * 1000);
    const nextPing = new Date(israelNow);
    nextPing.setUTCHours(4, 30, 0, 0); // 07:30 Israel = 04:30 UTC (summer)
    if (nextPing <= israelNow) nextPing.setUTCDate(nextPing.getUTCDate() + 1);
    const msUntilPing = nextPing.getTime() - israelNow.getTime();
    setTimeout(async () => {
      await sendWhatsAppTemplate(MANAGER_PHONE, "urban_morning_ping");
      console.log("🌅 Morning ping sent to manager");
      setInterval(async () => {
        await sendWhatsAppTemplate(MANAGER_PHONE, "urban_morning_ping");
        console.log("🌅 Morning ping sent to manager");
      }, 24 * 60 * 60 * 1000);
    }, msUntilPing);
    console.log(`🌅 Morning ping scheduled in ${Math.round(msUntilPing / 60000)} min`);
  }
  scheduleMorningPing();
});
