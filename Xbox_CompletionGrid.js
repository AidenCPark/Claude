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
// Games are ordered OLDEST at the top -> NEWEST at the bottom
// (using when the title was last played as the completion proxy,
// since Xbox doesn't expose a per-game completion date here).
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

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------
const URL_TITLEHUB = "https://titlehub.xboxlive.com/users/xuid(<xid>)/titles/titleHistory/decoration/achievement,scid";
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
// Pull the full title history with achievement progress and keep the
// titles at 100% completion. Returns items ordered OLDEST first.
async function getCompletions() {
  const req = new Request(URL_TITLEHUB.replace("<xid>", XBOX_ID));
  req.headers = {
    "Authorization": XBOX_AUTH,
    "x-xbl-contract-version": "2",
    "Accept-Language": "en-US",
    "Content-Type": "application/json",
  };
  req.timeoutInterval = 25;
  const resp = await req.loadJSON();
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
    const played = (t.titleHistory && t.titleHistory.lastTimePlayed) || "";
    items.push({ icon, completedAt: played, name: t.name || "" });
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

async function loadGameIcon(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "xbox_game_icons");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${urlKey(url)}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const img = await new Request(url).loadImage();
    fm.writeImage(path, img);
    return img;
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
// widget's shape; icon size falls out of how many games there are,
// so everything fits regardless of count. Every game is a 100%
// completion, so every border is gold.
function drawGrid(items, icons, aspect) {
  const n = items.length;
  const cell = 100;            // canvas units; final size scales to widget
  const gap = 16;
  const border = 7;            // thin border thickness

  let cols = Math.max(1, Math.round(Math.sqrt(n * aspect)));
  cols = Math.min(cols, n);
  const rows = Math.ceil(n / cols);

  const W = gap + cols * (cell + gap);
  const H = gap + rows * (cell + gap);

  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;          // let the widget gradient show in the gaps
  ctx.respectScreenScale = true;

  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const rIdx = Math.floor(i / cols);
    const x = gap + c * (cell + gap);
    const y = gap + rIdx * (cell + gap);
    const rect = new Rect(x, y, cell, cell);

    const icon = icons[i];
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

  const icons = await Promise.all(items.map(it => loadGameIcon(it.icon)));
  const gridImg = drawGrid(items, icons, aspect);

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
