/* Lia team app — vanilla JS, no build step.
 * Routes (hash): #/ · #/chat/<phone> · #/contacts · #/import · #/new?phone=&name=
 */
(function () {
  "use strict";

  // ── Icons (inline stroke SVG) ─────────────────────────────────────────────
  const I = {
    back: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    more: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5h.01M12 12h.01M12 19h.01"/></svg>',
    search: '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
    people: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.6 3.6-5.5 6.5-5.5s5.5 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.4 3.5 5.2"/></svg>',
    newChat: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M12 9v6M9 12h6"/></svg>',
    bot: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/></svg>`,
    person: (s) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`,
    bell: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    send: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12l16-8-6 16-2.5-6.5z"/></svg>',
    tpl: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
    addPerson: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="8" r="4"/><path d="M3 21c1.3-3.8 4-5.8 7-5.8 1.4 0 2.7.4 3.8 1.2M18 14v6M15 17h6"/></svg>',
    download: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    phone: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>',
    card: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="10" r="3"/><path d="M7.5 17c.9-2 2.6-3 4.5-3s3.6 1 4.5 3"/></svg>',
    globe: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.7 5.7 3.7 9s-1.2 6.3-3.7 9c-2.5-2.7-3.7-5.7-3.7-9S9.5 5.7 12 3z"/></svg>',
    sheet: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6M12 10v8"/></svg>',
    clip: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11l-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>',
    camera: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    gallery: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/></svg>',
    file: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    pin: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/></svg>',
    clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    x: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  // Lia's face (public/app/lia.svg) wherever Lia is the one acting.
  const LIA = (size) => `<img class="lia-face" src="lia.svg" width="${size}" height="${size}" alt="" aria-hidden="true">`;
  const tick = (status) => {
    if (status === "failed") return "";
    const read = status === "read";
    const two = status === "delivered" || read;
    const color = read ? "var(--tick-read)" : "var(--tick)";
    const label = read ? "נקרא" : two ? "נמסר" : "נשלח";
    const path = two ? "M1 6l3 3 6-7M6 9l1 1 6-8" : "M3 6l3 3 6-7";
    return `<svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${label}"><path d="${path}"/></svg>`;
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const side = $("#side");
  const main = $("#main");

  const AVATAR_COLORS = [
    ["#F1DCC0", "#6B3E12"], ["#E6E0F5", "#3E2C7A"], ["#D7E8F7", "#1B4A73"], ["#DDF1E3", "#0B5A30"],
    ["#FBE3E3", "#8A1C1C"], ["#FCEBD2", "#8A4B0C"], ["#E0F2F1", "#00574B"], ["#F3E5F5", "#6A1B6A"],
  ];
  const TEAM_COLORS = ["#11753F", "#6A3FB5", "#1B5E9E", "#A23B72", "#00695C", "#B45309"];
  const hash = (s) => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) | 0; return Math.abs(h); };
  const initial = (name, phone) => {
    const n = String(name || "").trim();
    if (n && !/^\d+$/.test(n)) return esc(Array.from(n)[0]);
    return esc(String(phone || "").slice(-2));
  };
  function avatar(name, phone, size, who) {
    const [bg, fg] = AVATAR_COLORS[hash(phone) % AVATAR_COLORS.length];
    const badge = who === "lia"
      ? `<span class="who lia" role="img" aria-label="ליה עונה">${LIA(18)}</span>`
      : who === "team" ? `<span class="who team" role="img" aria-label="הצוות עונה">${I.person(11)}</span>` : "";
    return `<div class="avatar ${size || ""}"><div class="circle" style="background:${bg};color:${fg}">${initial(name, phone)}</div>${badge}</div>`;
  }
  function fmtPhone(p) {
    const s = String(p || "");
    if (s.startsWith("972") && s.length === 12) return `0${s.slice(3, 5)}-${s.slice(5, 8)}-${s.slice(8)}`;
    return "+" + s;
  }
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  function listTime(iso) {
    if (!iso) return "";
    const d = new Date(iso), now = new Date();
    if (sameDay(d, now)) return d.toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return "אתמול";
    if (now - d < 6 * 864e5) return d.toLocaleDateString("he-IL", { weekday: "long" });
    return d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });
  }
  const clock = (iso) => iso ? new Date(iso).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "";
  function dayLabel(iso) {
    const d = new Date(iso), now = new Date();
    if (sameDay(d, now)) return "היום";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return "אתמול";
    return d.toLocaleDateString("he-IL", { weekday: "long", day: "numeric", month: "long" });
  }
  function teamColor(name) { return TEAM_COLORS[hash(name) % TEAM_COLORS.length]; }
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }
  function previewText(m) {
    if (!m) return "";
    const t = String(m.content || "").replace(/\s+/g, " ");
    if (m.sender === "lia") return "ליה: " + t;
    if (m.sender === "team") return (m.senderName || "צוות") + ": " + t;
    if (m.sender === "system") return t.replace(/^\[|\]$/g, "");
    return t;
  }
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── API ────────────────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const res = await fetch("/api" + path, {
      method: opts.method || (opts.body ? "POST" : "GET"),
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    if (res.status === 401 && state.me) { state.me = null; renderLogin(); throw new Error("unauthorized"); }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) { const e = new Error((data && data.error) || res.status); e.data = data; e.status = res.status; throw e; }
    return data;
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    me: null,
    convs: [],
    filter: "all",
    q: "",
    chat: null,           // full conversation currently open
    chatPhone: null,
    templates: null,
    contactFilter: "all",
    contactQ: "",
    importAutoSave: true,
    listRev: null,        // server rev of the last list we got — unchanged polls are tiny
    chatRev: null,
    chatAll: false,       // long chat: user asked for older messages
    searchResults: null,  // server-side search over all chats (incl. older than the list)
  };

  // ── Router ─────────────────────────────────────────────────────────────────
  function parseRoute() {
    const h = location.hash.replace(/^#/, "") || "/";
    const [pathPart, query = ""] = h.split("?");
    const params = Object.fromEntries(new URLSearchParams(query));
    const parts = pathPart.split("/").filter(Boolean);
    return { name: parts[0] || "list", arg: parts[1] ? decodeURIComponent(parts[1]) : null, params };
  }
  function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

  async function route() {
    if (!state.me) return;
    const r = parseRoute();
    document.body.classList.toggle("route-main", r.name !== "list");
    renderList();
    if (r.name === "chat" && r.arg) return openChat(r.arg);
    state.chatPhone = null; state.chat = null;
    if (r.name === "contacts") return renderContacts();
    if (r.name === "import") return renderImport();
    if (r.name === "new") return renderNew(r.params);
    main.innerHTML = `<div class="empty-main">${I.newChat}<span>בחרו שיחה מהרשימה</span></div>`;
  }
  window.addEventListener("hashchange", route);

  // ── Login, first setup, invites, install ───────────────────────────────────
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let installPrompt = null; // Android/desktop Chrome one-tap install
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener("appinstalled", () => { installPrompt = null; });

  const PIN_ERR = { wrong_pin: "קוד שגוי", locked: "יותר מדי ניסיונות — נסו שוב בעוד רבע שעה", too_many_attempts: "יותר מדי ניסיונות — נסו שוב בעוד רבע שעה" };
  const pinInput = (id, label, auto) => `
    <label class="sr-only" for="${id}">${label}</label>
    <input id="${id}" class="pin" dir="ltr" type="password" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="${auto || "current-password"}" placeholder="••••••" required>`;
  function loginShell(title, sub, inner) {
    document.body.classList.add("route-main");
    side.innerHTML = "";
    main.innerHTML = `
      <div class="login">
        <img class="logo" src="icon.svg" alt="">
        <h1>${title}</h1>
        ${sub ? `<p>${sub}</p>` : ""}
        ${inner}
      </div>`;
  }

  async function renderLogin() {
    const r = parseRoute();
    if (r.name === "join" && r.arg) return renderJoin(r.arg);
    let st;
    try { st = await api("/team/status"); } catch { loginShell("ליה · אורבן", "אין חיבור לשרת. נסו שוב בעוד רגע.", ""); return; }
    if (st.needsSetup) return renderOwnerSetup(true);
    const last = LS.get("lia_member");
    const chosen = st.members.find((m) => m.id === last);
    if (!chosen) {
      loginShell("ליה · אורבן בייקרי", "מי נכנס?", `
        <div class="who-list">${st.members.map((m) => `<button class="btn ghost big" data-member="${esc(m.id)}">${esc(m.name)}</button>`).join("")}</div>
        <p class="hint">עוד לא ברשימה? בקשו מדור קישור הזמנה.</p>`);
      main.querySelectorAll("[data-member]").forEach((b) => b.addEventListener("click", () => { LS.set("lia_member", b.dataset.member); renderLogin(); }));
      return;
    }
    loginShell(`היי ${esc(chosen.name)}`, "הקלידו את הקוד בן 6 הספרות", `
      <form id="login-form">
        ${pinInput("pin", "קוד כניסה")}
        <button class="btn big" type="submit">כניסה</button>
        <div class="err" id="login-err" role="alert"></div>
        <div class="links"><button type="button" class="link" data-switch>זה לא אני</button><button type="button" class="link" data-forgot>שכחתי קוד</button></div>
      </form>`);
    const pin = $("#pin");
    pin.focus();
    const submit = async () => {
      $("#login-err").textContent = "";
      try { await api("/login", { body: { id: chosen.id, pin: pin.value } }); await boot(); }
      catch (ex) { $("#login-err").textContent = PIN_ERR[ex.message] || "משהו השתבש, נסו שוב"; pin.value = ""; pin.focus(); }
    };
    $("#login-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    pin.addEventListener("input", () => { if (/^\d{6}$/.test(pin.value)) submit(); });
    main.querySelector("[data-switch]").addEventListener("click", () => { LS.set("lia_member", ""); renderLogin(); });
    main.querySelector("[data-forgot]").addEventListener("click", () => {
      if (chosen.role === "admin") renderOwnerSetup(false);
      else toast("בקשו מדור קישור הזמנה חדש");
    });
  }

  // First-ever setup (creates the admin) or admin "forgot my code":
  // a 6-digit code goes to the owner's WhatsApp, then they choose a PIN.
  function renderOwnerSetup(first) {
    loginShell(first ? "ברוכים הבאים לליה" : "איפוס קוד", first
      ? "הגדרה ראשונה: נשלח קוד אימות לוואטסאפ של דור"
      : "נשלח קוד אימות לוואטסאפ של דור", `
      <form id="otp-form">
        <button class="btn big" type="button" id="send-otp">שליחת קוד לוואטסאפ</button>
        <div id="otp-step" hidden>
          <p class="hint" id="otp-sent"></p>
          <label class="lbl" for="otp">קוד מהוואטסאפ</label>
          <input id="otp" class="pin" dir="ltr" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••">
          ${first ? `<label class="lbl" for="owner-name">השם שלך</label><input id="owner-name" class="name-input" type="text" value="דור" maxlength="40">` : ""}
          <label class="lbl" for="new-pin">בחרו קוד כניסה (6 ספרות)</label>
          ${pinInput("new-pin", "קוד כניסה חדש", "new-password")}
          <button class="btn big" type="submit">${first ? "יצירת חשבון" : "שמירת קוד"}</button>
        </div>
        <div class="err" id="otp-err" role="alert"></div>
        ${first ? "" : `<div class="links"><button type="button" class="link" data-back>חזרה</button></div>`}
      </form>`);
    const err = $("#otp-err");
    const sendBtn = $("#send-otp");
    sendBtn.addEventListener("click", async () => {
      err.textContent = ""; sendBtn.disabled = true;
      try {
        const r = await api("/team/owner-code", { body: {} });
        $("#otp-step").hidden = false;
        $("#otp-sent").innerHTML = `שלחנו קוד לוואטסאפ <bdi dir="ltr">${esc(r.sentTo)}</bdi>`;
        sendBtn.textContent = "שליחה חוזרת";
        $("#otp").focus();
        setTimeout(() => { sendBtn.disabled = false; }, 60000);
      } catch (ex) {
        sendBtn.disabled = false;
        err.textContent = ex.message === "wait" ? "חכו דקה לפני שליחה חוזרת"
          : "לא הצלחנו לשלוח. שלחו הודעה כלשהי מהטלפון של דור למספר של ליה, ונסו שוב.";
      }
    });
    const back = main.querySelector("[data-back]");
    if (back) back.addEventListener("click", renderLogin);
    $("#otp-form").addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = "";
      try {
        const me = await api("/team/owner-verify", { body: {
          code: $("#otp").value.trim(), pin: $("#new-pin").value, name: $("#owner-name") ? $("#owner-name").value : undefined,
        } });
        LS.set("lia_member", me.id);
        renderInstall(me.name);
      } catch (ex) {
        const left = ex.data && ex.data.left;
        err.textContent = {
          bad_pin: "קוד הכניסה שבחרתם צריך להיות 6 ספרות",
          wrong_code: `קוד האימות לא תואם להודעה בוואטסאפ${left ? ` (נשארו ${left} ניסיונות)` : ""}`,
          too_many: "יותר מדי ניסיונות — לחצו \"שליחה חוזרת\" לקוד חדש",
          expired: "עברו 10 דקות והקוד פג — לחצו \"שליחה חוזרת\"",
          no_code: "לחצו \"שליחה חוזרת\" לקבלת קוד",
        }[ex.message] || "משהו השתבש, נסו שוב";
      }
    });
  }

  async function renderJoin(token) {
    let inv;
    try { inv = await api("/team/invite/" + encodeURIComponent(token)); }
    catch { loginShell("הקישור לא בתוקף", "הקישור כבר נוצל או שעברו 48 שעות. בקשו מדור קישור חדש.", ""); return; }
    loginShell("הצטרפות לליה", `${inv.invitedBy ? esc(inv.invitedBy) + " הזמין/ה אותך" : "הוזמנת"} לתיבת השיחות של אורבן בייקרי`, `
      <form id="join-form">
        <label class="lbl" for="join-name">השם שלך (יופיע ללקוחות ליד ההודעות)</label>
        <input id="join-name" class="name-input" type="text" maxlength="40" required autocomplete="name">
        <label class="lbl" for="join-pin">בחרו קוד כניסה (6 ספרות)</label>
        ${pinInput("join-pin", "קוד כניסה", "new-password")}
        <button class="btn big" type="submit">הצטרפות</button>
        <div class="err" id="join-err" role="alert"></div>
      </form>`);
    $("#join-name").focus();
    $("#join-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const me = await api("/team/join", { body: { token, name: $("#join-name").value, pin: $("#join-pin").value } });
        LS.set("lia_member", me.id);
        history.replaceState(null, "", location.pathname + "#/");
        renderInstall(me.name);
      } catch (ex) {
        $("#join-err").textContent = { name_taken: "השם הזה כבר תפוס — הוסיפו שם משפחה", bad_pin: "הקוד צריך להיות 6 ספרות", bad_name: "חסר שם", invalid_invite: "הקישור כבר לא בתוקף" }[ex.message] || "משהו השתבש, נסו שוב";
      }
    });
  }

  // After joining: get Lia onto the home screen like a regular app.
  function renderInstall(name) {
    if (isStandalone()) return boot();
    const ios = isIOS();
    const shareIco = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v8h14v-8"/></svg>';
    const plusIco = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
    loginShell(`מעולה${name ? ", " + esc(name) : ""}!`, "עכשיו נתקין את ליה בטלפון — כמו אפליקציה רגילה", `
      <div class="install">
        ${ios ? `
          <ol class="steps">
            <li><span class="step-ico">${shareIco}</span><span>לוחצים על <b>שיתוף</b> בתחתית ספארי</span></li>
            <li><span class="step-ico">${plusIco}</span><span>בוחרים <b>"הוסף למסך הבית"</b> ← הוסף</span></li>
            <li><span class="step-ico"><img src="icon-180.png" alt="" width="28" height="28" style="border-radius:7px"></span><span>פותחים את <b>ליה</b> מהמסך הבית ונכנסים עם הקוד</span></li>
          </ol>
          <p class="hint">חייבים לפתוח בספארי. ההתראות באייפון עובדות רק מהאפליקציה שבמסך הבית.</p>`
        : `<button class="btn big" id="do-install" ${installPrompt ? "" : "hidden"}>התקנת האפליקציה</button>
           <p class="hint" id="install-alt" ${installPrompt ? "hidden" : ""}>בתפריט הדפדפן ⋮ בחרו <b>"התקנת אפליקציה"</b> או <b>"הוספה למסך הבית"</b>.</p>`}
        <button class="btn ghost big" id="skip-install">${ios ? "סיימתי / אמשיך בדפדפן" : "אחר כך"}</button>
      </div>`);
    const btn = $("#do-install");
    if (btn) btn.addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      const choice = await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      if (choice && choice.outcome === "accepted") toast("ליה הותקנה במסך הבית");
      boot();
    });
    $("#skip-install").addEventListener("click", boot);
  }

  // ── Chats list ─────────────────────────────────────────────────────────────
  function filteredConvs() {
    const base = state.q.trim() && state.searchResults ? state.searchResults : state.convs;
    return base.filter((c) => {
      if (state.filter === "unread" && !c.unread) return false;
      if (state.filter === "team" && !c.humanMode) return false;
      if (state.filter === "lia" && c.humanMode) return false;
      return true;
    });
  }
  const runSearch = debounce(async () => {
    const q = state.q.trim();
    if (!q) { state.searchResults = null; renderListItems(); return; }
    try {
      const d = await api("/conversations?q=" + encodeURIComponent(q));
      if (state.q.trim() === q) { state.searchResults = d.conversations; renderListItems(); }
    } catch { /* ignore */ }
  }, 250);

  function renderList() {
    if (!side.querySelector(".list-head")) {
      side.innerHTML = `
        <div class="list-head">
          <div class="brand">
            <div class="brand-titles"><h1>צ'אטים</h1><span class="sub" id="me-sub"></span></div>
            <a class="icon-btn" href="#/contacts" aria-label="אנשי קשר">${I.people}</a>
            <button class="icon-btn" data-act="menu" aria-label="תפריט">${I.more}</button>
          </div>
          <label class="search">${I.search}<span class="sr-only">חיפוש שיחות</span>
            <input id="list-q" type="search" placeholder="חיפוש שם, טלפון או הודעה" autocomplete="off">
          </label>
          <div class="chips" role="tablist" aria-label="סינון">
            <button class="chip" role="tab" data-filter="all">הכל</button>
            <button class="chip" role="tab" data-filter="unread">לא נקראו</button>
            <button class="chip" role="tab" data-filter="team">אצל הצוות</button>
            <button class="chip" role="tab" data-filter="lia">אצל ליה</button>
          </div>
        </div>
        <div id="waiting"></div>
        <div class="scroll" id="conv-list"></div>
        <a class="fab" href="#/new" aria-label="שיחה חדשה">${I.newChat}</a>`;
      $("#list-q").addEventListener("input", (e) => { state.q = e.target.value; runSearch(); });
    }
    $("#me-sub").textContent = `אורבן בייקרי · ${state.me ? state.me.name : ""}`;
    side.querySelectorAll("[data-filter]").forEach((b) => {
      const on = b.dataset.filter === state.filter;
      b.classList.toggle("on", on); b.setAttribute("aria-selected", on);
    });
    renderListItems();
  }

  function renderListItems() {
    const waiting = state.convs.filter((c) => c.waitingForTeam);
    const w = $("#waiting");
    if (w) {
      w.innerHTML = waiting.length ? `
        <button class="waiting-row" data-open="${esc(waiting[0].phone)}">
          <span class="w-ico">${I.bell}</span>
          <span class="w-title">ליה מחכה לכם</span>
          <span class="w-meta">${esc(waiting.map((c) => c.name).join(", "))}</span>
          <span class="count lia">${waiting.length}</span>
        </button>` : "";
    }
    const list = $("#conv-list");
    if (!list) return;
    const items = filteredConvs();
    if (!items.length) {
      list.innerHTML = `<div class="empty">${state.q.trim() ? "לא נמצאו שיחות" : state.convs.length ? "אין שיחות שמתאימות לסינון" : "עדיין אין שיחות.<br>כשלקוחות יכתבו לליה, השיחות יופיעו כאן."}</div>`;
      return;
    }
    list.innerHTML = items.map((c) => {
      const lm = c.lastMessage;
      const out = lm && (lm.sender === "lia" || lm.sender === "team");
      const sel = c.phone === state.chatPhone ? " sel" : "";
      return `
        <a class="row${sel}" href="#/chat/${esc(c.phone)}">
          ${avatar(c.name, c.phone, "", c.humanMode ? "team" : "lia")}
          <div class="body">
            <div class="l1"><span class="name">${esc(c.name)}</span><span class="time${c.unread ? " hot" : ""}">${esc(listTime(c.lastSeen))}</span></div>
            <div class="l2">
              ${out ? tick(lm.status) : ""}
              <span class="preview">${esc(previewText(lm))}</span>
              ${c.unread ? `<span class="count" aria-label="${c.unread} לא נקראו">${c.unread}</span>` : ""}
            </div>
          </div>
        </a>`;
    }).join("");
  }

  side.addEventListener("click", (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) { state.filter = f.dataset.filter; renderList(); return; }
    const o = e.target.closest("[data-open]");
    if (o) { go("#/chat/" + o.dataset.open); return; }
    if (e.target.closest('[data-act="menu"]')) openMenu();
  });

  async function loadConvs(force) {
    try {
      const data = await api("/conversations" + (state.listRev && !force ? "?rev=" + state.listRev : ""));
      if (data.unchanged) return;
      state.listRev = data.rev;
      state.convs = data.conversations;
      renderListItems();
      updateBadge();
    } catch { /* offline or logged out */ }
  }
  function updateBadge() {
    const n = state.convs.reduce((s, c) => s + (c.unread ? 1 : 0), 0);
    document.title = n ? `(${n}) ליה · אורבן` : "ליה · אורבן";
    if (navigator.setAppBadge) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  async function openChat(phone) {
    const fresh = state.chatPhone !== phone;
    state.chatPhone = phone;
    renderListItems();
    if (fresh) {
      state.chat = null;
      state.chatRev = null;
      state.chatAll = false;
      main.innerHTML = `
        <div class="pane chat" style="height:100%;width:100%">
          <header class="topbar" id="chat-head"></header>
          <div class="msgs" id="msgs" aria-live="polite"></div>
          <div class="dock" id="dock"></div>
        </div>`;
    }
    await refreshChat(true);
  }

  async function refreshChat(scroll) {
    const phone = state.chatPhone;
    if (!phone) return;
    let c;
    const qs = [];
    if (state.chatRev && state.chat) qs.push("rev=" + state.chatRev);
    if (state.chatAll) qs.push("all=1");
    try { c = await api("/conversations/" + encodeURIComponent(phone) + (qs.length ? "?" + qs.join("&") : "")); }
    catch (e) {
      if (e.status === 404) { main.innerHTML = `<div class="empty-main">השיחה לא נמצאה</div>`; }
      return;
    }
    if (state.chatPhone !== phone) return;
    if (c.unchanged) return;
    state.chatRev = c.rev;
    const prev = state.chat;
    state.chat = c;
    const local = state.convs.find((x) => x.phone === phone);
    if (local) { local.unread = 0; renderListItems(); updateBadge(); }

    renderChatHead(c);
    const box = $("#msgs");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    if (!prev || prev.messages.length !== c.messages.length || JSON.stringify(prev.messages.slice(-5)) !== JSON.stringify(c.messages.slice(-5))) {
      const older = c.olderCount ? `<button class="day" data-act="older" style="border:0">הצגת ${c.olderCount} הודעות קודמות</button>` : "";
      box.innerHTML = older + renderMessages(c.messages);
      if (scroll || nearBottom) box.scrollTop = box.scrollHeight;
    }
    const dockKey = [c.humanMode, c.windowOpen, c.waitingForTeam, c.pendingQuestion, c.humanBy].join("|");
    if (!prev || dockKey !== state.dockKey) { state.dockKey = dockKey; renderDock(c); }
  }

  function renderChatHead(c) {
    const status = c.humanMode
      ? `<span class="t2 team">${I.person(12)} ${esc(c.humanBy || "הצוות")} בשיחה · ליה בהמתנה</span>`
      : `<span class="t2 lia">${LIA(16)} ליה עונה בשיחה</span>`;
    $("#chat-head").innerHTML = `
      <a class="icon-btn back-btn" href="#/" aria-label="חזרה לצ'אטים">${I.back}</a>
      ${avatar(c.name, c.phone, "sm")}
      <div class="titles"><span class="t1">${esc(c.name)}</span>${status}</div>
      <button class="icon-btn" data-act="chat-menu" aria-label="עוד">${I.more}</button>`;
  }

  function renderMessages(msgs) {
    let html = "", lastDay = null, lastSide = null;
    for (const m of msgs) {
      if (m.timestamp) {
        const d = new Date(m.timestamp).toDateString();
        if (d !== lastDay) { html += `<div class="day">${esc(dayLabel(m.timestamp))}</div>`; lastDay = d; lastSide = null; }
      }
      if (m.sender === "system") {
        const t = String(m.content || "").replace(/^\[|\]$/g, "");
        html += `<div class="sys">${esc(t)}</div>`; lastSide = null; continue;
      }
      const out = m.sender !== "user";
        const sideKey = out ? "out" : "in";
      const gap = lastSide && lastSide !== sideKey ? " gap" : "";
      lastSide = sideKey;
      let who = "";
      if (m.sender === "lia") who = `<span class="who lia">${LIA(16)} ליה</span>`;
      else if (m.sender === "team") who = `<span class="who" style="color:${teamColor(m.senderName)}">${esc(m.senderName || "צוות")}</span>`;
      const tpl = m.template ? `<span class="tpl">תבנית</span>` : "";
      const meta = out
        ? (m.status === "failed"
          ? `<span class="meta failed">לא נשלח · ${esc(clock(m.timestamp))}</span>`
          : `<span class="meta">${esc(clock(m.timestamp))} ${tick(m.status)}</span>`)
        : `<span class="meta">${esc(clock(m.timestamp))}</span>`;
      html += `<div class="bubble ${sideKey}${gap}${m.mediaId && (m.media === "image" || m.media === "sticker" || m.media === "video") ? " has-media" : ""}">${who}${tpl}${renderBody(m)}${meta}</div>`;
    }
    return html || `<div class="sys">אין הודעות עדיין</div>`;
  }

  function mediaUrl(m, download) {
    const q = [];
    if (m.filename) q.push("name=" + encodeURIComponent(m.filename));
    if (download) q.push("download=1");
    return `/api/media/${encodeURIComponent(m.mediaId)}${q.length ? "?" + q.join("&") : ""}`;
  }
  function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; }

  function renderBody(m) {
    const cap = m.caption ? `<span class="txt">${esc(m.caption)}</span>` : "";
    if (m.location) {
      const href = `https://maps.google.com/?q=${encodeURIComponent(m.location.lat + "," + m.location.lng)}`;
      return `<a class="doc" href="${href}" target="_blank" rel="noopener">${I.pin}<span class="dn">${esc(m.location.name || "מיקום")}</span></a>`;
    }
    if (!m.mediaId) return `<span class="txt${m.media ? " media" : ""}">${esc(m.content)}</span>`;
    if (m.media === "image" || m.media === "sticker") {
      return `<a href="${mediaUrl(m)}" target="_blank" rel="noopener" class="media-link"><img class="media-img${m.media === "sticker" ? " sticker" : ""}" src="${mediaUrl(m)}" alt="${esc(m.caption || "תמונה")}" loading="lazy"></a>${cap}`;
    }
    if (m.media === "video") return `<video class="media-img" src="${mediaUrl(m)}" controls preload="metadata"></video>${cap}`;
    if (m.media === "audio" || m.media === "voice") return `<audio class="media-audio" src="${mediaUrl(m)}" controls preload="none"></audio>`;
    const name = m.filename || (m.mimeType === "application/pdf" ? "מסמך.pdf" : "קובץ");
    return `<a class="doc" href="${mediaUrl(m, true)}" download="${esc(name)}">${I.file}<span class="dn">${esc(name)}</span></a>${cap}`;
  }

  function renderDock(c) {
    const dock = $("#dock");
    const draft = $("#composer-text") ? $("#composer-text").value : "";
    let html = "";
    if (!c.windowOpen) {
      html = `
        <div class="closed-window">
          <div class="info">${I.clock}<span>הלקוח לא כתב ב-24 השעות האחרונות, ולכן WhatsApp מאפשרת לשלוח לו עכשיו רק תבנית מאושרת (גם אם כבר דיברתם בעבר). ברגע שהוא עונה — כותבים חופשי שוב.</span></div>
          <button class="btn big" data-act="pick-template">${I.tpl} בחירת תבנית</button>
          ${c.humanMode ? "" : `<div class="b" style="font-size:12.5px">ליה תענה אוטומטית אם הלקוח יכתוב.</div>`}
        </div>`;
      dock.innerHTML = html;
      dock.parentElement.classList.remove("lia-mode");
      return;
    }
    if (c.humanMode) {
      html += `<div class="resume"><span class="pill">${LIA(18)} ליה בהמתנה <button data-act="release">החזר לליה</button></span></div>`;
    } else {
      html += `
        <div class="lia-bar">
          <span class="ico">${LIA(36)}</span>
          <span class="txts"><span class="a">ליה מטפלת בשיחה</span><span class="b">ברגע שתכתבו — ליה עוצרת</span></span>
          <button class="btn" data-act="take">קח את השיחה</button>
        </div>`;
    }
    if (c.pendingQuestion) {
      html += `
        <div class="question">
          <span>ליה לא ידעה לענות על: <q>${esc(c.pendingQuestion)}</q></span>
          <label><input type="checkbox" id="save-kb" checked> לשמור את התשובה שלי לליה לפעם הבאה</label>
        </div>`;
    }
    html += `
      <form class="composer" id="composer">
        <div class="field">
          <label class="sr-only" for="composer-text">הודעה</label>
          <textarea id="composer-text" rows="1" placeholder="${c.humanMode ? "הודעה" : "הקלידו כדי לענות בעצמכם"}" enterkeyhint="send"></textarea>
          <button type="button" class="icon-btn" data-act="pick-template" aria-label="תבנית">${I.tpl}</button>
          <button type="button" class="icon-btn" data-act="attach" aria-label="צירוף תמונה או קובץ">${I.clip}</button>
          <button type="button" class="icon-btn" data-act="camera" aria-label="מצלמה">${I.camera}</button>
        </div>
        <button class="send" type="submit" aria-label="שלח">${I.send}</button>
      </form>`;
    dock.innerHTML = html;
    dock.parentElement.classList.toggle("lia-mode", !c.humanMode);
    const ta = $("#composer-text");
    ta.value = draft;
    autoGrow(ta);
    ta.addEventListener("input", () => autoGrow(ta));
    ta.addEventListener("keydown", (e) => {
      // Enter sends on desktop; on phones Enter adds a line (send button instead).
      if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches) { e.preventDefault(); sendMessage(); }
    });
    $("#composer").addEventListener("submit", (e) => { e.preventDefault(); sendMessage(); });
  }
  function autoGrow(ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }

  let sending = false;
  async function sendMessage() {
    const ta = $("#composer-text");
    const text = ta.value.trim();
    if (!text || sending) return;
    sending = true;
    const saveKB = $("#save-kb") ? $("#save-kb").checked : false;
    try {
      await api(`/conversations/${state.chatPhone}/send`, { body: { text, saveToKB: saveKB } });
      ta.value = ""; autoGrow(ta);
      await refreshChat(true);
      loadConvs(true);
    } catch (e) {
      if (e.status === 409) { toast("עברו 24 שעות — אפשר לשלוח רק תבנית"); await refreshChat(); }
      else if (e.status === 502) toast("ההודעה לא נשלחה: " + ((e.data && e.data.detail) || "שגיאה מ-WhatsApp"));
      else toast("ההודעה לא נשלחה, נסו שוב");
    } finally { sending = false; }
  }

  main.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const a = act.dataset.act;
    if (a === "take" || a === "release") {
      try {
        await api(`/conversations/${state.chatPhone}/${a}`, { method: "POST", body: {} });
        await refreshChat(true); loadConvs(true);
        if (a === "release") toast("ליה חזרה לענות בשיחה");
      } catch { toast("משהו השתבש, נסו שוב"); }
    } else if (a === "pick-template") {
      openTemplateSheet(state.chatPhone, state.chat && state.chat.name);
    } else if (a === "chat-menu") {
      openChatMenu();
    } else if (a === "older") {
      state.chatAll = true; state.chatRev = null; state.chat = null;
      await refreshChat(false);
      $("#msgs").scrollTop = 0;
    } else if (a === "attach") {
      openAttachSheet();
    } else if (a === "camera") {
      pickFiles("image/*,video/*", "environment");
    }
  });

  // ── Attachments ────────────────────────────────────────────────────────────
  const MAX_FILE = 30 * 1024 * 1024; // server limit (file is relayed through our server)
  function openAttachSheet() {
    openSheet("צירוף", `
      <div style="display:flex;flex-direction:column">
        <button class="opt" data-pick="gallery"><span class="oi">${I.gallery}</span><span class="ot"><span class="o1">תמונות וסרטונים</span><span class="o2">מהגלריה</span></span></button>
        <button class="opt" data-pick="camera"><span class="oi">${I.camera}</span><span class="ot"><span class="o1">מצלמה</span><span class="o2">צילום עכשיו</span></span></button>
        <button class="opt" data-pick="file"><span class="oi">${I.file}</span><span class="ot"><span class="o1">קובץ</span><span class="o2">PDF, מסמך, תפריט — עד 30MB</span></span></button>
      </div>`, (root, close) => {
      root.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => {
        const k = b.dataset.pick;
        close();
        if (k === "gallery") pickFiles("image/*,video/*", null, true);
        else if (k === "camera") pickFiles("image/*,video/*", "environment");
        else pickFiles("", null, true);
      }));
    });
  }

  function pickFiles(accept, capture, multiple) {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    if (capture) input.setAttribute("capture", capture);
    if (multiple) input.multiple = true;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.remove();
      if (files.length) openMediaPreview(files.slice(0, 10));
    });
    document.body.appendChild(input);
    input.click();
  }

  // Phones produce huge photos (and HEIC/WebP). WhatsApp images must be
  // JPEG/PNG ≤ 5MB, so re-encode big or unusual images to a 2048px JPEG.
  async function prepareImage(file) {
    if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
    const ok = (file.type === "image/jpeg" || file.type === "image/png") && file.size <= 4.5 * 1024 * 1024;
    if (ok) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
      if (!blob) return file;
      return new File([blob], (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch { return file; } // undecodable (e.g. HEIC on Android) → sent as a document
  }

  function openMediaPreview(files) {
    const phone = state.chatPhone;
    const urls = [];
    const items = files.map((f) => {
      if (f.type.startsWith("image/")) { const u = URL.createObjectURL(f); urls.push(u); return `<img class="pv-img" src="${u}" alt="">`; }
      if (f.type.startsWith("video/")) { const u = URL.createObjectURL(f); urls.push(u); return `<video class="pv-img" src="${u}" muted playsinline></video>`; }
      return `<div class="doc">${I.file}<span class="dn">${esc(f.name)} · ${fmtSize(f.size)}</span></div>`;
    }).join("");
    const tooBig = files.filter((f) => f.size > MAX_FILE);
    const close = openSheet(files.length > 1 ? `שליחת ${files.length} קבצים` : "שליחה", `
      <div class="form">
        <div class="pv-grid">${items}</div>
        ${tooBig.length ? `<div class="info">${esc(tooBig.map((f) => f.name).join(", "))} גדול מ-30MB ולא יישלח</div>` : ""}
        <div class="f"><label for="pv-caption">כיתוב (לא חובה)</label><input id="pv-caption" type="text" maxlength="1024" placeholder="הוסיפו כיתוב"></div>
        <button class="btn big" data-send-media>${I.send} שליחה</button>
        <div class="pv-status" role="status"></div>
      </div>`, (root, closeSheet) => {
      const btn = root.querySelector("[data-send-media]");
      const status = root.querySelector(".pv-status");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const caption = root.querySelector("#pv-caption").value.trim();
        const list = files.filter((f) => f.size <= MAX_FILE);
        let sent = 0;
        for (let i = 0; i < list.length; i++) {
          status.textContent = list.length > 1 ? `שולח ${i + 1} מתוך ${list.length}…` : "שולח…";
          const f = await prepareImage(list[i]);
          try {
            const res = await fetch(`/api/conversations/${phone}/media`, {
              method: "POST",
              credentials: "same-origin",
              headers: {
                "Content-Type": f.type || "application/octet-stream",
                "X-Filename": encodeURIComponent(f.name || "file"),
                "X-Caption": encodeURIComponent(i === 0 ? caption : ""),
              },
              body: f,
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              if (res.status === 409) { toast("עברו 24 שעות — אפשר לשלוח רק תבנית"); break; }
              toast(`${f.name}: לא נשלח${d.detail ? " — " + d.detail : ""}`);
              continue;
            }
            sent++;
          } catch { toast(`${f.name}: לא נשלח, בדקו חיבור`); }
        }
        urls.forEach((u) => URL.revokeObjectURL(u));
        closeSheet();
        if (sent) { await refreshChat(true); loadConvs(); }
      });
    });
    return close;
  }

  // ── Sheets ─────────────────────────────────────────────────────────────────
  // Bottom sheets. Close by: ✕ button, tapping the dimmed backdrop, swiping the
  // sheet down, Escape, or the phone's Back (Android) / swipe-back (iOS) —
  // each sheet pushes a history entry so Back closes it instead of the app.
  const openSheets = [];
  let ignorePops = 0; // our own history.back() calls when a sheet closes
  function openSheet(title, html, onMount) {
    const back = document.createElement("div");
    back.className = "sheet-back";
    back.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="sheet-head"><div class="grab" aria-hidden="true"></div>
          <div class="sheet-title"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="סגירה">${I.x}</button></div>
        </div>
        <div class="sheet-body">${html}</div>
      </div>`;
    const sheet = back.querySelector(".sheet");
    let closed = false;
    const entry = { close: () => doClose(false) };
    function doClose(fromHistory) {
      if (closed) return;
      closed = true;
      back.remove();
      document.removeEventListener("keydown", onKey);
      const i = openSheets.indexOf(entry);
      if (i !== -1) openSheets.splice(i, 1);
      if (!fromHistory && history.state && history.state.sheet) { ignorePops++; history.back(); }
    }
    entry.fromHistory = () => doClose(true);
    const close = () => doClose(false);
    const onKey = (e) => { if (e.key === "Escape") close(); };
    back.addEventListener("click", (e) => {
      const link = e.target.closest("a[href^='#']");
      if (link) { doClose(true); return; } // navigating: let the link change the route
      if (e.target === back || e.target.closest("[data-close]")) close();
    });
    // Swipe down on the header to dismiss.
    const head = back.querySelector(".sheet-head");
    let startY = null;
    head.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
    head.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      const dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    head.addEventListener("touchend", (e) => {
      const dy = startY === null ? 0 : e.changedTouches[0].clientY - startY;
      startY = null;
      if (dy > 80) close(); else sheet.style.transform = "";
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(back);
    openSheets.push(entry);
    history.pushState({ sheet: true }, "");
    if (onMount) onMount(back, close);
    const f = back.querySelector(".sheet-body input:not([type=radio]):not([type=checkbox]), .sheet-body textarea");
    if (f && matchMedia("(pointer: fine)").matches) f.focus(); // don't pop the keyboard on phones
    return close;
  }
  window.addEventListener("popstate", () => {
    if (ignorePops > 0) { ignorePops--; return; }
    const top = openSheets[openSheets.length - 1];
    if (top) top.fromHistory();
  });
  function closeAllSheets() { while (openSheets.length) openSheets[openSheets.length - 1].close(); }

  // Templates come live from Meta: only APPROVED ones, with their real text.
  async function loadTemplates(refresh) {
    if (!state.templates || refresh) {
      const d = await api("/templates" + (refresh ? "?refresh=1" : ""));
      state.templates = d.templates || [];
      state.templatesOthers = d.others || [];
      state.templatesError = d.error || null;
      state.templatesDetail = d.detail || null;
    }
    return state.templates;
  }
  const tplKey = (t) => `${t.name}|${t.language}`;
  function tplFill(t, values) {
    const map = new Map(t.params.map((p, i) => [p.key, values[i] || ""]));
    return (t.header ? t.header + "\n" : "") + t.text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => map.get(k) || `[${k === "1" ? "שם" : k}]`);
  }
  function tplOthers() {
    const o = state.templatesOthers || [];
    if (!o.length) return "";
    return `<div class="section-title" style="padding:10px 0 4px">לא זמינות לשליחה</div>` + o.map((t) => `
      <div class="tpl-opt" aria-disabled="true" style="opacity:.6"><span class="tt"><span class="t1">${esc(t.name)}</span><span class="t2">${esc(t.status)}${t.reason ? " · " + esc(t.reason) : ""}</span></span></div>`).join("");
  }
  const tplOthersWrap = (html) => html + tplOthers();
  function tplEmpty() {
    const err = state.templatesError;
    const msg = err === "no_waba"
      ? "לא מצאנו את חשבון ה-WhatsApp Business. הוסיפו ב-Railway את WHATSAPP_BUSINESS_ACCOUNT_ID (WhatsApp Manager ← Business account info / API Setup)."
      : err === "meta_error"
        ? "Meta החזירה שגיאה בקריאת התבניות. בדקו שהטוקן בתוקף ושיש לו הרשאת whatsapp_business_management."
        : "עדיין אין תבניות מאושרות. יוצרים ב-WhatsApp Manager ← Message templates, ותבנית מופיעה כאן ברגע ש-Meta מאשרת אותה.";
    const detail = err && state.templatesDetail ? `<span class="err-detail" dir="ltr">${esc(state.templatesDetail)}</span>` : "";
    return `<div class="info">${I.clock}<span>${msg}${detail}</span></div>${tplOthers()}
      <button type="button" class="btn ghost" data-tpl-refresh style="margin-top:8px">רענון</button>`;
  }
  // Template picker + variable fields + live preview, used by the chat sheet and the new-chat page.
  function tplPicker(root, tpls, getFirstName) {
    const list = root.querySelector("[data-tpl-list]");
    const fields = root.querySelector("[data-tpl-fields]");
    const preview = root.querySelector("[data-tpl-preview]");
    if (!tpls.length) { list.innerHTML = tplEmpty(); fields.innerHTML = ""; preview.textContent = ""; return { selected: () => null, values: () => [] }; }
    list.innerHTML = tplOthersWrap(tpls.map((t, i) => `
      <label class="tpl-opt"><span class="tt"><span class="t1">${esc(t.label)}${tpls.some((x, j) => j !== i && x.name === t.name) ? ` · ${esc(t.language)}` : ""}</span><span class="t2">${esc(t.text)}</span></span>
      <input type="radio" name="tpl" value="${esc(tplKey(t))}" ${i === 0 ? "checked" : ""}></label>`).join(""));
    const selected = () => tpls.find((t) => tplKey(t) === (list.querySelector('input[name="tpl"]:checked') || {}).value) || null;
    const values = () => Array.from(fields.querySelectorAll("[data-param]")).map((x) => x.value.trim());
    const renderFields = () => {
      const t = selected();
      const first = (getFirstName() || "").trim();
      fields.innerHTML = t.params.map((p, i) => `
        <div class="f"><label for="tp-${i}">${i === 0 && p.firstName ? "שם הלקוח בהודעה" : `ערך עבור ${esc(p.key === String(i + 1) ? "{{" + p.key + "}}" : p.key)}`}</label>
        <input id="tp-${i}" type="text" data-param="${i}" value="${i === 0 && !/^\d+$/.test(first) ? esc(first) : ""}" required></div>`).join("");
      update();
    };
    const update = () => { const t = selected(); preview.textContent = t ? tplFill(t, values()) : ""; };
    list.addEventListener("change", renderFields);
    fields.addEventListener("input", update);
    renderFields();
    return { selected, values, update };
  }

  async function openTemplateSheet(phone, name) {
    const tpls = await loadTemplates(true).catch(() => []);
    openSheet("שליחת תבנית", `
      <div class="form">
        <div data-tpl-list></div>
        <div data-tpl-fields style="display:flex;flex-direction:column;gap:12px"></div>
        <div class="preview-box"><span class="lbl" style="font-size:12px;color:var(--muted)">כך זה יגיע ללקוח</span><div class="bubble out"><span class="txt" data-tpl-preview></span></div></div>
        <button class="btn big" data-send-tpl ${tpls.length ? "" : "disabled"}>שליחה</button>
      </div>`, (root, close) => {
      const picker = tplPicker(root, tpls, () => (name || "").split(" ")[0]);
      const refresh = root.querySelector("[data-tpl-refresh]");
      if (refresh) refresh.addEventListener("click", () => { close(); openTemplateSheet(phone, name); });
      root.querySelector("[data-send-tpl]").addEventListener("click", async (e) => {
        const t = picker.selected(); if (!t) return;
        e.target.disabled = true;
        try {
          await api(`/conversations/${phone}/template`, { body: { template: t.name, language: t.language, values: picker.values() } });
          close(); toast("התבנית נשלחה"); await refreshChat(true); loadConvs(true);
        } catch (ex) {
          e.target.disabled = false;
          toast(ex.message === "missing_value" ? "חסר ערך באחד השדות" : "לא נשלח: " + ((ex.data && ex.data.detail) || "שגיאה"));
        }
      });
    });
  }

  function openChatMenu() {
    const c = state.chat;
    if (!c) return;
    openSheet(c.name, `
      <div class="form" style="gap:8px">
        <div class="info">${esc(fmtPhone(c.phone))}${c.contact && c.contact.notes ? " · " + esc(c.contact.notes) : ""}</div>
        ${c.handoffSummary ? `<div class="card"><strong>מה ליה אספה</strong>${esc(c.handoffSummary)}</div>` : ""}
        <button class="btn ghost big" data-edit>עריכת איש קשר</button>
        <a class="btn ghost big" href="tel:+${esc(c.phone)}">חיוג</a>
      </div>`, (root, close) => {
      root.querySelector("[data-edit]").addEventListener("click", () => {
        close(); openContactSheet(c.contact || { phone: c.phone, name: c.name });
      });
    });
  }

  function openMenu() {
    const me = state.me;
    const p = me.push || {};
    let pushHtml = "";
    if (me.isPushOwner) {
      if (!p.enabled) pushHtml = `<div class="info">התראות לטלפון עדיין לא הוגדרו בשרת (מפתחות VAPID).</div>`;
      else if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        pushHtml = isIOS() && !isStandalone()
          ? `<div class="info">באייפון: שיתוף ← "הוסף למסך הבית", פתחו את ליה מהמסך הבית, ואז הפעילו כאן התראות.</div>`
          : `<div class="info">הדפדפן הזה לא תומך בהתראות.</div>`;
      } else {
        pushHtml = `<button class="btn big" data-push>${p.subscribed ? "התראות פעילות · שליחת בדיקה" : "הפעלת התראות בטלפון"}</button>`;
      }
    }
    openSheet(me.name, `
      <div class="form" style="gap:10px">
        ${pushHtml}
        ${me.role === "admin" ? `<button class="btn ghost big" data-team>ניהול צוות · הוספת מנהל</button><button class="btn ghost big" data-diag>בדיקת חיבור ל-Meta</button>` : ""}
        ${isStandalone() ? "" : `<button class="btn ghost big" data-install>התקנת האפליקציה בטלפון</button>`}
        <a class="btn ghost big" href="#/contacts" data-close>אנשי קשר</a>
        <a class="btn ghost big" href="#/import" data-close>ייבוא אנשי קשר</a>
        <button class="btn ghost big" data-pin>החלפת קוד כניסה</button>
        <button class="btn ghost big" data-logout>התנתקות</button>
      </div>`, (root, close) => {
      const pb = root.querySelector("[data-push]");
      if (pb) pb.addEventListener("click", async () => {
        try {
          if (p.subscribed) { await api("/push/test", { method: "POST", body: {} }); toast("נשלחה התראת בדיקה"); }
          else { await enablePush(); toast("ההתראות הופעלו"); close(); }
        } catch (ex) { toast(ex.message === "denied" ? "ההרשאה להתראות נחסמה בהגדרות הטלפון" : "לא הצלחנו להפעיל התראות"); }
      });
      const db = root.querySelector("[data-diag]");
      if (db) db.addEventListener("click", () => { close(); openDiagnostics(); });
      const tb = root.querySelector("[data-team]");
      if (tb) tb.addEventListener("click", () => { close(); openTeamSheet(); });
      const ib = root.querySelector("[data-install]");
      if (ib) ib.addEventListener("click", () => { close(); renderInstall(""); });
      root.querySelector("[data-pin]").addEventListener("click", () => { close(); openChangePin(); });
      root.querySelector("[data-logout]").addEventListener("click", async () => {
        await api("/logout", { method: "POST", body: {} }).catch(() => {});
        close(); state.me = null; renderLogin();
      });
    });
  }

  async function openTeamSheet() {
    const { members } = await api("/team");
    openSheet("ניהול צוות", `
      <div class="form" style="gap:10px">
        <div class="team-list">${members.map((m) => `
          <div class="team-row"><span class="tn">${esc(m.name)}${m.role === "admin" ? ' <span class="tag">מנהל ראשי</span>' : ""}</span>
          ${m.role === "admin" ? "" : `<button class="link danger" data-remove="${esc(m.id)}" data-name="${esc(m.name)}">הסרה</button>`}</div>`).join("")}</div>
        <button class="btn big" data-invite>הוספת מנהל</button>
        <div id="invite-box"></div>
      </div>`, (root, close) => {
      root.querySelectorAll("[data-remove]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm(`להסיר את ${b.dataset.name}? הגישה שלו/ה לאפליקציה תיחסם מיד.`)) return;
        await api("/team/" + b.dataset.remove, { method: "DELETE" });
        close(); toast("הוסר/ה"); openTeamSheet();
      }));
      root.querySelector("[data-invite]").addEventListener("click", async (e) => {
        e.target.disabled = true;
        const inv = await api("/team/invite", { method: "POST", body: {} });
        const link = `${location.origin}/app/#/join/${inv.token}`;
        const text = `הוזמנת לאפליקציה של ליה — תיבת השיחות של אורבן בייקרי. פתחו את הקישור, בחרו שם וקוד, והתקינו בטלפון:\n${link}`;
        root.querySelector("#invite-box").innerHTML = `
          <div class="card">
            <strong>קישור הזמנה חד-פעמי · בתוקף 48 שעות</strong>
            <span class="invite-link" dir="ltr">${esc(link)}</span>
            <a class="btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">שליחה בוואטסאפ</a>
            <button class="btn ghost" data-copy>העתקת הקישור</button>
          </div>`;
        root.querySelector("[data-copy]").addEventListener("click", async () => {
          try {
            if (navigator.share) await navigator.share({ text });
            else { await navigator.clipboard.writeText(link); toast("הקישור הועתק"); }
          } catch { /* cancelled */ }
        });
      });
    });
  }

  async function openDiagnostics() {
    const closeLoading = openSheet("בדיקת חיבור ל-Meta", `<div class="form"><div class="info">בודק…</div></div>`);
    let d;
    try { d = await api("/diagnostics"); } catch { closeLoading(); toast("הבדיקה נכשלה"); return; }
    closeLoading();
    const row = (ok, title, text, detail) => `
      <div class="diag-row"><span class="diag-dot ${ok ? "ok" : "bad"}" aria-hidden="true"></span>
      <span class="tt"><span class="t1">${title} · ${ok ? "תקין" : "בעיה"}</span><span class="t2">${text || ""}</span>${detail ? `<span class="err-detail" dir="ltr">${esc(detail)}</span>` : ""}</span></div>`;
    const t = d.token || {};
    const tokenText = t.ok ? (t.neverExpires ? "טוקן קבוע — לא פג" : t.expiresAt ? `פג ב-${esc(new Date(t.expiresAt).toLocaleString("he-IL"))}` : "") : "הטוקן לא תקין או שפג — חדשו אותו ב-Railway";
    const scopesOk = (t.scopes || []).includes("whatsapp_business_management");
    const tp = d.templates;
    openSheet("בדיקת חיבור ל-Meta", `
      <div class="form" style="gap:2px">
        ${row(t.ok, "טוקן", tokenText, t.detail)}
        ${t.ok ? row(scopesOk, "הרשאת תבניות", scopesOk ? "whatsapp_business_management" : "לטוקן חסרה הרשאת whatsapp_business_management") : ""}
        ${row(d.phone && d.phone.ok, "מספר", d.phone && d.phone.ok ? `${esc(d.phone.number || "")} · ${esc(d.phone.name || "")}` : "", d.phone && d.phone.detail)}
        ${row(d.waba && d.waba.ok, "חשבון WhatsApp Business", d.waba && d.waba.ok ? `${esc(d.waba.id)}${d.waba.fromEnv ? " (מ-Railway)" : " (זוהה אוטומטית)"}` : "הוסיפו ב-Railway את WHATSAPP_BUSINESS_ACCOUNT_ID", d.waba && d.waba.detail)}
        ${tp ? row(tp.ok, "תבניות", tp.ok ? `${tp.approved} מאושרות${tp.others && tp.others.length ? ` · ${tp.others.length} אחרות (${esc(tp.others.map((o) => o.name + ": " + o.status).join(", "))})` : ""}` : "", tp.detail) : ""}
        ${row(d.push && d.push.ok, "התראות Push", d.push && d.push.ok ? (d.push.subscribed ? "מוגדר, והטלפון של המנהל רשום" : "מוגדר — הפעילו התראות מה-⋮") : "חסרים מפתחות VAPID ב-Railway")}
      </div>`);
  }

  function openChangePin() {
    openSheet("החלפת קוד כניסה", `
      <form class="form" id="pin-form">
        <div class="f"><label for="cur-pin">הקוד הנוכחי</label><input id="cur-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="current-password" required></div>
        <div class="f"><label for="nw-pin">קוד חדש (6 ספרות)</label><input id="nw-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="new-password" required></div>
        <button class="btn big" type="submit">שמירה</button>
      </form>`, (root, close) => {
      root.querySelector("#pin-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api("/me/pin", { body: { current: root.querySelector("#cur-pin").value, pin: root.querySelector("#nw-pin").value } });
          close(); toast("הקוד הוחלף");
        } catch (ex) { toast(ex.message === "bad_pin" ? "הקוד החדש צריך להיות 6 ספרות" : PIN_ERR[ex.message] || "הקוד הנוכחי שגוי"); }
      });
    });
  }

  function urlB64ToUint8(b64) {
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function enablePush() {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("denied");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(state.me.push.publicKey) });
    await api("/push/subscribe", { body: { subscription: sub.toJSON() } });
    state.me.push.subscribed = true;
  }

  // ── Contacts ───────────────────────────────────────────────────────────────
  function highlight(text, q) {
    const t = esc(text);
    const term = String(q || "").trim();
    if (!term || /^\d+$/.test(term)) return t;
    const i = String(text).toLowerCase().indexOf(term.toLowerCase());
    if (i === -1) return t;
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + term.length)) + "</mark>" + esc(text.slice(i + term.length));
  }

  function renderContacts() {
    main.innerHTML = `
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="חזרה לצ'אטים">${I.back}</a>
        <div class="titles"><span class="t1">אנשי קשר</span><span class="t2" id="c-count"></span></div>
      </header>
      <div style="padding:10px 16px 8px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--line)">
        <label class="search">${I.search}<span class="sr-only">חיפוש איש קשר</span>
          <input id="c-q" type="search" placeholder="חיפוש שם, טלפון או הערה" value="${esc(state.contactQ)}" autocomplete="off">
        </label>
        <div class="chips">
          ${[["all", "הכל"], ["business", "עסקים"], ["private", "פרטיים"]].map(([k, l]) => `<button class="chip${state.contactFilter === k ? " on" : ""}" data-cf="${k}">${l}</button>`).join("")}
        </div>
      </div>
      <div class="scroll">
        <button class="action-row" data-act-c="new"><span class="ai">${I.addPerson}</span>איש קשר חדש</button>
        <a class="action-row" href="#/import"><span class="ai">${I.download}</span>ייבוא אנשי קשר</a>
        <div id="c-list"></div>
      </div>`;
    const q = $("#c-q");
    q.addEventListener("input", debounce(() => { state.contactQ = q.value; loadContacts(); }, 200));
    main.querySelectorAll("[data-cf]").forEach((b) => b.addEventListener("click", () => {
      state.contactFilter = b.dataset.cf;
      main.querySelectorAll("[data-cf]").forEach((x) => x.classList.toggle("on", x === b));
      loadContacts();
    }));
    main.querySelector('[data-act-c="new"]').addEventListener("click", () => openContactSheet(null));
    loadContacts();
  }

  async function loadContacts() {
    const data = await api("/contacts?q=" + encodeURIComponent(state.contactQ));
    const cc = $("#c-count");
    if (!cc) return;
    cc.textContent = `${data.total} אנשי קשר`;
    let list = data.contacts;
    if (state.contactFilter !== "all") list = list.filter((c) => c.type === state.contactFilter);
    const q = state.contactQ;
    const box = $("#c-list");
    if (!list.length) {
      box.innerHTML = `<div class="empty">${q ? "לא נמצאו אנשי קשר" : "ספר הטלפונים ריק.<br>אפשר לייבא אנשי קשר, וכל מי שכותב לליה נשמר כאן אוטומטית."}</div>`;
      return;
    }
    let html = q ? `<div class="section-title">תוצאות עבור "${esc(q)}" · ${list.length}</div>` : "";
    let lastLetter = null;
    for (const c of list) {
      const letter = q ? null : Array.from((c.name || "#").trim())[0] || "#";
      if (letter && letter !== lastLetter) { html += `<div class="section-title">${esc(letter)}</div>`; lastLetter = letter; }
      const sub = [fmtPhone(c.phone)];
      if (c.notes && q && c.notes.toLowerCase().includes(q.toLowerCase())) sub.push(`הערה: "${highlight(c.notes, q)}"`);
      else if (c.lastSeen) sub.push("שיחה אחרונה: " + esc(listTime(c.lastSeen)));
      html += `
        <button class="row" data-contact="${esc(c.phone)}" style="min-height:66px">
          ${avatar(c.name, c.phone, "md")}
          <div class="body" style="border:0">
            <div class="l1"><span class="name" style="font-size:16px">${highlight(c.name || fmtPhone(c.phone), q)}</span>
              <span class="tag">${c.type === "business" ? "עסק" : "פרטי"}</span></div>
            <span class="preview" style="font-size:13.5px">${sub.map((s, i) => i === 0 ? esc(s) : s).join(" · ")}</span>
          </div>
        </button>`;
    }
    box.innerHTML = html;
    box.querySelectorAll("[data-contact]").forEach((b) => b.addEventListener("click", () => {
      const c = list.find((x) => x.phone === b.dataset.contact);
      openContactActions(c);
    }));
  }

  function openContactActions(c) {
    const hasChat = state.convs.some((x) => x.phone === c.phone);
    openSheet(c.name || fmtPhone(c.phone), `
      <div class="form" style="gap:10px">
        <div class="info">${esc(fmtPhone(c.phone))}${c.notes ? " · " + esc(c.notes) : ""}</div>
        ${hasChat ? `<a class="btn big" href="#/chat/${esc(c.phone)}" data-close>לשיחה</a>` : `<a class="btn big" href="#/new?phone=${esc(c.phone)}&name=${encodeURIComponent(c.name || "")}" data-close>שיחה חדשה</a>`}
        <button class="btn ghost big" data-edit>עריכה</button>
      </div>`, (root, close) => {
      root.querySelector("[data-edit]").addEventListener("click", () => { close(); openContactSheet(c); });
    });
  }

  function openContactSheet(c) {
    const isNew = !c || !c.phone;
    c = c || {};
    openSheet(isNew ? "איש קשר חדש" : "עריכת איש קשר", `
      <form class="form" id="contact-form">
        <div class="f"><label for="cf-name">שם</label><input id="cf-name" type="text" value="${esc(c.name || "")}" required></div>
        <div class="f"><label for="cf-phone">טלפון</label><input id="cf-phone" type="tel" dir="ltr" style="text-align:right" value="${esc(c.phone ? fmtPhone(c.phone) : "")}" ${isNew ? "" : "readonly"} required></div>
        <div class="f"><label for="cf-type">סוג</label><select id="cf-type"><option value="private"${c.type !== "business" ? " selected" : ""}>פרטי</option><option value="business"${c.type === "business" ? " selected" : ""}>עסק</option></select></div>
        <div class="f"><label for="cf-notes">הערה</label><textarea id="cf-notes" placeholder="למשל: אלרגיה לאגוזים, מזמינים כל שישי">${esc(c.notes || "")}</textarea></div>
        <button class="btn big" type="submit">שמירה</button>
      </form>`, (root, close) => {
      root.querySelector("#contact-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await api("/contacts", { body: {
            phone: c.phone || root.querySelector("#cf-phone").value,
            name: root.querySelector("#cf-name").value,
            type: root.querySelector("#cf-type").value,
            notes: root.querySelector("#cf-notes").value,
          } });
          close(); toast("נשמר");
          if (parseRoute().name === "contacts") loadContacts();
          if (state.chatPhone) refreshChat();
          loadConvs(true);
        } catch (ex) { toast(ex.message === "bad_phone" ? "מספר הטלפון לא תקין" : "לא נשמר, נסו שוב"); }
      });
    });
  }

  // ── Import ─────────────────────────────────────────────────────────────────
  async function renderImport() {
    const canPick = "contacts" in navigator && "ContactsManager" in window;
    main.innerHTML = `
      <header class="topbar">
        <a class="icon-btn" href="#/contacts" aria-label="חזרה לאנשי קשר">${I.back}</a>
        <div class="titles"><span class="t1">ייבוא אנשי קשר</span></div>
      </header>
      <div class="scroll">
        <div class="section-title accent">מאיפה לייבא?</div>
        <button class="opt" data-imp="pick" ${canPick ? "" : 'aria-disabled="true"'}>
          <span class="oi">${I.phone}</span>
          <span class="ot"><span class="o1">בחירה מהטלפון</span><span class="o2">${canPick ? "בוחרים אנשי קשר מהרשימה בטלפון" : "זמין בכרום באנדרואיד בלבד"}</span></span>
        </button>
        <label class="opt">
          <span class="oi">${I.card}</span>
          <span class="ot"><span class="o1">קובץ אנשי קשר (vCard)</span><span class="o2">אייפון ואנדרואיד · מייצאים מאפליקציית אנשי הקשר קובץ .vcf</span></span>
          <input type="file" accept=".vcf,text/vcard,text/x-vcard" data-file="vcard" aria-label="בחירת קובץ vCard">
        </label>
        <div class="opt" aria-disabled="true">
          <span class="oi">${I.globe}</span>
          <span class="ot"><span class="o1">אנשי קשר של Google</span><span class="o2">בקרוב</span></span>
        </div>
        <label class="opt">
          <span class="oi">${I.sheet}</span>
          <span class="ot"><span class="o1">קובץ אקסל / CSV</span><span class="o2">עמודות: שם, טלפון, סוג (עסק/פרטי), הערה</span></span>
          <input type="file" accept=".csv,.txt,text/csv" data-file="csv" aria-label="בחירת קובץ CSV">
        </label>
        <div class="divider"></div>
        <label class="toggle">
          <span class="ot" style="display:flex;flex-direction:column;flex:1"><span class="o1" style="font-size:16px;font-weight:500">לשמור אוטומטית כל מי שכותב</span><span class="o2" style="font-size:13px;color:var(--muted-2)">שם ומספר מהוואטסאפ נשמרים לבד</span></span>
          <input type="checkbox" role="switch" id="auto-save">
        </label>
        <div id="imp-result"></div>
      </div>`;
    try {
      const d = await api("/contacts?q=__none__");
      $("#auto-save").checked = d.autoSave;
    } catch { /* ignore */ }
    $("#auto-save").addEventListener("change", (e) => api("/contacts/settings", { body: { autoSave: e.target.checked } }).catch(() => toast("לא נשמר")));
    main.querySelectorAll("[data-file]").forEach((inp) => inp.addEventListener("change", async () => {
      const f = inp.files[0]; if (!f) return;
      const text = await f.text();
      inp.value = "";
      dryRun({ format: inp.dataset.file, text });
    }));
    const pick = main.querySelector('[data-imp="pick"]');
    if (canPick) pick.addEventListener("click", async () => {
      try {
        const res = await navigator.contacts.select(["name", "tel"], { multiple: true });
        const entries = [];
        for (const c of res) for (const t of c.tel || []) entries.push({ name: (c.name || [])[0] || "", phone: t });
        dryRun({ format: "entries", entries });
      } catch { /* user cancelled */ }
    });
  }

  async function dryRun(payload) {
    const box = $("#imp-result");
    let s;
    try { s = await api("/contacts/import", { body: { ...payload, commit: false } }); }
    catch { toast("לא הצלחנו לקרוא את הקובץ"); return; }
    if (!s.total) { box.innerHTML = `<div class="card"><strong>לא נמצאו אנשי קשר בקובץ</strong></div>`; return; }
    const parts = [`נמצאו ${s.total} אנשי קשר.`];
    if (s.merged) parts.push(`${s.merged} כבר קיימים ויאוחדו.`);
    if (s.skipped) parts.push(`${s.skipped} בלי מספר נייד תקין ידלגו.`);
    box.innerHTML = `
      <div class="card">
        <strong>לפני שמוסיפים</strong>
        <span>${esc(parts.join(" "))}</span>
        <button class="btn" style="align-self:flex-start" data-commit ${s.added + s.merged ? "" : "disabled"}>הוסף ${s.added} אנשי קשר</button>
      </div>`;
    box.scrollIntoView({ behavior: "smooth", block: "end" });
    box.querySelector("[data-commit]").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const r = await api("/contacts/import", { body: { ...payload, commit: true } });
        toast(`נוספו ${r.added} אנשי קשר`);
        go("#/contacts");
      } catch { e.target.disabled = false; toast("הייבוא נכשל, נסו שוב"); }
    });
  }

  // ── New chat ───────────────────────────────────────────────────────────────
  async function renderNew(params) {
    const tpls = await loadTemplates(true).catch(() => []);
    main.innerHTML = `
      <header class="topbar">
        <a class="icon-btn" href="#/" aria-label="חזרה לצ'אטים">${I.back}</a>
        <div class="titles"><span class="t1">שיחה חדשה</span><span class="t2">נשלח מהמספר של אורבן</span></div>
      </header>
      <form class="scroll" id="new-form" style="display:flex;flex-direction:column">
        <div class="form">
          <div class="f"><label for="n-phone">מספר טלפון</label><input id="n-phone" type="tel" dir="ltr" style="text-align:right" required value="${esc(params.phone ? fmtPhone(params.phone) : "")}" placeholder="05X-XXX-XXXX"></div>
          <div class="f"><label for="n-name">שם</label><input id="n-name" type="text" value="${esc(params.name || "")}"></div>
          <div class="info">${I.clock}<span>WhatsApp מאפשרת לפנות ללקוח רק בתבנית מאושרת, אלא אם הוא כתב לנו ב-24 השעות האחרונות. ברגע שהוא עונה — כותבים חופשי.</span></div>
          <div role="radiogroup" aria-label="בחירת תבנית">
            <div class="section-title accent" style="padding:4px 0 4px">תבניות מאושרות</div>
            <div data-tpl-list></div>
          </div>
          <div data-tpl-fields style="display:flex;flex-direction:column;gap:12px"></div>
          <div class="preview-box"><span class="lbl" style="font-size:12px;color:var(--muted)">כך זה יגיע ללקוח</span><div class="bubble out"><span class="txt" data-tpl-preview></span></div></div>
        </div>
        <div style="flex:1"></div>
        <div class="footer-bar">
          <span class="note">ליה לא תענה בשיחה הזו עד שתחזירו לה</span>
          <button class="round-send" type="submit" aria-label="שלח" ${tpls.length ? "" : "disabled"}>${I.send}</button>
        </div>
      </form>`;
    const form = $("#new-form");
    const picker = tplPicker(form, tpls, () => $("#n-name").value.split(" ")[0]);
    const refresh = form.querySelector("[data-tpl-refresh]");
    if (refresh) refresh.addEventListener("click", () => renderNew(params));
    $("#n-name").addEventListener("input", () => {
      const f = form.querySelector('[data-param="0"]');
      if (f && !f.dataset.touched) { f.value = $("#n-name").value.split(" ")[0]; picker.update && picker.update(); }
    });
    form.addEventListener("input", (e) => { if (e.target.matches('[data-param="0"]')) e.target.dataset.touched = "1"; });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const t = picker.selected(); if (!t) return;
      const btn = form.querySelector(".round-send");
      btn.disabled = true;
      try {
        const r = await api("/conversations/new", { body: {
          phone: $("#n-phone").value, name: $("#n-name").value,
          template: t.name, language: t.language, values: picker.values(),
        } });
        await loadConvs(true);
        go("#/chat/" + r.phone);
      } catch (ex) {
        btn.disabled = false;
        toast(ex.message === "bad_phone" ? "מספר הטלפון לא תקין" : ex.message === "missing_value" ? "חסר ערך באחד השדות" : "לא נשלח: " + ((ex.data && ex.data.detail) || "שגיאה"));
      }
    });
  }

  // ── Boot & polling ─────────────────────────────────────────────────────────
  async function boot() {
    try { state.me = await api("/me"); }
    catch { if (!state.me) renderLogin(); return; }
    if (parseRoute().name === "join") history.replaceState(null, "", location.pathname + "#/");
    side.innerHTML = "";
    await loadConvs(true);
    route();
  }

  setInterval(() => {
    if (!state.me || document.hidden) return;
    loadConvs();
    if (state.chatPhone) refreshChat();
  }, 4000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.me) { loadConvs(); if (state.chatPhone) refreshChat(); }
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "/app/" }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data && e.data.type === "open" && e.data.url) location.href = e.data.url;
    });
  }

  boot();
})();
