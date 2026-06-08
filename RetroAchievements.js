// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: yellow; icon-glyph: trophy;

// ============================================================
// RetroAchievements Widget for Scriptable
// ------------------------------------------------------------
// Shows your points, retro (true) points, and most recent
// achievements with badge thumbnails.
//
// SETUP:
//   1. Get your Web API key from:
//      https://retroachievements.org/settings  ("Keys" section)
//   2. Fill in USERNAME and API_KEY below.
//   3. Add a Scriptable widget to your home screen, long-press
//      it, choose "Edit Widget", and select this script.
//      Medium or Large size works best.
// ============================================================

const USERNAME = "Aidenham";
const API_KEY  = "Yj7zpFMfhNfIrrtIBBTfwZn8FMp5HjBD";

// How many recent achievements to display (large widget shows more).
const MAX_ACHIEVEMENTS = 4;

// ------------------------------------------------------------
// Colors / theme
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#1a1a2e"),
  bg2: new Color("#16213e"),
  text: new Color("#ffffff"),
  dim: new Color("#9aa6c0"),
  gold: new Color("#ffd24a"),
  white: new Color("#e8ecf6"),
  brand: new Color("#8a92ab"), // light grey, darker than the white username
};

const API_BASE = "https://retroachievements.org/API";
const BADGE_BASE = "https://media.retroachievements.org/Badge";

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

