// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: th;

// ============================================================
// Xbox Gamerscore Heatmap Widget for Scriptable (small size)
// ------------------------------------------------------------
// Draws a GitHub-style contribution grid for the current year:
//   - one ROW per month (Jan at top -> Dec at bottom)
//   - one COLUMN per day of the month (1..31, left -> right)
//   - each cell is shaded green by how much gamerscore you
//     earned that day (brighter = more gamerscore)
//
// Because there are far more columns (31) than rows (12), the
// cells come out naturally taller-than-wide, which lets the
// whole year fit neatly inside the square small widget.
//
// This talks DIRECTLY to the official Xbox Live APIs (no
// OpenXBL / third-party gateway). It reuses the same Keychain
// credentials as the other Xbox scripts:
//   - xbox_refreshtoken
//   - xbox_clientid
//   - xbox_clientsecret
// If those scripts work on this device, this one will too.
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Small size.
// ============================================================

const PAGE_SIZE = 1000; // achievements fetched per request
const MAX_PAGES = 30;   // safety cap (1000 * 30 = 30k achievements)

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
  brand: new Color("#8aab8a"),
  // Heatmap ramp: index 0 = no gamerscore that day, 4 = the most.
  // Modeled on the GitHub contribution palette but Xbox-green.
  ramp: [
    new Color("#16241a"), // empty / 0
    new Color("#2e6b27"), // low
    new Color("#46971f"), // medium
    new Color("#67c23a"), // high
    new Color("#9bff57"), // max
  ],
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
  };
}

// Page through ALL unlocked achievements and tally gamerscore per
// day for the current calendar year. Returns a 12x31 matrix
// (month index 0-11, day index 0-30) of gamerscore totals, plus
// the year total and the single highest day (for color scaling).
async function getDailyGamerscore() {
  const year = new Date().getFullYear();
  let skip = 0, yearGs = 0;

  // grid[month][day-1] = gamerscore earned that day this year.
  const grid = Array.from({ length: 12 }, () => new Array(31).fill(0));

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${URL_ACHIEVEMENTS}&maxItems=${PAGE_SIZE}&skipItems=${skip}`;
    const resp = await xblGet(url, "2");
    const achs = resp.achievements || [];
    if (achs.length === 0) break;

    for (const a of achs) {
      const gs = (a.rewards || []).find(r => r.type === "Gamerscore");
      const value = gs ? (parseInt(gs.value) || 0) : 0;
      const unlocked = a.progression ? a.progression.timeUnlocked : null;
      if (!unlocked || value <= 0) continue;
      const d = new Date(unlocked); // ISO 8601 w/ timezone -> local
      if (isNaN(d.getTime()) || d.getFullYear() !== year) continue;
      grid[d.getMonth()][d.getDate() - 1] += value;
      yearGs += value;
    }
    if (achs.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  // Find the single best day (most gamerscore) for color scaling and
  // the header readout.
  let maxDay = 0, bestMonth = -1, bestDay = -1;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < 31; d++) {
      if (grid[m][d] > maxDay) { maxDay = grid[m][d]; bestMonth = m; bestDay = d; }
    }
  }

  return { year, grid, yearGs, maxDay, bestMonth, bestDay };
}

// ============================================================
// Disk cache (so the widget still renders when offline)
// ============================================================
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "xbox_heatmap.json") };
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

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate(); // day 0 of next month
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Top-right readout: the best single day this year, e.g. "Apr 3 · 250G".
function bestDayText(data) {
  if (!data.maxDay || data.bestMonth < 0) return "0G";
  return `${MONTH_ABBR[data.bestMonth]} ${data.bestDay + 1} · ${fmtNum(data.maxDay)}G`;
}

// Map a day's gamerscore to a ramp index (0 = empty, 4 = busiest).
// Square-root scaling so small days still register a visible tint.
function rampIndex(value, maxDay) {
  if (value <= 0 || maxDay <= 0) return 0;
  const t = Math.sqrt(value) / Math.sqrt(maxDay); // 0..1
  return Math.min(4, 1 + Math.floor(t * 3.999));  // 1..4
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

  let data = null;
  try {
    await authenticate();
    const [profile, daily] = await Promise.all([getProfile(), getDailyGamerscore()]);
    data = { profile, ...daily };
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
  w.url = `https://account.xbox.com/en-us/profile?gamertag=${encodeURIComponent(profile.gamertag)}`;

  // ---- Header: year + this-year gamerscore total ----
  const header = w.addStack();
  header.centerAlignContent();
  const yearLabel = header.addText(String(data.year));
  yearLabel.textColor = COLORS.text;
  yearLabel.font = Font.boldSystemFont(12);
  header.addSpacer();
  const best = header.addText(bestDayText(data));
  best.textColor = COLORS.green;
  best.font = Font.boldSystemFont(12);
  best.lineLimit = 1;

  w.addSpacer(6);

  // ---- Heatmap grid ----
  const img = drawHeatmap(data);
  const imgStack = w.addStack();
  const wImg = imgStack.addImage(img);
  wImg.applyFittingContentMode();

  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  return w;
}

// Draw the 12-row (month) x 31-column (day) heatmap into an image.
function drawHeatmap(data) {
  const { year, grid, maxDay } = data;

  // Canvas is slightly wider than tall so the cells fill the full
  // width of the square widget (no dead space on the right). Cells
  // still come out taller-than-wide thanks to 31 columns vs 12 rows.
  const W = 330, H = 300;
  const labelW = 16;   // left gutter for month initials
  const gap = 2;       // space between cells
  const cols = 31, rows = 12;

  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;          // let the widget gradient show through
  ctx.respectScreenScale = true;

  const gridX = labelW;
  const gridY = 0;
  const gridW = W - labelW;
  const gridH = H;

  const cellW = (gridW - gap * (cols - 1)) / cols;
  const cellH = (gridH - gap * (rows - 1)) / rows;
  const radius = Math.min(cellW, cellH) * 0.28;

  const monthInitials = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const today = new Date();

  for (let m = 0; m < rows; m++) {
    const y = gridY + m * (cellH + gap);

    // Month initial down the left side.
    ctx.setTextColor(COLORS.dim);
    ctx.setFont(Font.semiboldSystemFont(Math.min(11, cellH * 0.7)));
    ctx.drawTextInRect(
      monthInitials[m],
      new Rect(0, y + (cellH - 12) / 2, labelW - 2, 14)
    );

    const dim = daysInMonth(year, m);
    for (let dayIdx = 0; dayIdx < cols; dayIdx++) {
      // Don't draw cells for days that don't exist (e.g. Feb 30/31)
      // or for future days in the current month.
      if (dayIdx >= dim) continue;
      if (m > today.getMonth() ||
          (m === today.getMonth() && dayIdx > today.getDate() - 1)) {
        if (year === today.getFullYear()) continue;
      }

      const x = gridX + dayIdx * (cellW + gap);
      const value = grid[m][dayIdx];
      ctx.setFillColor(COLORS.ramp[rampIndex(value, maxDay)]);
      const rect = new Rect(x, y, cellW, cellH);
      const path = new Path();
      path.addRoundedRect(rect, radius, radius);
      ctx.addPath(path);
      ctx.fillPath();
    }
  }

  return ctx.getImage();
}

// ============================================================
// Run
// ============================================================
const widget = await buildWidget();
if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentSmall();
}
Script.complete();
