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
let managerAwaitingAnswer = null;       // set when Dor sent an answer, waiting for כן/לא confirmation
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
  const params = {
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: buildSystemPrompt() + nameNote + langNote,
    messages: conversationMessages.map((m) => ({ role: m.role, content: m.content })),
  };
  // Retry up to 2 times on network errors (e.g. "Premature close")
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await anthropic.messages.create(params);
      return response.content[0].text;
    } catch (err) {
      const isRetryable = err.message && (
        err.message.includes('Premature close') ||
        err.message.includes('ECONNRESET') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('socket hang up') ||
        err.status === 529 || err.status === 503
      );
      if (isRetryable && attempt < 3) {
        console.warn(`⚠️  Claude API attempt ${attempt} failed (${err.message.split('\n')[0]}), retrying in ${attempt * 2}s...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      } else {
        throw err;
      }
    }
  }
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
  const normalizedAnswer = answer.trim();

  // Step 3: Dor sent כן/לא to confirm or cancel the proposed answer
  if (managerAwaitingAnswer) {
    const { pending, proposedAnswer } = managerAwaitingAnswer;
    if (normalizedAnswer === 'כן' || normalizedAnswer === 'כן ✅' || normalizedAnswer.toLowerCase() === 'yes') {
      managerAwaitingAnswer = null;
      const idx = pendingEscalations.findIndex(e => e.customerPhone === pending.customerPhone);
      if (idx !== -1) pendingEscalations.splice(idx, 1);
      savePendingEscalations();
      await sendWhatsAppMessage(pending.customerPhone, proposedAnswer);
      if (conversations[pending.customerPhone]) {
        conversations[pending.customerPhone].messages.push({ role: 'assistant', content: proposedAnswer, sender: 'dor', timestamp: new Date().toISOString() });
        conversations[pending.customerPhone].lastSeen = new Date().toISOString();
        saveConversations();
      }
      KB.faq.push({ id: `custom_${Date.now()}`, question: pending.question, answer: proposedAnswer });
      fs.writeFileSync(KB_FILE, JSON.stringify(KB, null, 2));
      await sendWhatsAppMessage(MANAGER_PHONE, `✅ תשובה נשלחה ל${pending.customerName} ונוספה לבסיס הידע!`);
      console.log(`📚 KB updated: "${pending.question}"`);
    } else if (normalizedAnswer === 'לא' || normalizedAnswer.toLowerCase() === 'no') {
      managerAwaitingAnswer = null;
      managerAwaitingConfirmation = null;
      await sendWhatsAppMessage(MANAGER_PHONE, `❌ תשובה בוטלה. השאלה של ${pending.customerName} נשארת ממתינה.`);
    } else {
      // Dor sent something else — treat it as a revised answer, ask again
      managerAwaitingAnswer = { pending, proposedAnswer: normalizedAnswer };
      await sendWhatsAppMessage(
        MANAGER_PHONE,
        `💬 תשובה מוצעת ל${pending.customerName}:\n"${normalizedAnswer}"\n\nענה *כן* לשליחה או *לא* לביטול`
      );
    }
    return;
  }

  // Step 2: Dor already saw the question — this message is his proposed answer
  if (managerAwaitingConfirmation) {
    const pending = managerAwaitingConfirmation;
    managerAwaitingConfirmation = null;
    managerAwaitingAnswer = { pending, proposedAnswer: normalizedAnswer };
    await sendWhatsAppMessage(
      MANAGER_PHONE,
      `💬 תשובה מוצעת ל${pending.customerName}:\n"${normalizedAnswer}"\n\nענה *כן* לשליחה או *לא* לביטול`
    );
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

  const css = `
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --wa-header: #075e54;
  --wa-chat-bg: #e5ddd5;
  --wa-out: #dcf8c6;
  --wa-in: #ffffff;
  --wa-send: #00a884;
  --wa-green: #25d366;
  --wa-divider: #e9edef;
  --muted: #667781;
  --shadow-sm: 0 1px 1px rgba(0,0,0,0.08);
}
* { box-sizing: border-box; }
body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; height: 100dvh; overflow: hidden; color: #111; }
.app { display: flex; height: 100dvh; overflow: hidden; }
/* Sidebar */
.sidebar { display: flex; flex-direction: column; width: 100%; background: #fff; flex-shrink: 0; }
.sidebar-header { background: var(--wa-header); color: #fff; height: 56px; display: flex; align-items: center; padding: 0 12px 0 16px; gap: 8px; flex-shrink: 0; }
.header-title { font-size: 1rem; font-weight: 700; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--wa-green); animation: pulse-dot 2s infinite; flex-shrink: 0; }
@keyframes pulse-dot { 0%{box-shadow:0 0 0 0 rgba(37,211,102,.7)} 70%{box-shadow:0 0 0 5px rgba(37,211,102,0)} 100%{box-shadow:0 0 0 0 rgba(37,211,102,0)} }
.header-stats { display: flex; gap: 4px; margin-right: auto; margin-left: auto; }
.stat { background: rgba(255,255,255,0.1); border-radius: 8px; padding: 3px 10px; text-align: center; }
.stat-num { font-size: 1rem; font-weight: 700; line-height: 1.2; }
.stat-label { font-size: 0.55rem; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.4px; }
.refresh-info { font-size: 0.68rem; opacity: 0.55; white-space: nowrap; flex-shrink: 0; }
.search-wrap { padding: 8px 10px; background: #f0f2f5; }
.search-wrap input { width: 100%; padding: 8px 16px; border-radius: 20px; border: none; background: #fff; font-size: 0.84rem; outline: none; color: #111; }
.search-wrap input::placeholder { color: var(--muted); }
.tabs { display: flex; border-bottom: 1px solid var(--wa-divider); background: #fff; }
.tab { flex: 1; padding: 10px 4px 9px; text-align: center; font-size: 0.72rem; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; user-select: none; }
.tab.active { color: var(--wa-header); border-bottom-color: var(--wa-green); font-weight: 600; }
.tab-count { display: inline-block; background: #eee; color: var(--muted); border-radius: 8px; padding: 0 5px; font-size: 0.62rem; font-weight: 600; margin-right: 2px; }
.tab.active .tab-count { background: rgba(7,94,84,0.12); color: var(--wa-header); }
.conv-list { overflow-y: auto; flex: 1; }
.no-results { padding: 48px 16px; text-align: center; color: #ccc; font-size: 0.87rem; }
.conv-item { padding: 10px 16px 10px 12px; border-bottom: 1px solid var(--wa-divider); cursor: pointer; display: flex; gap: 12px; align-items: center; border-right: 3px solid transparent; min-height: 72px; }
.conv-item:hover, .conv-item.selected { background: #f0f2f5; }
.conv-item.has-esc { border-right-color: #e53935; }
.conv-item.has-human { border-right-color: #f57c00; }
.ci-avatar { width: 49px; height: 49px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; color: #fff; }
.ci-body { flex: 1; min-width: 0; }
.ci-row1 { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 3px; }
.ci-name { font-weight: 600; font-size: 0.93rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-time { font-size: 0.68rem; color: var(--muted); flex-shrink: 0; margin-right: 4px; }
.ci-preview { font-size: 0.8rem; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-badges { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
.unread-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--wa-green); flex-shrink: 0; }
.badge { font-size: 0.61rem; padding: 2px 7px; border-radius: 20px; font-weight: 500; }
.b-esc { background: #ffebee; color: #c62828; }
.b-dor { background: #e3f2fd; color: #1565c0; }
.b-closed { background: #f3f3f3; color: #999; }
.b-fu { background: #fff3e0; color: #e65100; }
.b-human { background: #fff3e0; color: #e65100; }
/* Chat panel */
.chat-panel { flex: 1; display: none; flex-direction: column; background: var(--wa-chat-bg); overflow: hidden; }
.empty-state { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #b8afa6; }
.empty-state .icon { font-size: 3rem; opacity: 0.4; }
.empty-state .hint { font-size: 0.85rem; }
.chat-header { background: var(--wa-header); color: #fff; padding: 8px 12px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; min-height: 56px; }
.ch-back { display: none; background: none; border: none; color: #fff; font-size: 1.6rem; cursor: pointer; padding: 0 6px 0 0; line-height: 1; }
.ch-avatar { width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.95rem; color: #fff; }
.ch-info { flex: 1; min-width: 0; }
.ch-name { font-weight: 600; font-size: 0.95rem; }
.ch-sub { font-size: 0.68rem; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-actions { flex-shrink: 0; }
.hbtn { border: none; padding: 6px 14px; border-radius: 20px; font-size: 0.76rem; cursor: pointer; font-weight: 600; white-space: nowrap; }
.hbtn.hijack { background: rgba(255,255,255,0.15); color: #fff; border: 1px solid rgba(255,255,255,0.3); }
.hbtn.release { background: #e8f5e9; color: #2e7d32; }
.chat-messages { flex: 1; overflow-y: auto; padding: 8px 6%; display: flex; flex-direction: column; gap: 1px; }
.human-banner { background: #fff3e0; color: #bf360c; padding: 7px 16px; font-size: 0.8rem; font-weight: 500; flex-shrink: 0; text-align: center; }
.compose-box { display: flex; gap: 8px; padding: 8px 12px; padding-bottom: max(8px, env(safe-area-inset-bottom)); background: #f0f2f5; flex-shrink: 0; align-items: flex-end; }
.compose-box textarea { flex: 1; border-radius: 22px; border: none; padding: 10px 16px; font-size: 0.88rem; resize: none; outline: none; font-family: inherit; background: #fff; max-height: 130px; line-height: 1.5; }
.compose-box button { background: var(--wa-send); color: #fff; border: none; border-radius: 50%; width: 46px; height: 46px; font-size: 1rem; cursor: pointer; flex-shrink: 0; }
/* Message bubbles */
.bw { display: flex; margin-bottom: 2px; padding: 0 2px; }
.bw.u { justify-content: flex-end; }
.bw.l { justify-content: flex-start; }
.bubble { max-width: 75%; padding: 6px 10px 20px; border-radius: 8px; font-size: 0.88rem; line-height: 1.5; word-break: break-word; white-space: pre-wrap; position: relative; box-shadow: var(--shadow-sm); }
.bw.u .bubble { background: var(--wa-out); border-top-right-radius: 0; }
.bw.u .bubble::before { content:''; position:absolute; top:0; right:-8px; border:8px solid transparent; border-top-color:var(--wa-out); border-right:0; }
.bw.l .bubble { background: var(--wa-in); border-top-left-radius: 0; }
.bw.l .bubble::before { content:''; position:absolute; top:0; left:-8px; border:8px solid transparent; border-top-color:var(--wa-in); border-left:0; }
.dor-bubble { background: #fff8e1 !important; }
.dor-bubble::before { border-top-color: #fff8e1 !important; }
.dor-label { display: block; font-size: 0.62rem; color: #e65100; margin-bottom: 2px; font-weight: 600; }
.msg-time { position: absolute; bottom: 4px; right: 8px; font-size: 0.61rem; color: rgba(0,0,0,0.4); white-space: nowrap; }
.bw.l .msg-time { right: auto; left: 8px; }
.date-sep { text-align: center; margin: 12px 0 6px; }
.date-sep span { background: rgba(255,255,255,0.85); color: #667781; padding: 3px 14px; border-radius: 10px; font-size: 0.68rem; box-shadow: 0 1px 1px rgba(0,0,0,0.06); }
.sys-note { text-align: center; margin: 8px 0; }
.sys-note span { background: rgba(255,255,255,0.75); color: #667781; font-size: 0.71rem; padding: 3px 14px; border-radius: 12px; box-shadow: 0 1px 1px rgba(0,0,0,0.06); }
.esc-panel { flex: 1; overflow-y: auto; padding: 16px; }
.esc-card { background: #fff; border-radius: 10px; padding: 14px 16px; margin-bottom: 10px; border-right: 4px solid #e53935; box-shadow: var(--shadow-sm); }
.esc-meta { font-size: 0.71rem; color: var(--muted); margin-bottom: 4px; }
.esc-who { font-weight: 600; font-size: 0.87rem; margin-bottom: 7px; }
.esc-q { background: #fff5f5; border-radius: 6px; padding: 9px 12px; font-size: 0.85rem; color: #444; border-right: 2px solid #ffcdd2; line-height: 1.5; }
::-webkit-scrollbar { width: 3px; } ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.15); border-radius: 2px; }
@media (max-width: 700px) {
  .chat-panel { position: fixed; inset: 0; z-index: 20; }
  .chat-panel.mobile-open { display: flex; }
  .ch-back { display: block; }
}
@media (min-width: 701px) {
  .sidebar { width: 360px; max-width: 360px; border-left: 1px solid var(--wa-divider); }
  .chat-panel { display: flex; }
}`;

  const token = req.query.token;
  const js = `
var DATA = {conversations:[],escalations:[],stats:{total:0,today:0,escalations:0}};
var TOKEN = ` + JSON.stringify(token) + `;
var selectedPhone = null;
var currentTab = 'all';

function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function relTime(iso) {
  if (!iso) return '';
  var diff = Date.now() - new Date(iso).getTime();
  var m = Math.floor(diff/60000);
  if (m < 1) return 'עכשיו';
  if (m < 60) return m + ' דק';
  var h = Math.floor(m/60);
  if (h < 24) return h + ' שע';
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
  document.getElementById('chat-panel').innerHTML = '<div class="empty-state"><div class="icon">🥐</div><div class="hint">בחר שיחה מהרשימה</div><div class="brand-hint">ליה · אורבן בייקרי</div></div>';
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
    ? '<button class="hbtn release" onclick="doRelease()">🤖 החזר לליה</button>'
    : '<button class="hbtn hijack" onclick="doHijack()">👤 השתלט</button>';
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
    var isSystem = m.sender === 'system';
    if (isSystem) { msgsHtml += '<div class="sys-note"><span>' + esc(m.content) + '</span></div>'; return; }
    var cls = isUser ? 'l' : 'u';
    var bubbleCls = isDor ? 'bubble dor-bubble' : 'bubble';
    var extra = isDor ? '<span class="dor-label">Dor</span>' : '';
    var timeStr = m.timestamp ? '<span class="msg-time">' + msgTime(m.timestamp) + '</span>' : '';
    msgsHtml += '<div class="bw ' + cls + '"><div class="' + bubbleCls + '">' + esc(m.content) + extra + timeStr + '</div></div>';
  });
  if (conv.dorContactSent) msgsHtml += '<div class="sys-note"><span>📇 כרטיס ויזיטה של דור נשלח ללקוח</span></div>';
  if (conv.conversationClosed) msgsHtml += '<div class="sys-note"><span>✅ שיחה נסגרה</span></div>';
  var composeHtml = conv.humanMode
    ? '<div class="human-banner">👤 מצב Dor — ליה שותקת. הודעות הולכות ישירות ללקוח.</div>' +
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
function composeKey(e) { var isMobile = navigator.maxTouchPoints > 0; if (e.key === 'Enter' && !e.shiftKey && !isMobile) { e.preventDefault(); doSend(); } }
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
var refreshSecs = 5;
var refreshEl = document.getElementById('refresh-timer');
setInterval(function(){
  refreshSecs--;
  if (refreshEl) refreshEl.textContent = refreshSecs + 's';
  if (refreshSecs <= 0) refreshSecs = 5;
}, 1000);
// Delegated click
document.getElementById('conv-list').addEventListener('click', function(e) {
  var item = e.target.closest('.conv-item');
  if (item && item.dataset.phone) selectConv(item.dataset.phone);
});
// Auto-refresh every 5 seconds
setInterval(function() {
  fetch('/conversations-data?token='+TOKEN)
    .then(function(r){return r.json();})
    .then(function(fresh){
      DATA.conversations = fresh.conversations;
      DATA.escalations = fresh.escalations;
      DATA.stats = fresh.stats;
      refreshSecs = 5;
      if (refreshEl) refreshEl.textContent = '5s';
      updateStats();
      renderList();
      var unreadCount = DATA.conversations.filter(function(c){ return isUnread(c) && c.phone !== selectedPhone; }).length;
      document.title = unreadCount > 0 ? '(' + unreadCount + ') ליה — לוח בקרה' : 'ליה — לוח בקרה';
      if (selectedPhone) { var still = getConv(selectedPhone); if (still) selectConv(selectedPhone); }
    }).catch(function(){});
}, 5000);
fetch('/conversations-data?token='+TOKEN)
  .then(function(r){return r.json();})
  .then(function(fresh){
    DATA.conversations = fresh.conversations;
    DATA.escalations = fresh.escalations;
    DATA.stats = fresh.stats;
    updateStats();
    renderList();
  }).catch(function(){});
document.addEventListener('keydown', function(e) {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    var s = document.getElementById('search');
    if (s) { s.focus(); s.select(); }
  }
});`;

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
  <div class="sidebar">
    <div class="sidebar-header">
      <span class="header-title">🥐 ליה <span class="live-dot"></span></span>
      <div class="header-stats">
        <div class="stat"><div class="stat-num" id="s-total">—</div><div class="stat-label">שיחות</div></div>
        <div class="stat"><div class="stat-num" id="s-today">—</div><div class="stat-label">היום</div></div>
        <div class="stat"><div class="stat-num" id="s-esc">—</div><div class="stat-label">esc</div></div>
      </div>
      <span class="refresh-info"><span id="refresh-timer">5</span>s</span>
    </div>
    <div class="search-wrap"><input id="search" type="search" placeholder="חפש לפי שם או מספר..." oninput="renderList()"></div>
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
    <div class="empty-state"><div class="icon">🥐</div><div class="hint">בחר שיחה מהרשימה</div></div>
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

      // humanMode is permanent — only released manually by Dor
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
