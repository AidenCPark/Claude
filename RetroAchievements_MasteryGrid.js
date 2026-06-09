// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: yellow; icon-glyph: th-large;

// ============================================================
// RetroAchievements Mastery Grid Widget for Scriptable
// ------------------------------------------------------------
// Shows every game you've MASTERED or BEATEN as a grid of game
// icons — no text except a small legend at the top:
//   - Mastered games get a thin GOLD border
//   - Beaten games get a thin SILVER border
// (A game that is both mastered and beaten shows gold.)
//
// Icons auto-scale to fit however many games you have. Large
// size is recommended, but it adapts to Medium/Small too.
//
// SETUP:
//   1. Get your Web API key from:
//      https://retroachievements.org/settings  ("Keys" section)
//   2. Fill in USERNAME and API_KEY below.
//   3. Add a Scriptable widget, long-press -> "Edit Widget",
//      pick this script, and choose the Large size.
// ============================================================

const USERNAME = "Aidenham";
const API_KEY  = "Yj7zpFMfhNfIrrtIBBTfwZn8FMp5HjBD";

// Safety cap on how many icons to render (most-recent first if over).
const MAX_GAMES = 160;
// Cached icons are downscaled to this many px (square) to keep the
// home-screen widget under its tight memory budget.
const THUMB_PX = 140;

const API_BASE = "https://retroachievements.org/API";
const MEDIA_BASE = "https://media.retroachievements.org";

// ------------------------------------------------------------
// Colors / theme
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#1a1a2e"),
  bg2: new Color("#16213e"),
  dim: new Color("#9aa6c0"),
  gold: new Color("#ffcf3f"),
  silver: new Color("#cdd3df"),
  placeholder: new Color("#2a3350"),
};

// rank: 2 = mastered (gold), 1 = beaten (silver)
const RANK_MASTERED = 2;
const RANK_BEATEN = 1;

// ------------------------------------------------------------
// Networking
// ------------------------------------------------------------
async function apiGet(endpoint, extraParams = {}) {
  const all = { u: USERNAME, y: API_KEY, ...extraParams };
  const query = Object.keys(all)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join("&");
  const req = new Request(`${API_BASE}/${endpoint}?${query}`);
  req.timeoutInterval = 20;
  return await req.loadJSON();
}

// Downscale an image to a small square thumbnail via an offscreen canvas.
function thumbnail(img, size) {
  const c = new DrawContext();
  c.size = new Size(size, size);
  c.opaque = false;
  c.respectScreenScale = false;
  c.drawImageInRect(img, new Rect(0, 0, size, size));
  return c.getImage();
}

// Download a game icon, downscaling to a small thumbnail and caching that
// on disk. Storing/loading thumbnails (not full-res art) keeps the widget
// well under its memory budget.
async function loadGameIcon(iconPath) {
  if (!iconPath) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "ra_game_thumbs");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const name = (iconPath.split("/").pop() || "icon.png").replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = fm.joinPath(dir, name);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const full = await new Request(`${MEDIA_BASE}${iconPath}`).loadImage();
    const thumb = thumbnail(full, THUMB_PX);
    fm.writeImage(path, thumb);
    return thumb;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// Disk cache for the awards list (used when offline / on timeout)
