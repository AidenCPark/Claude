// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: music;

// ============================================================
// Billboard Hot 100 #1 Widget for Scriptable  (Small size)
// ------------------------------------------------------------
// Shows the current #1 song on the Billboard Hot 100 as its
// cover art, with the song title, artist, and how many weeks it
// has been on the chart.
//
// Data comes from Billboard's Hot 100 chart page (no API key
// needed). Results are cached so it still renders when offline /
// if a fetch fails.
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Small size.
// ============================================================

// Desktop UA so Billboard serves the full desktop markup this parser
// expects (a mobile UA can return a different layout).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const CHART_URL = "https://www.billboard.com/charts/hot-100/";

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
// HTML helpers
// ------------------------------------------------------------
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&rsquo;/g, "’")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .trim();
}
function cleanText(s) {
  return decodeEntities((s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).trim();
}

// ------------------------------------------------------------
// Data fetching  (Billboard Hot 100 chart)
// ------------------------------------------------------------
async function fetchText(url) {
  const req = new Request(url);
  req.headers = REQ_HEADERS;
  req.timeoutInterval = 25;
  return await req.loadString();
}

// Returns { title, artist, weeks (number|null), coverUrl }. Parsing is
// isolated here so it's easy to tweak if Billboard changes its markup.
async function getTopSong() {
  const html = await fetchText(CHART_URL);

  // The #1 song is the first chart result row.
  const rowStart = html.search(/o-chart-results-list-row/);
  const block = rowStart >= 0 ? html.slice(rowStart, rowStart + 8000) : html;

  // Title lives in the row's h3#title-of-a-story.
  const tm = block.match(/id="title-of-a-story"[^>]*>([\s\S]*?)<\/h3>/i);
  const title = tm ? cleanText(tm[1]) : null;
  if (!title) throw new Error("Could not parse Billboard chart");

  // Artist: lives in a small (non-bold) c-label right after the title.
  const afterTitle = tm ? block.slice(block.indexOf(tm[0]) + tm[0].length) : block;
  let artist = "";
  const direct = afterTitle.match(/<span class="c-label a-no-trucate a-font-primary-s[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (direct) artist = cleanText(direct[1]);
  // Fallback: first label that's real text — skip dashes, numbers, and
  // chart badges (a leftover "-" is what made the artist show as a dash).
  if (!artist || !/[a-zA-Z]/.test(artist)) {
    const skip = /^(new|re-?entry|gains in performance|steady|-|—)$/i;
    for (const lm of afterTitle.matchAll(/<span class="c-label[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)) {
      const txt = cleanText(lm[1]);
      if (txt && /[a-zA-Z]/.test(txt) && !skip.test(txt)) { artist = txt; break; }
    }
  }

  // Weeks on chart: the last standalone number among the row's c-labels
  // (the trailing stat columns are Last Week / Peak / Weeks on Chart).
  let weeks = null;
  const nums = [...block.matchAll(/<span class="c-label[^"]*"[^>]*>\s*(\d+)\s*<\/span>/gi)]
    .map(x => parseInt(x[1], 10));
  if (nums.length) weeks = nums[nums.length - 1];

  // Cover art (Billboard's chart image CDN).
  const cm = block.match(/https?:\/\/charts-static\.billboard\.com\/img\/[^"'\s]+?\.(?:jpe?g|png)/i);
  const coverUrl = cm ? cm[0] : null;

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
    const thumb = thumbnail(full, 200);
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
  w.setPadding(7, 8, 7, 8);

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

  w.url = CHART_URL;

  // ---- Cover art ----
  const COVER = 88;
  const cover = await loadCover(data.coverUrl);
  const top = w.addStack();
  top.addSpacer();
  if (cover) {
    const im = top.addImage(cover);
    im.imageSize = new Size(COVER, COVER);
    im.cornerRadius = 6;
  } else {
    const card = top.addStack();
    card.size = new Size(COVER, COVER);
    card.cornerRadius = 6;
    card.backgroundColor = COLORS.card;
    card.centerAlignContent();
    const note = card.addText("♪");
    note.textColor = COLORS.accent;
    note.font = Font.boldSystemFont(30);
  }
  top.addSpacer();

  w.addSpacer(5);

  // ---- Song title ----
  const tr = w.addStack();
  tr.addSpacer();
  const t = tr.addText(data.title || "");
  t.textColor = COLORS.text;
  t.font = Font.boldSystemFont(13);
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
    a.font = Font.systemFont(10);
    a.lineLimit = 1;
    a.minimumScaleFactor = 0.7;
    a.centerAlignText();
    ar.addSpacer();
  }

  // ---- Weeks on chart (the comparable stat) ----
  if (data.weeks != null && !isNaN(data.weeks) && data.weeks >= 1) {
    w.addSpacer(2);
    const wr = w.addStack();
    wr.addSpacer();
    const label = data.weeks === 1 ? "1 week on chart" : `${data.weeks} weeks on chart`;
    const wk = wr.addText(label);
    wk.textColor = COLORS.accent;
    wk.font = Font.semiboldSystemFont(10.5);
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
