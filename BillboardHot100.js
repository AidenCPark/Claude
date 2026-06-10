// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: music;

// ============================================================
// Billboard Hot 100 #1 Widget for Scriptable  (Small size)
// ------------------------------------------------------------
// Shows the current #1 song on the Billboard Hot 100 as its
// cover art, with the song title, artist, and weeks on chart.
//
// Data sources (both keyless):
//   - Billboard Hot 100 chart as daily-updated JSON:
//     github.com/mhollingshead/billboard-hot-100  (recent.json)
//   - Cover art via the iTunes Search API
// (Scraping billboard.com directly proved too fragile, so this
//  uses structured JSON instead.)
//
// Results are cached so it still renders when offline / if a
// fetch fails.
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Small size.
// ============================================================

const HOT100_JSON = "https://raw.githubusercontent.com/mhollingshead/billboard-hot-100/main/recent.json";
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const BILLBOARD_URL = "https://www.billboard.com/charts/hot-100/";

// ------------------------------------------------------------
// Colors / theme
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#221018"),
  bg2: new Color("#0c0a0d"),
  text: new Color("#ffffff"),
  dim: new Color("#b3a7ad"),
  accent: new Color("#ff4d6d"),
  card: new Color("#2a2026"),
};

// ------------------------------------------------------------
// Data fetching
// ------------------------------------------------------------
// Returns { title, artist, weeks (number|null), coverUrl }.
async function getTopSong() {
  const req = new Request(HOT100_JSON);
  req.timeoutInterval = 25;
  const json = await req.loadJSON();
  const top = json && json.data && json.data[0];
  if (!top || !top.song) throw new Error("No Hot 100 data");

  const title = top.song;
  const artist = top.artist || "";
  const weeks = top.weeks_on_chart != null ? Number(top.weeks_on_chart) : null;

  // Cover art via the iTunes Search API (search the song + artist).
  let coverUrl = null;
  try {
    const term = encodeURIComponent(`${title} ${artist}`);
    const sReq = new Request(`${ITUNES_SEARCH}?term=${term}&entity=song&limit=1&country=US`);
    sReq.timeoutInterval = 20;
    const s = await sReq.loadJSON();
    const r0 = s && s.results && s.results[0];
    if (r0 && r0.artworkUrl100) {
      // Upgrade the thumbnail URL to a larger, crisper image.
      coverUrl = r0.artworkUrl100.replace(/\/\d+x\d+bb\./, "/600x600bb.");
    }
  } catch (e) { /* cover optional */ }

  return { title, artist, weeks, coverUrl };
}

// ------------------------------------------------------------
// Cover image + disk cache
// ------------------------------------------------------------
function urlKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// Downscale to a modest square thumbnail to keep memory low.
function thumbnail(img, size) {
  const c = new DrawContext();
  c.size = new Size(size, size);
  c.opaque = false;
  c.respectScreenScale = false;
  c.drawImageInRect(img, new Rect(0, 0, size, size));
  return c.getImage();
}

async function loadCover(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "billboard_covers");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${urlKey(url)}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const full = await new Request(url).loadImage();
    const thumb = thumbnail(full, 240);
    fm.writeImage(path, thumb);
    return thumb;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "billboard_data.json") };
}
function saveCache(data) {
  try { const { fm, path } = cachePath(); fm.writeString(path, JSON.stringify(data)); } catch (e) {}
}
function loadCache() {
  try {
    const { fm, path } = cachePath();
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (e) { return null; }
}

// ------------------------------------------------------------
// Build widget
// ------------------------------------------------------------
async function buildWidget() {
  const w = new ListWidget();
  const grad = new LinearGradient();
  grad.colors = [COLORS.bg1, COLORS.bg2];
  grad.locations = [0, 1];
  w.backgroundGradient = grad;
  w.setPadding(5, 8, 5, 8);

  let data = null;
  try {
    data = await getTopSong();
    saveCache(data);
  } catch (e) {
    data = loadCache();
  }

  if (!data) {
    const msg = w.addText("Billboard Hot 100\nNo data yet — open with a connection once.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(11);
    return w;
  }

  w.url = BILLBOARD_URL;

  // ---- Cover art ----
  const COVER = 100;
  const cover = await loadCover(data.coverUrl);
  const top = w.addStack();
  top.addSpacer();
  if (cover) {
    const im = top.addImage(cover);
    im.imageSize = new Size(COVER, COVER);
    im.cornerRadius = 7;
  } else {
    const card = top.addStack();
    card.size = new Size(COVER, COVER);
    card.cornerRadius = 7;
    card.backgroundColor = COLORS.card;
    card.centerAlignContent();
    const note = card.addText("♪");
    note.textColor = COLORS.accent;
    note.font = Font.boldSystemFont(40);
  }
  top.addSpacer();

  w.addSpacer(3);

  // ---- Song title ----
  const tr = w.addStack();
  tr.addSpacer();
  const t = tr.addText(data.title || "");
  t.textColor = COLORS.text;
  t.font = Font.boldSystemFont(12);
  t.lineLimit = 1;
  t.minimumScaleFactor = 0.6;
  t.centerAlignText();
  tr.addSpacer();

  // ---- Artist ----
  if (data.artist) {
    const ar = w.addStack();
    ar.addSpacer();
    const a = ar.addText(data.artist);
    a.textColor = COLORS.dim;
    a.font = Font.systemFont(9.5);
    a.lineLimit = 1;
    a.minimumScaleFactor = 0.7;
    a.centerAlignText();
    ar.addSpacer();
  }

  // ---- Weeks on chart (the comparable stat) ----
  if (data.weeks != null && !isNaN(data.weeks) && data.weeks >= 1) {
    w.addSpacer(1);
    const wr = w.addStack();
    wr.addSpacer();
    const label = data.weeks === 1 ? "1 week on chart" : `${data.weeks} weeks on chart`;
    const wk = wr.addText(label);
    wk.textColor = COLORS.accent;
    wk.font = Font.semiboldSystemFont(9.5);
    wk.centerAlignText();
    wr.addSpacer();
  }

  w.refreshAfterDate = new Date(Date.now() + 6 * 60 * 60 * 1000);
  return w;
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentSmall();
}
Script.complete();
