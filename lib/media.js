// Media (photos, videos, voice, files) for the team app.
//
// Sending: the app uploads the raw file → we upload it to Meta (/media) →
// send a message of the matching type with the returned media id.
// Viewing: inbound and outbound media are served through /api/media/:id,
// fetched from Meta on first view and cached in DATA_DIR/media.
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const MB = 1024 * 1024;
// WhatsApp Cloud API limits per message type.
const LIMITS = { image: 5 * MB, video: 16 * MB, audio: 16 * MB, document: 100 * MB };
// What the app may upload through our server. The file is held in memory while
// it's forwarded to Meta, so keep this well under Railway's RAM.
const MAX_UPLOAD = 30 * MB;
// Local cache of media files on the volume: old files go after 30 days
// (Meta keeps media ids ~30 days anyway) and the cache is capped in size.
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 1024 * MB;
const IMAGE_TYPES = ["image/jpeg", "image/png"];
const VIDEO_TYPES = ["video/mp4", "video/3gpp"];
const AUDIO_TYPES = ["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"];

// Decide how WhatsApp should receive a file. Anything that doesn't fit the
// rich types (format or size) goes as a document, which accepts any file.
function classify(mimeType, size) {
  const mime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (IMAGE_TYPES.includes(mime) && size <= LIMITS.image) return "image";
  if (VIDEO_TYPES.includes(mime) && size <= LIMITS.video) return "video";
  if (AUDIO_TYPES.includes(mime) && size <= LIMITS.audio) return "audio";
  return "document";
}

const graph = () => `https://graph.facebook.com/v18.0`;
const authHeader = () => ({ Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}` });

class MediaService {
  constructor(dataDir) {
    this.dir = path.join(dataDir, "media");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  cachePath(id) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(id))) return null;
    return path.join(this.dir, String(id));
  }

  saveToCache(id, buffer, meta) {
    const p = this.cachePath(id);
    if (!p) return;
    try {
      fs.writeFileSync(p, buffer);
      fs.writeFileSync(p + ".json", JSON.stringify(meta));
    } catch (e) { console.error("media cache write failed:", e.message); }
  }

  // Upload bytes to Meta. Returns { ok, id, error }.
  async upload(buffer, mimeType, filename) {
    try {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", mimeType);
      form.append("file", new Blob([buffer], { type: mimeType }), filename || "file");
      const res = await axios.post(`${graph()}/${process.env.WHATSAPP_PHONE_ID}/media`, form, {
        headers: authHeader(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120000,
      });
      const id = res.data?.id;
      if (!id) return { ok: false, error: "no media id" };
      this.saveToCache(id, buffer, { mimeType, filename: filename || null });
      return { ok: true, id };
    } catch (error) {
      console.error("Media upload failed:", error.response?.data || error.message);
      return { ok: false, error: error.response?.data?.error?.message || error.message };
    }
  }

  // Send an uploaded media id. Returns { ok, wamid, error }.
  async send(to, kind, id, { caption, filename } = {}) {
    const payload = { id };
    if (caption && kind !== "audio") payload.caption = String(caption).slice(0, 1024);
    if (kind === "document" && filename) payload.filename = filename;
    try {
      const res = await axios.post(
        `${graph()}/${process.env.WHATSAPP_PHONE_ID}/messages`,
        { messaging_product: "whatsapp", to, type: kind, [kind]: payload },
        { headers: authHeader() }
      );
      console.log(`📎 ${kind} sent to ${to}`);
      return { ok: true, wamid: res.data?.messages?.[0]?.id || null };
    } catch (error) {
      console.error("Media send failed:", error.response?.data || error.message);
      return { ok: false, wamid: null, error: error.response?.data?.error?.message || error.message };
    }
  }

  prune() {
    try {
      const now = Date.now();
      const files = fs.readdirSync(this.dir)
        .filter(f => !f.endsWith(".json") && !f.endsWith(".tmp"))
        .map(f => { const st = fs.statSync(path.join(this.dir, f)); return { f, size: st.size, mtime: st.mtimeMs }; })
        .sort((a, b) => b.mtime - a.mtime);
      let total = 0, removed = 0;
      for (const x of files) {
        total += x.size;
        if (now - x.mtime > CACHE_MAX_AGE_MS || total > CACHE_MAX_BYTES) {
          fs.rmSync(path.join(this.dir, x.f), { force: true });
          fs.rmSync(path.join(this.dir, x.f + ".json"), { force: true });
          removed++;
        }
      }
      if (removed) console.log(`🧹 Media cache: removed ${removed} file(s)`);
    } catch (e) { console.error("media prune failed:", e.message); }
  }

  // Returns { buffer, mimeType, filename } from cache or Meta, or null.
  async get(id) {
    const p = this.cachePath(id);
    if (!p) return null;
    if (fs.existsSync(p) && fs.existsSync(p + ".json")) {
      try {
        const meta = JSON.parse(fs.readFileSync(p + ".json", "utf8"));
        return { buffer: fs.readFileSync(p), mimeType: meta.mimeType, filename: meta.filename };
      } catch { /* refetch */ }
    }
    try {
      const info = await axios.get(`${graph()}/${id}`, { headers: authHeader(), timeout: 15000 });
      const url = info.data?.url;
      if (!url) return null;
      const file = await axios.get(url, { headers: authHeader(), responseType: "arraybuffer", timeout: 60000 });
      const buffer = Buffer.from(file.data);
      const mimeType = info.data.mime_type || file.headers["content-type"] || "application/octet-stream";
      this.saveToCache(id, buffer, { mimeType, filename: null });
      return { buffer, mimeType, filename: null };
    } catch (error) {
      console.error("Media fetch failed:", error.response?.data || error.message);
      return null;
    }
  }
}

module.exports = { MediaService, classify, LIMITS, MAX_UPLOAD };