// Download a badge image, caching it on disk so widget refreshes
// don't re-download the same artwork every time.
async function loadBadge(badgeName) {
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "ra_badges");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${badgeName}.png`);

  if (fm.fileExists(path)) {
    return fm.readImage(path);
  }
  try {
    const img = await new Request(`${BADGE_BASE}/${badgeName}.png`).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------
// Disk cache for API data (used when offline / on timeout)
// ------------------------------------------------------------
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "ra_data.json") };
}

function saveCache(data) {
  try {
    const { fm, path } = cachePath();
    fm.writeString(path, JSON.stringify(data));
  } catch (e) { /* non-fatal */ }
}

function loadCache() {
  try {
    const { fm, path } = cachePath();
    if (!fm.fileExists(path)) return null;
    return JSON.parse(fm.readString(path));
  } catch (e) {
    return null;
  }
}

// Load the user's profile picture from its path (e.g. "/UserPic/Name.png").
// Cached on disk so it still renders when offline.
async function loadProfilePic(userPicPath) {
  if (!userPicPath) return null;
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), "ra_userpic.png");
  try {
    const url = `https://media.retroachievements.org${userPicPath}`;
    const img = await new Request(url).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch (e) {
    return fm.fileExists(path) ? fm.readImage(path) : null;
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
// Flatten GetUserSummary's RecentAchievements (nested by game, then
// by achievement id) into a flat array sorted newest-first.
function flattenRecent(summary) {
  const ra = summary && summary.RecentAchievements ? summary.RecentAchievements : {};
  const items = [];
  for (const gid of Object.keys(ra)) {
    for (const aid of Object.keys(ra[gid])) items.push(ra[gid][aid]);
  }
  items.sort((a, b) => (b.DateAwarded || "").localeCompare(a.DateAwarded || ""));
  return items;
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function fmtUnlock(dateStr) {
  // dateStr like "2026-05-18 05:14:11" — RA timestamps are UTC.
  // Parse as UTC, then render in the device's local timezone.
  const d = new Date(dateStr.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return "";
  const df = new DateFormatter();
  df.dateFormat = "MMM d, h:mm a"; // e.g. "May 18, 10:14 PM" (local time)
  return df.string(d);
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
  w.setPadding(14, 16, 14, 16);

  let data = null;
  try {
    const [profile, summary, awards] = await Promise.all([
      apiGet("API_GetUserProfile.php"),
      // GetUserSummary returns the genuinely most-recent achievements,
      // unlike GetUserRecentAchievements which is a date window capped
      // at 500 results (a big window silently drops the newest unlocks).
      apiGet("API_GetUserSummary.php", { g: 5, a: 10 }),
      apiGet("API_GetUserAwards.php"),
    ]);
    const recent = flattenRecent(summary);
    data = { profile, recent, awards };
    saveCache(data); // remember the last good data for offline / timeout runs
  } catch (e) {
    data = loadCache(); // network failed — fall back to most recent data
  }

  if (!data) {
    // No connection AND no cached data yet (first run ever, offline).
    const msg = w.addText("RetroAchievements\nNo data yet — open with a connection once.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(12);
    return w;
  }

  const { profile, recent, awards } = data;

  const family = config.widgetFamily || "medium";
  const isSmall = family === "small";
  const isLarge = family === "large";

  // Tapping the widget opens the RA profile.
  w.url = `https://retroachievements.org/user/${encodeURIComponent(profile.User || USERNAME)}`;

  // ---- Header: profile pic + username (left), RetroAchievements (right) ----
  const header = w.addStack();
  header.centerAlignContent();

  const avatar = await loadProfilePic(profile.UserPic);
  if (avatar) {
    const pic = header.addImage(avatar);
    pic.imageSize = new Size(isSmall ? 20 : 24, isSmall ? 20 : 24);
    pic.cornerRadius = isSmall ? 10 : 12;
    header.addSpacer(7);
  }

  const title = header.addText(profile.User || USERNAME);
  title.textColor = COLORS.text;
  title.font = Font.boldSystemFont(isSmall ? 13 : 15);
  title.lineLimit = 1;
  header.addSpacer();

  if (!isSmall) {
    const brand = header.addText("RetroAchievements");
    brand.textColor = COLORS.brand;
    brand.font = Font.semiboldSystemFont(11);
    brand.lineLimit = 1;
  }

  w.addSpacer(isSmall ? 6 : 8);

  // ---- Stats row: Points + Retro Points ----
  const stats = w.addStack();
  stats.layoutHorizontally();

  addStat(stats, fmtNum(profile.TotalPoints), "Points", COLORS.gold, isSmall);
  stats.addSpacer();
  addStat(stats, fmtNum(profile.TotalTruePoints), "Retro Pts", COLORS.white, isSmall);
  if (!isSmall) {
    stats.addSpacer();
    const mastered = awards && awards.MasteryAwardsCount != null ? awards.MasteryAwardsCount : 0;
    addStat(stats, fmtNum(mastered), "Mastered", COLORS.gold, isSmall);
  }

  if (isSmall) return w; // small widget: stats only

  w.addSpacer(10);

  // ---- Recent achievements ----
  const label = w.addText("RECENT ACHIEVEMENTS");
  label.textColor = COLORS.dim;
  label.font = Font.semiboldSystemFont(9);
  w.addSpacer(6);

  const list = Array.isArray(recent) ? recent.slice(0, isLarge ? 6 : MAX_ACHIEVEMENTS) : [];

  if (list.length === 0) {
    const none = w.addText("No recent achievements found.");
    none.textColor = COLORS.dim;
    none.font = Font.systemFont(11);
  } else {
    // Pre-load all badges in parallel.
    const badges = await Promise.all(list.map(a => loadBadge(a.BadgeName)));
    for (let i = 0; i < list.length; i++) {
      addAchievementRow(w, list[i], badges[i], isLarge);
      // Large now shows 6 rows instead of 7, so each row (and its
      // gap) is scaled up by 7/6 to fill the same space.
      if (i < list.length - 1) w.addSpacer(isLarge ? 7 : 6);
    }
  }

  w.addSpacer();

  // Refresh roughly every 30 minutes.
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

function addAchievementRow(w, ach, badge, isLarge) {
  // Large fits 6 rows where it used to fit 7, so scale the row up by
  // 7/6 = ~1.17x. Medium (and the fallback) keep the original sizes.
  const iconSize = isLarge ? 33 : 28;
  const corner = isLarge ? 6 : 5;
  const gap = isLarge ? 9 : 8;
  const titleSize = isLarge ? 14 : 12;
  const subSize = isLarge ? 12 : 10;

  const row = w.addStack();
  row.centerAlignContent();

  if (badge) {
    const img = row.addImage(badge);
    img.imageSize = new Size(iconSize, iconSize);
    img.cornerRadius = corner;
  } else {
    const ph = row.addText("🎮");
    ph.font = Font.systemFont(isLarge ? 31 : 22);
  }
  row.addSpacer(gap);

  const col = row.addStack();
  col.layoutVertically();

  const t = col.addText(`${ach.Title} (${ach.Points})`);
  t.textColor = COLORS.text;
  t.font = Font.semiboldSystemFont(titleSize);
  t.lineLimit = 1;

  const sub = col.addText(`${ach.GameTitle} · ${fmtUnlock(ach.DateAwarded)}`);
  sub.textColor = COLORS.dim;
  sub.font = Font.systemFont(subSize);
  sub.lineLimit = 1;

  row.addSpacer();
}

// ------------------------------------------------------------
// Run
// ------------------------------------------------------------
const widget = await buildWidget();

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // When run inside the Scriptable app, preview at medium size.
  await widget.presentMedium();
}
Script.complete();
