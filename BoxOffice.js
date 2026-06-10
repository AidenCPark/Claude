// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: red; icon-glyph: film;

// ============================================================
// #1 at the Box Office Widget for Scriptable  (Small size)
// ------------------------------------------------------------
// Shows the current #1 movie at the domestic box office as its
// poster, with the weekend earnings below it.
//
// Data comes from Box Office Mojo's weekend chart (no API key
// needed): the #1 title + weekend gross, plus the poster image
// from that movie's page. Results are cached so it still renders
// when offline / if a fetch fails.
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Small size.
// ============================================================

// Desktop UA so Mojo serves the full desktop table (a mobile UA returns
// a different layout that this parser doesn't expect).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const REQ_HEADERS = {
  "User-Agent": UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};
const MOJO_BASE = "https://www.boxofficemojo.com";
const CHART_URL = `${MOJO_BASE}/weekend/`;

// ------------------------------------------------------------
// Colors / theme  (dark cinematic)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#1c1410"),
  bg2: new Color("#0c0a09"),
  text: new Color("#ffffff"),
  dim: new Color("#a7a29b"),
  gold: new Color("#f5c451"),
  card: new Color("#2a2320"),
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

// ------------------------------------------------------------
// Data fetching  (Box Office Mojo weekend chart)
// ------------------------------------------------------------
// Returns { title, earnings (number), posterUrl, releaseUrl }.
// Parsing is intentionally isolated here so it's easy to tweak if
// Mojo changes its markup.
async function fetchText(url) {
  const req = new Request(url);
  req.headers = REQ_HEADERS;
  req.timeoutInterval = 25;
  return await req.loadString();
}

async function getTopMovie() {
  const html = await fetchText(CHART_URL);

  // Find the #1 row's release link. Primary: the ref-tagged top row;
  // fallback: the first /release/ link on the page (the chart's #1).
  let m = html.match(/href="(\/release\/[^"]*?ref_=bo_we_table_1)"[^>]*>([^<]+)<\/a>/);
  if (!m) m = html.match(/href="(\/release\/rl\d+\/[^"]*)"[^>]*>([^<]{1,150})<\/a>/);
  if (!m) throw new Error("Could not parse box office chart");
  const releasePath = m[1].replace(/&amp;/g, "&");
  const title = decodeEntities(m[2]);

  // The first sizable money value after the title link is the weekend gross.
  const pos = html.indexOf(m[0]);
  const seg = html.slice(pos >= 0 ? pos : 0, (pos >= 0 ? pos : 0) + 8000);
  const gm = seg.match(/\$[\d,]{4,}/);
  const earnings = gm ? parseInt(gm[0].replace(/[^\d]/g, ""), 10) : null;

  // Poster lives on the movie's release page (Amazon-hosted image).
  let posterUrl = null;
  try {
    const relHtml = await fetchText(MOJO_BASE + releasePath);
    const pm = relHtml.match(/https:\/\/m\.media-amazon\.com\/images\/M\/[^"'\s\\]+?\.(?:jpe?g|png)/i);
    posterUrl = pm ? pm[0] : null;
  } catch (e) { /* poster optional */ }

  return { title, earnings, posterUrl, releaseUrl: MOJO_BASE + releasePath };
}

// ------------------------------------------------------------
// Poster image + disk cache
// ------------------------------------------------------------
function urlKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// Downscale to a modest poster-sized thumbnail (2:3) to keep memory low.
function thumbnail(img, w, h) {
  const c = new DrawContext();
  c.size = new Size(w, h);
  c.opaque = false;
  c.respectScreenScale = false;
  c.drawImageInRect(img, new Rect(0, 0, w, h));
  return c.getImage();
}

async function loadPoster(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "boxoffice_posters");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${urlKey(url)}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const full = await new Request(url).loadImage();
    const thumb = thumbnail(full, 200, 300);
    fm.writeImage(path, thumb);
    return thumb;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "boxoffice_data.json") };
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
// Formatting
// ------------------------------------------------------------
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + n;
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
  w.setPadding(8, 8, 8, 8);

  let data = null;
  try {
    data = await getTopMovie();
    saveCache(data);
  } catch (e) {
    data = loadCache();
  }

  if (!data) {
    const msg = w.addText("Box Office\nNo data yet — open with a connection once.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(11);
    return w;
  }

  w.url = data.releaseUrl || CHART_URL;

  // ---- Poster ----
  const POSTER_H = 118, POSTER_W = Math.round(POSTER_H * 2 / 3);
  const poster = await loadPoster(data.posterUrl);

  const top = w.addStack();
  top.addSpacer();
  if (poster) {
    const im = top.addImage(poster);
    im.imageSize = new Size(POSTER_W, POSTER_H);
    im.cornerRadius = 6;
  } else {
    // Fallback card with the title if no poster could be loaded.
    const card = top.addStack();
    card.size = new Size(POSTER_W, POSTER_H);
    card.cornerRadius = 6;
    card.backgroundColor = COLORS.card;
    card.layoutVertically();
    card.setPadding(8, 6, 8, 6);
    card.addSpacer();
    const t = card.addText(data.title || "#1 Movie");
    t.textColor = COLORS.text;
    t.font = Font.semiboldSystemFont(11);
    t.centerAlignText();
    card.addSpacer();
  }
  top.addSpacer();

  w.addSpacer(6);

  // ---- Earnings below the poster ----
  const er = w.addStack();
  er.addSpacer();
  const e = er.addText(fmtMoney(data.earnings));
  e.textColor = COLORS.gold;
  e.font = Font.boldSystemFont(17);
  er.addSpacer();

  const cr = w.addStack();
  cr.addSpacer();
  const cap = cr.addText("This Weekend");
  cap.textColor = COLORS.dim;
  cap.font = Font.systemFont(8.5);
  cr.addSpacer();

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
