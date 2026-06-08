// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: gamepad;

// ============================================================
// Xbox Widget for Scriptable  (direct Xbox Live API)
// ------------------------------------------------------------
// Shows your gamerscore, this-year progress, and most recent
// achievements with icon thumbnails.
//
// This talks DIRECTLY to the official Xbox Live APIs (no
// OpenXBL / third-party gateway). It reuses the same Keychain
// credentials as the "Xbox GamerScore Chart" script:
//   - xbox_refreshtoken
//   - xbox_clientid
//   - xbox_clientsecret
// If that script works on this device, this one will too — no
// extra setup required.
//
// Add a Scriptable widget, long-press -> "Edit Widget", and
// select this script. Medium or Large size works best.
// ============================================================

const MAX_ACHIEVEMENTS = 4; // shown on a Medium widget (Large shows 7)
const PAGE_SIZE = 1000;     // achievements fetched per request
const MAX_PAGES = 30;       // safety cap (1000 * 30 = 30k achievements)

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------
const URL_PROFILE = "https://peoplehub.xboxlive.com/users/me/people/xuids(<xid>)/decoration/detail,preferredColor,presenceDetail";
const URL_ACHIEVEMENTS = "https://achievements.xboxlive.com/users/xuid(<xid>)/achievements?orderBy=UnlockTime&unlockedOnly=true";
const URL_MS_TOKEN = "https://login.live.com/oauth20_token.srf";
const URL_XBL_AUTH = "https://user.auth.xboxlive.com/user/authenticate";
const URL_XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";

// ------------------------------------------------------------
// Colors / theme  (Xbox green)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#0e1a0e"),
  bg2: new Color("#10280f"),
  text: new Color("#ffffff"),
  dim: new Color("#9ab59a"),
  green: new Color("#7cd64b"),
  white: new Color("#e8f6e8"),
  brand: new Color("#8aab8a"),
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

async function xblGet(url, contractVersion) {
  const req = new Request(url.replace("<xid>", XBOX_ID));
  req.headers = {
    "Authorization": XBOX_AUTH,
    "x-xbl-contract-version": contractVersion,
    "Content-Type": "application/json",
  };
  req.timeoutInterval = 20;
  return await req.loadJSON();
}

// ============================================================
// Data fetching
// ============================================================
async function getProfile() {
  const resp = await xblGet(URL_PROFILE, "3");
  const p = resp.people && resp.people[0] ? resp.people[0] : {};
  return {
    gamertag: p.gamertag || "Xbox",
    gamerscore: p.gamerScore || "0",
    gamerpic: p.displayPicRaw || null,
  };
}