// ------------------------------------------------------------
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "ra_mastery_grid.json") };
}
function saveCache(items) {
  try { const { fm, path } = cachePath(); fm.writeString(path, JSON.stringify(items)); } catch (e) {}
}
function loadCache() {
  try {
    const { fm, path } = cachePath();
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (e) { return null; }
}

// ------------------------------------------------------------
// Data
// ------------------------------------------------------------
// Build the list of mastered/beaten games from GetUserAwards. Only
// hardcore awards count (Mastered + Beaten); a game that's both shows
// gold. Sorted gold-first, then most-recent.
async function getAwards() {
  const resp = await apiGet("API_GetUserAwards.php");
  const awards = (resp && resp.VisibleUserAwards) || [];

  const byGame = new Map(); // gameId -> { icon, rank, awardedAt }
  for (const a of awards) {
    const id = a.AwardData || a.GameID;
    const icon = a.ImageIcon;
    const hardcore = String(a.AwardDataExtra) === "1";
    if (!id || !icon || !hardcore) continue;

    let rank = 0;
    if (a.AwardType === "Mastery/Completion") rank = RANK_MASTERED;
    else if (a.AwardType === "Game Beaten") rank = RANK_BEATEN;
    else continue;

    const prev = byGame.get(id);
    if (!prev || rank > prev.rank) {
      byGame.set(id, { icon, rank, awardedAt: a.AwardedAt || "" });
    }
  }

  const items = [...byGame.values()];
  // Cap to the most recent MAX_GAMES across everything.
  items.sort((x, y) => (y.awardedAt || "").localeCompare(x.awardedAt || "")); // newest first
  const capped = items.length > MAX_GAMES ? items.slice(0, MAX_GAMES) : items;
  // Display order: MASTERED group first, then BEATEN; within each group
  // oldest at the top -> newest at the bottom.
  capped.sort((x, y) =>
    (y.rank - x.rank) || (x.awardedAt || "").localeCompare(y.awardedAt || ""));
  return capped;
}

// ------------------------------------------------------------
// Grid drawing
// ------------------------------------------------------------
// Render the icons into one image. Columns are chosen to suit the
// widget's shape; icon size falls out of how many games there are, so
// everything fits regardless of count. The canvas is kept to a fixed,
// modest pixel size (and screen-scale off) so the bitmap stays small.
async function buildGridImage(items, aspect) {
  const n = items.length;
  let cols = Math.max(1, Math.round(Math.sqrt(n * aspect)));
  cols = Math.min(cols, n);
  const rows = Math.ceil(n / cols);

  const cell = Math.min(THUMB_PX, Math.floor(680 / cols)); // bounded cell px
  const gap = Math.max(3, Math.round(cell * 0.14));
  const border = Math.max(2, Math.round(cell * 0.06));     // thin border
  const W = gap + cols * (cell + gap);
  const H = gap + rows * (cell + gap);

  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;          // let the widget gradient show in the gaps
  ctx.respectScreenScale = false;

  // Load + draw one icon at a time so only a single source image is ever
  // in memory — loading them all at once exceeded the widget's budget and
  // rendered blank.
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const rIdx = Math.floor(i / cols);
    const x = gap + c * (cell + gap);
    const y = gap + rIdx * (cell + gap);
    const rect = new Rect(x, y, cell, cell);

    let icon = null;
    try { icon = await loadGameIcon(items[i].icon); } catch (e) {}
    if (icon) {
      ctx.drawImageInRect(icon, rect);
    } else {
      ctx.setFillColor(COLORS.placeholder);
      ctx.fillRect(rect);
    }

    // Thin gold/silver border framing the icon.
    ctx.setStrokeColor(items[i].rank === RANK_MASTERED ? COLORS.gold : COLORS.silver);
    ctx.setLineWidth(border);
    ctx.strokeRect(rect);
  }

  return ctx.getImage();
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
  w.setPadding(10, 10, 10, 10);

  let items = null;
  try {
    items = await getAwards();
    saveCache(items);
  } catch (e) {
    items = loadCache();
  }

  w.url = `https://retroachievements.org/user/${encodeURIComponent(USERNAME)}`;

  // ---- Legend (the only text) ----
  const legend = w.addStack();
  legend.centerAlignContent();
  const m = legend.addText("Mastered");
  m.textColor = COLORS.gold;
  m.font = Font.semiboldSystemFont(11);
  legend.addSpacer(12);
  const b = legend.addText("Beaten");
  b.textColor = COLORS.silver;
  b.font = Font.semiboldSystemFont(11);
  legend.addSpacer();

  w.addSpacer(8);

  if (!items) {
    const msg = w.addText("No data yet — open with a connection once.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(11);
    return w;
  }
  if (items.length === 0) {
    const msg = w.addText("No mastered or beaten games yet.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(11);
    return w;
  }

  // ---- Grid ----
  const family = config.widgetFamily || "large";
  const aspect = family === "medium" ? 2.15 : (family === "small" ? 1.0 : 1.05);

  const gridImg = await buildGridImage(items, aspect);

  const row = w.addStack();
  row.addSpacer();
  const im = row.addImage(gridImg);
  im.applyFittingContentMode();
  row.addSpacer();

  w.addSpacer();
  w.refreshAfterDate = new Date(Date.now() + 3 * 60 * 60 * 1000); // awards change rarely
  return w;
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
