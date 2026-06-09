// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: th-large;

// ============================================================
// Xbox 100% Completion Grid Widget for Scriptable
// ------------------------------------------------------------
// Shows every game you've 100% completed (all achievements /
// full gamerscore) as a grid of game icons — no text except a
// small legend at the top:
//   - Completed games get a thin GOLD border
// (Xbox has no "beaten" tier like RetroAchievements, so this is
//  100% completions only — the equivalent of RA "Mastered".)
//
// Icons auto-scale to fit however many games you have. Large
// size is recommended, but it adapts to Medium/Small too.
//
// Games are ordered OLDEST at the top -> NEWEST at the bottom, by when
// each game was actually 100% completed (the unlock time of its last
// achievement), falling back to last-played time if that can't be matched.
//
// Reuses the same Keychain credentials as the other Xbox scripts:
//   - xbox_refreshtoken
//   - xbox_clientid
//   - xbox_clientsecret
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Large size.
// ============================================================

// Safety cap on how many icons to render (newest kept if over).
const MAX_GAMES = 160;
// Cached icons are downscaled to this many px (square) to keep the
// home-screen widget under its tight memory budget.
const THUMB_PX = 140;
const PAGE_SIZE = 1000; // achievements fetched per request
const MAX_PAGES = 30;   // safety cap (1000 * 30 = 30k achievements)

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------
const URL_TITLEHUB = "https://titlehub.xboxlive.com/users/xuid(<xid>)/titles/titleHistory/decoration/achievement,scid";
const URL_ACHIEVEMENTS = "https://achievements.xboxlive.com/users/xuid(<xid>)/achievements?orderBy=UnlockTime&unlockedOnly=true";
const URL_MS_TOKEN = "https://login.live.com/oauth20_token.srf";
const URL_XBL_AUTH = "https://user.auth.xboxlive.com/user/authenticate";
const URL_XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";

// ------------------------------------------------------------
// Colors / theme  (Xbox green bg, gold completion border)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#0e1a0e"),
  bg2: new Color("#10280f"),
  dim: new Color("#9ab59a"),
  gold: new Color("#ffcf3f"),
  placeholder: new Color("#1e2e1e"),
};

// Auth state (populated by authenticate()).
let XBOX_ID = null;
let XBOX_AUTH = null;

// ============================================================
// Authentication (Microsoft OAuth -> XBL -> XSTS)
// ============================================================
function readKeychain(key) {
  if (!Keychain.contains(key)) {
    throw new Error(`Missing Keychain key: ${key}`);
  }
  return Keychain.get(key);
}

