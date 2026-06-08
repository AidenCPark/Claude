// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: yellow; icon-glyph: th;

// ============================================================
// RetroAchievements Points Heatmap Widget (small size)
// ------------------------------------------------------------
// Draws a GitHub-style contribution grid for the current year:
//   - one ROW per month (Jan at top -> Dec at bottom)
//   - one COLUMN per day of the month (1..31, left -> right)
//   - each cell is shaded gold by how many points you earned
//     that day (brighter = more points)
//
// Because there are far more columns (31) than rows (12), the
// cells come out naturally taller-than-wide, which lets the
// whole year fit neatly inside the square small widget.
//
// SETUP:
//   1. Get your Web API key from:
//      https://retroachievements.org/settings  ("Keys" section)
//   2. Fill in USERNAME and API_KEY below.
//   3. Add a Scriptable widget, long-press -> "Edit Widget",
//      pick this script, and choose the Small size.
// ============================================================

const USERNAME = "Aidenham";
const API_KEY  = "Yj7zpFMfhNfIrrtIBBTfwZn8FMp5HjBD";

// ------------------------------------------------------------
// Colors / theme  (RetroAchievements gold)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#1a1a2e"),
  bg2: new Color("#16213e"),
  text: new Color("#ffffff"),
  dim: new Color("#9aa6c0"),
  gold: new Color("#ffd24a"),
  // Heatmap ramp: index 0 = no points that day, 4 = the most.
  // Modeled on the GitHub contribution palette but RA-gold.
  ramp: [
    new Color("#26263e"), // empty / 0
    new Color("#5c4a1f"), // low
    new Color("#9c7d1f"), // medium
    new Color("#d6a92a"), // high
    new Color("#ffd24a"), // max
  ],
};

const API_BASE = "https://retroachievements.org/API";

// ------------------------------------------------------------
// Networking
// ------------------------------------------------------------
async function apiGet(endpoint, extraParams = {}) {
  const all = { u: USERNAME, y: API_KEY, ...extraParams };
  const query = Object.keys(all)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(all[k])}`)
    .join("&");
  const url = `${API_BASE}/${endpoint}?${query}`;
  const req = new Request(url);
  req.timeoutInterval = 20;
  return await req.loadJSON();
}

// ------------------------------------------------------------
// Data fetching
// ------------------------------------------------------------
// Pull every achievement earned this calendar year and tally points
// per day. Returns a 12x31 matrix (month index 0-11, day index 0-30)
// of point totals, plus the year total and the single best day.
async function getDailyPoints() {
  const now = new Date();
  const year = now.getFullYear();

  // API_GetAchievementsEarnedBetween takes unix-second timestamps and
  // returns a flat array of unlocks ({ Date, Points, ... }) for the
  // window — no 500-result cap like the recent-achievements endpoint.
  const from = Math.floor(new Date(year, 0, 1, 0, 0, 0).getTime() / 1000);
  const to = Math.floor(now.getTime() / 1000);
  const resp = await apiGet("API_GetAchievementsEarnedBetween.php", { f: from, t: to });
  const unlocks = Array.isArray(resp) ? resp : [];

  // grid[month][day-1] = points earned that day this year.
  const grid = Array.from({ length: 12 }, () => new Array(31).fill(0));
  let yearPts = 0;

  for (const a of unlocks) {
    const points = parseInt(a.Points) || 0;
    if (points <= 0 || !a.Date) continue;
    // RA timestamps are UTC ("2026-05-18 05:14:11"); render in local time.
    const d = new Date(a.Date.replace(" ", "T") + "Z");
    if (isNaN(d.getTime()) || d.getFullYear() !== year) continue;
    grid[d.getMonth()][d.getDate() - 1] += points;
    yearPts += points;
  }

  // Find the single best day (most points) for color scaling + header.
  let maxDay = 0, bestMonth = -1, bestDay = -1;
  for (let m = 0; m < 12; m++) {
    for (let d = 0; d < 31; d++) {
      if (grid[m][d] > maxDay) { maxDay = grid[m][d]; bestMonth = m; bestDay = d; }
    }
  }

  return { year, grid, yearPts, maxDay, bestMonth, bestDay };
}

// ------------------------------------------------------------
// Disk cache (so the widget still renders when offline)
// ------------------------------------------------------------
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "ra_heatmap.json") };
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
// Formatting helpers
// ------------------------------------------------------------
function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate(); // day 0 of next month
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Top-right readout: the best single day this year, e.g. "Apr 3 · 250".
function bestDayText(data) {
  if (!data.maxDay || data.bestMonth < 0) return "0";
  return `${MONTH_ABBR[data.bestMonth]} ${data.bestDay + 1} · ${fmtNum(data.maxDay)}`;
}

// Map a day's points to a ramp index (0 = empty, 4 = busiest).
// Square-root scaling so small days still register a visible tint.
function rampIndex(value, maxDay) {
  if (value <= 0 || maxDay <= 0) return 0;
  const t = Math.sqrt(value) / Math.sqrt(maxDay); // 0..1
  return Math.min(4, 1 + Math.floor(t * 3.999));  // 1..4
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

  let data = null;
  try {
    data = await getDailyPoints();
    saveCache(data); // remember last good data for offline / failed runs
  } catch (e) {
    data = loadCache(); // network failed — show most recent data
  }

  if (!data) {
    const msg = w.addText("RetroAchievements\nNo data yet — open with a connection once.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(12);
    return w;
  }

  w.url = `https://retroachievements.org/user/${encodeURIComponent(USERNAME)}`;

  // ---- Header: year + best day ----
  const header = w.addStack();
  header.centerAlignContent();
  const yearLabel = header.addText(String(data.year));
  yearLabel.textColor = COLORS.text;
  yearLabel.font = Font.boldSystemFont(12);
  header.addSpacer();
  const best = header.addText(bestDayText(data));
  best.textColor = COLORS.gold;
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

  // Canvas is wider than tall so the cells fill the full width of the
  // square widget. Cells still come out taller-than-wide thanks to 31
  // columns vs 12 rows.
  const W = 360, H = 300;
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