// Page through ALL unlocked achievements (order-agnostic — the API
// does not reliably return them newest-first). Tally this calendar
// year's gamerscore + unlock count, and sort to find the true most
// recent unlocks for the list.
async function getAchievements() {
  const year = new Date().getFullYear();
  let skip = 0, yearGs = 0, yearCount = 0;
  const all = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${URL_ACHIEVEMENTS}&maxItems=${PAGE_SIZE}&skipItems=${skip}`;
    const resp = await xblGet(url, "2");
    const achs = resp.achievements || [];
    if (achs.length === 0) break;

    for (const a of achs) {
      const parsed = parseAchievement(a);
      all.push(parsed);
      const d = parsed.unlocked ? new Date(parsed.unlocked) : null;
      if (d && !isNaN(d.getTime()) && d.getFullYear() === year && parsed.gamerscore != null) {
        yearGs += parseInt(parsed.gamerscore) || 0;
        yearCount++;
      }
    }
    if (achs.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  all.sort((a, b) => new Date(b.unlocked) - new Date(a.unlocked)); // newest first
  return { recent: all.slice(0, 10), yearGs, yearCount };
}

function parseAchievement(a) {
  const game = a.titleAssociations && a.titleAssociations[0] ? a.titleAssociations[0].name : "";
  const icon = (a.mediaAssets || []).find(m => m.type === "Icon");
  const gs = (a.rewards || []).find(r => r.type === "Gamerscore");
  return {
    id: a.id,
    title: a.name,
    game,
    gamerscore: gs ? gs.value : null,
    iconUrl: icon ? icon.url : null,
    unlocked: a.progression ? a.progression.timeUnlocked : null,
  };
}

// ============================================================
// Images + disk cache
// ============================================================
// Small, stable, filesystem-safe key for a URL (djb2 hash). Used to
// name cached icons by their image URL rather than by achievement id —
// Xbox achievement ids are only unique *within a game*, so keying the
// cache by id caused different achievements (from different games) to
// collide and reuse each other's icon. The URL uniquely identifies the
// actual image, so this can't collide.
function urlKey(url) {
  let h = 5381;
  for (let i = 0; i < url.length; i++) {
    h = ((h << 5) + h + url.charCodeAt(i)) | 0; // h * 33 + c
  }
  return (h >>> 0).toString(16);
}

async function loadIcon(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "xbox_icons");
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

async function loadGamerpic(url) {
  if (!url) return null;
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), "xbox_gamerpic.png");
  try {
    const img = await new Request(url).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch (e) {
    return fm.fileExists(path) ? fm.readImage(path) : null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "xbox_data.json") };
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

// ============================================================
// Formatting helpers
// ============================================================
function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}
function fmtUnlock(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr); // Xbox timestamps are ISO 8601 w/ timezone
  if (isNaN(d.getTime())) return "";
  const df = new DateFormatter();
  df.dateFormat = "MMM d, h:mm a"; // local time, e.g. "May 18, 10:14 PM"
  return df.string(d);
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
  w.setPadding(14, 16, 14, 16);

  let data = null;
  try {
    await authenticate();
    const [profile, ach] = await Promise.all([getProfile(), getAchievements()]);
    data = { profile, recent: ach.recent, yearGs: ach.yearGs, yearCount: ach.yearCount };
    saveCache(data); // remember last good data for offline / failed runs
  } catch (e) {
    data = loadCache(); // network/auth failed — show most recent data
  }

  if (!data) {
    const msg = w.addText("Xbox\nNo data yet. Check Keychain credentials and run once online.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(12);
    return w;
  }

  const { profile } = data;
  const family = config.widgetFamily || "medium";
  const isSmall = family === "small";
  const isLarge = family === "large";

  w.url = `https://account.xbox.com/en-us/profile?gamertag=${encodeURIComponent(profile.gamertag)}`;

  // ---- Header: gamerpic + gamertag (left), Xbox (right) ----
  const header = w.addStack();
  header.centerAlignContent();
  const pic = await loadGamerpic(profile.gamerpic);
  if (pic) {
    const img = header.addImage(pic);
    img.imageSize = new Size(isSmall ? 20 : 24, isSmall ? 20 : 24);
    img.cornerRadius = isSmall ? 10 : 12;
    header.addSpacer(7);
  }
  const title = header.addText(profile.gamertag);
  title.textColor = COLORS.text;
  title.font = Font.boldSystemFont(isSmall ? 13 : 15);
  title.lineLimit = 1;
  header.addSpacer();
  if (!isSmall) {
    const brand = header.addText("Xbox");
    brand.textColor = COLORS.brand;
    brand.font = Font.semiboldSystemFont(11);
  }

  w.addSpacer(isSmall ? 6 : 8);

  // ---- Stats: Gamerscore / This-year GS / This-year unlocks ----
  const stats = w.addStack();
  stats.layoutHorizontally();
  addStat(stats, fmtNum(profile.gamerscore), "Gamerscore", COLORS.green, isSmall);
  stats.addSpacer();
  addStat(stats, "+" + fmtNum(data.yearGs), "This Year", COLORS.white, isSmall);
  if (!isSmall) {
    stats.addSpacer();
    addStat(stats, fmtNum(data.yearCount), "Unlocked", COLORS.green, isSmall);
  }

  if (isSmall) return w;

  w.addSpacer(10);

  const label = w.addText("RECENT ACHIEVEMENTS");
  label.textColor = COLORS.dim;
  label.font = Font.semiboldSystemFont(9);
  w.addSpacer(6);

  const list = (data.recent || []).slice(0, isLarge ? 7 : MAX_ACHIEVEMENTS);
  if (list.length === 0) {
    const none = w.addText("No recent achievements found.");
    none.textColor = COLORS.dim;
    none.font = Font.systemFont(11);
  } else {
    const icons = await Promise.all(list.map(a => loadIcon(a.iconUrl)));
    for (let i = 0; i < list.length; i++) {
      addAchievementRow(w, list[i], icons[i]);
      if (i < list.length - 1) w.addSpacer(6);
    }
  }

  w.addSpacer();
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

function addStat(parent, value, caption, color, isSmall) {
  const col = parent.addStack();
  col.layoutVertically();
  const v = col.addText(value);
  v.textColor = color;
  v.font = Font.boldSystemFont(isSmall ? 16 : 20);
  v.lineLimit = 1;
  const c = col.addText(caption);
  c.textColor = COLORS.dim;
  c.font = Font.systemFont(isSmall ? 9 : 10);
}

function addAchievementRow(w, ach, icon) {
  const row = w.addStack();
  row.centerAlignContent();
  if (icon) {
    const img = row.addImage(icon);
    img.imageSize = new Size(28, 28);
    img.cornerRadius = 5;
  } else {
    const ph = row.addText("🎮");
    ph.font = Font.systemFont(22);
  }
  row.addSpacer(8);

  const col = row.addStack();
  col.layoutVertically();
  const gsLabel = ach.gamerscore != null ? ` (${ach.gamerscore}G)` : "";
  const t = col.addText(`${ach.title}${gsLabel}`);
  t.textColor = COLORS.text;
  t.font = Font.semiboldSystemFont(12);
  t.lineLimit = 1;
  const sub = col.addText(`${ach.game} · ${fmtUnlock(ach.unlocked)}`);
  sub.textColor = COLORS.dim;
  sub.font = Font.systemFont(10);
  sub.lineLimit = 1;
  row.addSpacer();
}

// ============================================================
// Run
// ============================================================
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();