async function authenticate() {
  const refreshToken = readKeychain("xbox_refreshtoken");
  const clientId = readKeychain("xbox_clientid");
  const clientSecret = readKeychain("xbox_clientsecret");
  const basic = "Basic " + btoa(`${clientId}:${clientSecret}`);

  // 1) Microsoft access token from refresh token.
  const msReq = new Request(URL_MS_TOKEN);
  msReq.method = "POST";
  msReq.headers = { "Authorization": basic, "Content-Type": "application/x-www-form-urlencoded" };
  msReq.body = "grant_type=refresh_token&refresh_token=" + encodeURIComponent(refreshToken);
  const ms = await msReq.loadJSON();
  if (ms.refresh_token) Keychain.set("xbox_refreshtoken", ms.refresh_token); // token rotation

  // 2) Xbox Live token.
  const xblReq = new Request(URL_XBL_AUTH);
  xblReq.method = "POST";
  xblReq.headers = { "Content-Type": "application/json" };
  xblReq.body = JSON.stringify({
    Properties: { AuthMethod: "RPS", RpsTicket: "d=" + ms.access_token, SiteName: "user.auth.xboxlive.com" },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  const xbl = await xblReq.loadJSON();

  // 3) XSTS token + user hash + xbox id.
  const xstsReq = new Request(URL_XSTS);
  xstsReq.method = "POST";
  xstsReq.headers = { "Content-Type": "application/json" };
  xstsReq.body = JSON.stringify({
    Properties: { SandboxId: "RETAIL", UserTokens: [xbl.Token] },
    RelyingParty: "http://xboxlive.com",
    TokenType: "JWT",
  });
  const xsts = await xstsReq.loadJSON();

  const uhs = xsts.DisplayClaims.xui[0].uhs;
  XBOX_ID = xsts.DisplayClaims.xui[0].xid;
  XBOX_AUTH = `XBL3.0 x=${uhs};${xsts.Token}`;
}

// ============================================================
// Data
// ============================================================
// Page through ALL unlocked achievements and record, per title, the
// time of its MOST RECENT unlock. For a 100%-completed game that last
// unlock is the moment it was completed — i.e. the "mastered" date.
// Returns a Map of titleId(string) -> latest unlock ISO timestamp.
async function getMasteryDates() {
  const dates = new Map();
  let skip = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${URL_ACHIEVEMENTS}&maxItems=${PAGE_SIZE}&skipItems=${skip}`;
    const req = new Request(url.replace("<xid>", XBOX_ID));
    req.headers = {
      "Authorization": XBOX_AUTH,
      "x-xbl-contract-version": "2",
      "Content-Type": "application/json",
    };
    req.timeoutInterval = 25;
    const resp = await req.loadJSON();
    const achs = (resp && resp.achievements) || [];
    if (achs.length === 0) break;

    for (const a of achs) {
      const ta = a.titleAssociations && a.titleAssociations[0];
      const tid = ta && ta.id != null ? String(ta.id) : null;
      const when = a.progression ? a.progression.timeUnlocked : null;
      if (!tid || !when) continue;
      const prev = dates.get(tid);
      // ISO 8601 strings sort lexicographically, so keep the max.
      if (!prev || when > prev) dates.set(tid, when);
    }
    if (achs.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return dates;
}

// Pull the full title history with achievement progress and keep the
// titles at 100% completion. Returns items ordered OLDEST first, by the
// date each game was actually completed.
async function getCompletions() {
  const req = new Request(URL_TITLEHUB.replace("<xid>", XBOX_ID));
  req.headers = {
    "Authorization": XBOX_AUTH,
    "x-xbl-contract-version": "2",
    "Accept-Language": "en-US",
    "Content-Type": "application/json",
  };
  req.timeoutInterval = 25;

  // Fetch the title list and per-title completion dates together.
  const [resp, dates] = await Promise.all([req.loadJSON(), getMasteryDates()]);
  const titles = (resp && resp.titles) || [];

  const items = [];
  for (const t of titles) {
    const ach = t.achievement || {};
    const total = Number(ach.totalGamerscore) || 0;
    const pct = Number(ach.progressPercentage);
    if (total <= 0) continue;          // no achievements -> can't "complete"
    if (isNaN(pct) || pct < 100) continue; // 100% only
    const icon = t.displayImage;
    if (!icon) continue;
    // Prefer the real completion date (last achievement unlock); fall
    // back to last-played time if the title id can't be matched.
    const lastPlayed = (t.titleHistory && t.titleHistory.lastTimePlayed) || "";
    const completedAt = (t.titleId != null && dates.get(String(t.titleId))) || lastPlayed;
    items.push({ icon, completedAt, name: t.name || "" });
  }

  // Keep the most recent MAX_GAMES, but display OLDEST first (top) ->
  // NEWEST last (bottom).
  items.sort((a, b) => (b.completedAt || "").localeCompare(a.completedAt || "")); // newest first
  const capped = items.length > MAX_GAMES ? items.slice(0, MAX_GAMES) : items;
  capped.reverse(); // oldest at top, newest at bottom
  return capped;
}

// ============================================================
// Images + disk cache
// ============================================================
// Stable, filesystem-safe key for a URL (djb2 hash) — display image
// URLs are long and not filename-safe, and uniquely identify the art.
function urlKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) | 0; // h * 33 + c
  }
  return (h >>> 0).toString(16);
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
async function loadGameIcon(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "xbox_game_thumbs");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${urlKey(url)}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const full = await new Request(url).loadImage();
    const thumb = thumbnail(full, THUMB_PX);
    fm.writeImage(path, thumb);
    return thumb;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "xbox_completion_grid.json") };
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

// ============================================================
// Grid drawing
// ============================================================
// Render the icons into one image. Columns are chosen to suit the
// widget's shape; icon size falls out of how many games there are, so
// everything fits regardless of count. Every game is a 100% completion,
// so every border is gold. The canvas is kept to a fixed, modest pixel
// size (and screen-scale off) so the bitmap stays small.
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

    // Thin gold border framing the icon (all are 100% completions).
    ctx.setStrokeColor(COLORS.gold);
    ctx.setLineWidth(border);
    ctx.strokeRect(rect);
  }

  return ctx.getImage();
}

// ============================================================
// Build widget
// ============================================================
async function buildWidget() {
  const w = new ListWidget();
  const grad = new LinearGradient();
  grad.colors = [COLORS.bg1, COLORS.bg2];
  grad.locations = [0, 1];
  w.backgroundGradient = grad;
  w.setPadding(10, 10, 10, 10);

  let items = null;
  try {
    await authenticate();
    items = await getCompletions();
    saveCache(items);
  } catch (e) {
    items = loadCache();
  }

  // ---- Legend (the only text) ----
  const legend = w.addStack();
  legend.centerAlignContent();
  const m = legend.addText("Completed");
  m.textColor = COLORS.gold;
  m.font = Font.semiboldSystemFont(11);
  legend.addSpacer();

  w.addSpacer(8);

  if (!items) {
    const msg = w.addText("No data yet. Check Keychain credentials and run once online.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(11);
    return w;
  }
  if (items.length === 0) {
    const msg = w.addText("No 100% completed games yet.");
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
  w.refreshAfterDate = new Date(Date.now() + 3 * 60 * 60 * 1000); // completions change rarely
  return w;
}

// ============================================================
// Run
// ============================================================
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
