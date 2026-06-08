// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: city;

// ============================================================
// City Dashboard Widget for Scriptable  (Large size)
// ------------------------------------------------------------
// A dense, at-a-glance dashboard for wherever you currently are.
// Everything comes from FREE, keyless APIs — no signup needed:
//   - Current location  : Scriptable's Location + reverse geocode
//   - Weather / forecast : Open-Meteo  (open-meteo.com)
//   - Air quality        : Open-Meteo Air Quality API
//
// Shows: city + date/time, current conditions, feels-like,
// humidity, wind, UV, rain chance, a 6-hour strip, a 6-day
// forecast, sunrise/sunset, and US AQI.
//
// SETUP:
//   1. Add a Scriptable widget, long-press -> "Edit Widget".
//   2. Pick this script and choose the LARGE size.
//   3. Allow location access when prompted (needed for "current
//      city"). Data is cached so it still renders when offline.
// ============================================================

// Force imperial/metric, or leave null to auto-detect from locale.
const FORCE_IMPERIAL = null; // true, false, or null (auto)

const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";
const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

// ------------------------------------------------------------
// Colors / theme  (dark slate dashboard)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#0b1220"),
  bg2: new Color("#15203a"),
  text: new Color("#f2f6ff"),
  dim: new Color("#8ea0c0"),
  faint: new Color("#5f6f90"),
  line: new Color("#ffffff", 0.10),
  chip: new Color("#ffffff", 0.06),
  sun: new Color("#ffd24a"),
  rain: new Color("#5aa9ff"),
  snow: new Color("#cfe8ff"),
  storm: new Color("#b794f6"),
  accent: new Color("#5aa9ff"),
};

// ============================================================
// Units (locale-aware)
// ============================================================
function preferImperial() {
  if (FORCE_IMPERIAL !== null) return FORCE_IMPERIAL;
  const loc = (Device.locale() || "").toUpperCase();
  // US, Liberia, Myanmar use imperial-ish conventions.
  return /[_-](US|LR|MM)\b/.test(loc) || loc.endsWith("US");
}
const IMPERIAL = preferImperial();
const UNITS = {
  temp: IMPERIAL ? "fahrenheit" : "celsius",
  wind: IMPERIAL ? "mph" : "kmh",
  windLabel: IMPERIAL ? "mph" : "km/h",
  precip: IMPERIAL ? "inch" : "mm",
};

// ============================================================
// Location
// ============================================================
function locCachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "city_dash_loc.json") };
}
function saveLoc(loc) {
  try { const { fm, path } = locCachePath(); fm.writeString(path, JSON.stringify(loc)); } catch (e) {}
}
function loadLoc() {
  try {
    const { fm, path } = locCachePath();
    return fm.fileExists(path) ? JSON.parse(fm.readString(path)) : null;
  } catch (e) { return null; }
}

async function getLocation() {
  try {
    Location.setAccuracyToThreeKilometers(); // city-level is plenty + faster
    const loc = await Location.current();
    const lat = loc.latitude, lon = loc.longitude;
    let city = "Current Location";
    try {
      const geo = await Location.reverseGeocode(lat, lon);
      if (geo && geo[0]) {
        const g = geo[0];
        city = g.locality || g.subAdministrativeArea || g.administrativeArea || g.name || city;
      }
    } catch (e) { /* geocode optional */ }
    const out = { lat, lon, city };
    saveLoc(out);
    return out;
  } catch (e) {
    const cached = loadLoc();
    if (cached) return cached;
    throw e;
  }
}

// ============================================================
// Data fetching
// ============================================================
async function getJSON(base, params) {
  const query = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const req = new Request(`${base}?${query}`);
  req.timeoutInterval = 20;
  return await req.loadJSON();
}

async function fetchWeather(loc) {
  return getJSON(WEATHER_URL, {
    latitude: loc.lat,
    longitude: loc.lon,
    timezone: "auto",
    forecast_days: 7,
    temperature_unit: UNITS.temp,
    wind_speed_unit: UNITS.wind,
    precipitation_unit: UNITS.precip,
    current: [
      "temperature_2m", "relative_humidity_2m", "apparent_temperature",
      "is_day", "precipitation", "weather_code",
      "wind_speed_10m", "wind_direction_10m", "uv_index",
    ].join(","),
    hourly: ["temperature_2m", "weather_code", "precipitation_probability"].join(","),
    daily: [
      "weather_code", "temperature_2m_max", "temperature_2m_min",
      "sunrise", "sunset", "uv_index_max", "precipitation_probability_max",
    ].join(","),
  });
}

async function fetchAir(loc) {
  return getJSON(AIR_URL, {
    latitude: loc.lat,
    longitude: loc.lon,
    timezone: "auto",
    current: ["us_aqi", "pm2_5", "pm10"].join(","),
  });
}

// ============================================================
// Disk cache (combined dashboard data)
// ============================================================
function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "city_dash_data.json") };
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
// Helpers
// ============================================================
function r(n) { return Math.round(Number(n)); }
function deg() { return "°"; }

function compass(d) {
  if (d == null || isNaN(d)) return "";
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(d / 45) % 8];
}

function uvRisk(uv) {
  if (uv == null) return "UV";
  if (uv < 3) return "Low";
  if (uv < 6) return "Moderate";
  if (uv < 8) return "High";
  if (uv < 11) return "Very High";
  return "Extreme";
}

function aqiInfo(aqi) {
  if (aqi == null || isNaN(aqi)) return { label: "—", color: COLORS.dim };
  if (aqi <= 50) return { label: "Good", color: new Color("#4ade80") };
  if (aqi <= 100) return { label: "Moderate", color: new Color("#facc15") };
  if (aqi <= 150) return { label: "Sensitive", color: new Color("#fb923c") };
  if (aqi <= 200) return { label: "Unhealthy", color: new Color("#f87171") };
  if (aqi <= 300) return { label: "Very Unhealthy", color: new Color("#c084fc") };
  return { label: "Hazardous", color: new Color("#b91c1c") };
}

// WMO weather code -> [label, SF Symbol]. Day/night aware for clear/cloud.
function wx(code, isDay) {
  const m = {
    0: ["Clear", isDay ? "sun.max.fill" : "moon.stars.fill"],
    1: ["Mainly Clear", isDay ? "sun.max.fill" : "moon.stars.fill"],
    2: ["Partly Cloudy", isDay ? "cloud.sun.fill" : "cloud.moon.fill"],
    3: ["Overcast", "cloud.fill"],
    45: ["Fog", "cloud.fog.fill"], 48: ["Rime Fog", "cloud.fog.fill"],
    51: ["Lt Drizzle", "cloud.drizzle.fill"], 53: ["Drizzle", "cloud.drizzle.fill"], 55: ["Hvy Drizzle", "cloud.drizzle.fill"],
    56: ["Frz Drizzle", "cloud.sleet.fill"], 57: ["Frz Drizzle", "cloud.sleet.fill"],
    61: ["Light Rain", "cloud.rain.fill"], 63: ["Rain", "cloud.rain.fill"], 65: ["Heavy Rain", "cloud.heavyrain.fill"],
    66: ["Frz Rain", "cloud.sleet.fill"], 67: ["Frz Rain", "cloud.sleet.fill"],
    71: ["Light Snow", "cloud.snow.fill"], 73: ["Snow", "cloud.snow.fill"], 75: ["Heavy Snow", "cloud.snow.fill"], 77: ["Snow Grains", "cloud.snow.fill"],
    80: ["Showers", "cloud.heavyrain.fill"], 81: ["Showers", "cloud.heavyrain.fill"], 82: ["Hvy Showers", "cloud.heavyrain.fill"],
    85: ["Snow Showers", "cloud.snow.fill"], 86: ["Snow Showers", "cloud.snow.fill"],
    95: ["Thunderstorm", "cloud.bolt.rain.fill"], 96: ["Thunderstorm", "cloud.bolt.rain.fill"], 99: ["Thunderstorm", "cloud.bolt.rain.fill"],
  };
  return m[code] || ["—", "cloud.fill"];
}

function wxColor(code) {
  if (code <= 1) return COLORS.sun;
  if (code <= 3 || code === 45 || code === 48) return COLORS.text;
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return COLORS.rain;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return COLORS.snow;
  if (code >= 95) return COLORS.storm;
  return COLORS.text;
}

function fmt(date, pattern) {
  const df = new DateFormatter();
  df.dateFormat = pattern;
  return df.string(date);
}

// Index of the hourly slot for the current hour (or the next available).
function hourStartIndex(times) {
  const start = new Date(); start.setMinutes(0, 0, 0);
  for (let i = 0; i < times.length; i++) {
    if (new Date(times[i]).getTime() >= start.getTime()) return i;
  }
  return 0;
}

// ============================================================
// UI building blocks
// ============================================================
function addSymbol(parent, name, size, color) {
  const sf = SFSymbol.named(name);
  if (sf) {
    sf.applyFont(Font.systemFont(size));
    const wi = parent.addImage(sf.image);
    wi.imageSize = new Size(size, size);
    if (color) wi.tintColor = color;
    return wi;
  }
  const t = parent.addText("•");
  t.font = Font.systemFont(size);
  if (color) t.textColor = color;
  return t;
}

function addDivider(w) {
  const line = w.addStack();
  line.backgroundColor = COLORS.line;
  line.addSpacer();
  line.size = new Size(0, 1);
}

function sectionLabel(w, text) {
  const l = w.addText(text);
  l.textColor = COLORS.faint;
  l.font = Font.semiboldSystemFont(9);
}

// A compact "icon + value + caption" stat chip.
function addChip(parent, symbol, color, value, caption) {
  const chip = parent.addStack();
  chip.layoutVertically();
  chip.centerAlignContent();
  chip.backgroundColor = COLORS.chip;
  chip.cornerRadius = 9;
  chip.setPadding(6, 6, 6, 6);

  const top = chip.addStack();
  top.centerAlignContent();
  top.addSpacer();
  addSymbol(top, symbol, 11, color);
  top.addSpacer(3);
  const v = top.addText(value);
  v.textColor = COLORS.text;
  v.font = Font.boldSystemFont(13);
  v.lineLimit = 1;
  v.minimumScaleFactor = 0.6;
  top.addSpacer();

  const c = chip.addText(caption);
  c.textColor = COLORS.dim;
  c.font = Font.systemFont(8.5);
  c.lineLimit = 1;
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
  w.setPadding(14, 14, 14, 14);

  let data = null;
  try {
    const loc = await getLocation();
    const [weather, air] = await Promise.all([
      fetchWeather(loc),
      fetchAir(loc).catch(() => null), // AQI is optional — don't fail the widget
    ]);
    data = { loc, weather, air, ts: Date.now() };
    saveCache(data);
  } catch (e) {
    data = loadCache();
  }

  if (!data || !data.weather || !data.weather.current) {
    const msg = w.addText("City Dashboard\nNo data yet. Allow location access and open once online.");
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(13);
    return w;
  }

  const { loc, weather, air } = data;
  const cur = weather.current;
  const daily = weather.daily || {};
  const hourly = weather.hourly || {};
  const [curLabel, curSymbol] = wx(cur.weather_code, cur.is_day === 1);

  // Tapping opens a maps/weather search for the city.
  w.url = "https://weather.com/weather/today";

  // ---------- Header: city + datetime  /  big temp + condition ----------
  const head = w.addStack();
  head.centerAlignContent();

  const left = head.addStack();
  left.layoutVertically();
  const cityRow = left.addStack();
  cityRow.centerAlignContent();
  addSymbol(cityRow, "location.fill", 12, COLORS.accent);
  cityRow.addSpacer(4);
  const city = cityRow.addText(loc.city || "Current Location");
  city.textColor = COLORS.text;
  city.font = Font.boldSystemFont(18);
  city.lineLimit = 1;
  city.minimumScaleFactor = 0.6;
  const when = left.addText(fmt(new Date(), "EEE, MMM d  ·  h:mm a"));
  when.textColor = COLORS.dim;
  when.font = Font.systemFont(11);

  head.addSpacer();

  const right = head.addStack();
  right.centerAlignContent();
  addSymbol(right, curSymbol, 34, wxColor(cur.weather_code));
  right.addSpacer(8);
  const tcol = right.addStack();
  tcol.layoutVertically();
  const temp = tcol.addText(`${r(cur.temperature_2m)}${deg()}`);
  temp.textColor = COLORS.text;
  temp.font = Font.boldSystemFont(34);
  temp.lineLimit = 1;
  const cond = tcol.addText(curLabel);
  cond.textColor = COLORS.dim;
  cond.font = Font.systemFont(11);
  cond.lineLimit = 1;

  w.addSpacer(10);

  // ---------- Current stat chips ----------
  const chips = w.addStack();
  chips.layoutHorizontally();
  chips.spacing = 6;
  const todayPop = (daily.precipitation_probability_max || [])[0];
  const chipDefs = [
    ["thermometer", COLORS.sun, `${r(cur.apparent_temperature)}${deg()}`, "Feels"],
    ["humidity.fill", COLORS.rain, `${r(cur.relative_humidity_2m)}%`, "Humidity"],
    ["wind", COLORS.text, `${compass(cur.wind_direction_10m)} ${r(cur.wind_speed_10m)}`, UNITS.windLabel],
    ["sun.max.fill", COLORS.sun, `${r(cur.uv_index)}`, uvRisk(cur.uv_index)],
    ["drop.fill", COLORS.accent, `${todayPop == null ? "—" : r(todayPop) + "%"}`, "Rain"],
  ];
  for (const [sym, col, val, cap] of chipDefs) {
    const cell = chips.addStack();
    cell.layoutVertically();
    addChip(cell, sym, col, val, cap);
  }

  w.addSpacer(10);
  addDivider(w);
  w.addSpacer(8);

  // ---------- Hourly strip (next 6 hours) ----------
  sectionLabel(w, "HOURLY");
  w.addSpacer(5);
  const hRow = w.addStack();
  hRow.layoutHorizontally();
  const hTimes = hourly.time || [];
  const start = hourStartIndex(hTimes);
  const HOURS = 6;
  for (let j = 0; j < HOURS; j++) {
    const idx = start + j;
    if (idx >= hTimes.length) break;
    const code = (hourly.weather_code || [])[idx];
    const col = hRow.addStack();
    col.layoutVertically();
    col.centerAlignContent();

    const lbl = col.addText(j === 0 ? "Now" : fmt(new Date(hTimes[idx]), "ha"));
    lbl.textColor = COLORS.dim;
    lbl.font = Font.systemFont(10);
    lbl.centerAlignText();
    col.addSpacer(3);

    const iconRow = col.addStack();
    iconRow.addSpacer();
    addSymbol(iconRow, wx(code, true)[1], 18, wxColor(code));
    iconRow.addSpacer();
    col.addSpacer(3);

    const t = col.addText(`${r((hourly.temperature_2m || [])[idx])}${deg()}`);
    t.textColor = COLORS.text;
    t.font = Font.semiboldSystemFont(12);
    t.centerAlignText();

    if (j < HOURS - 1) hRow.addSpacer();
  }

  w.addSpacer(8);
  addDivider(w);
  w.addSpacer(8);

  // ---------- Daily forecast (6 days) ----------
  sectionLabel(w, `${(daily.time || []).length}-DAY FORECAST`);
  w.addSpacer(5);
  const dRow = w.addStack();
  dRow.layoutHorizontally();
  const dTimes = daily.time || [];
  const DAYS = Math.min(6, dTimes.length);
  for (let i = 0; i < DAYS; i++) {
    const code = (daily.weather_code || [])[i];
    const col = dRow.addStack();
    col.layoutVertically();
    col.centerAlignContent();

    const day = col.addText(i === 0 ? "Today" : fmt(new Date(dTimes[i]), "EEE"));
    day.textColor = COLORS.dim;
    day.font = Font.systemFont(10);
    day.centerAlignText();
    col.addSpacer(3);

    const iconRow = col.addStack();
    iconRow.addSpacer();
    addSymbol(iconRow, wx(code, true)[1], 18, wxColor(code));
    iconRow.addSpacer();
    col.addSpacer(3);

    const hi = col.addText(`${r((daily.temperature_2m_max || [])[i])}${deg()}`);
    hi.textColor = COLORS.text;
    hi.font = Font.semiboldSystemFont(12);
    hi.centerAlignText();
    const lo = col.addText(`${r((daily.temperature_2m_min || [])[i])}${deg()}`);
    lo.textColor = COLORS.faint;
    lo.font = Font.systemFont(11);
    lo.centerAlignText();

    if (i < DAYS - 1) dRow.addSpacer();
  }

  w.addSpacer(10);
  addDivider(w);
  w.addSpacer(8);

  // ---------- Footer: sunrise / sunset / AQI ----------
  const foot = w.addStack();
  foot.centerAlignContent();

  const sunrise = (daily.sunrise || [])[0];
  const sunset = (daily.sunset || [])[0];
  if (sunrise) {
    addSymbol(foot, "sunrise.fill", 13, COLORS.sun);
    foot.addSpacer(4);
    const sr = foot.addText(fmt(new Date(sunrise), "h:mm a"));
    sr.textColor = COLORS.text;
    sr.font = Font.systemFont(11);
    foot.addSpacer(12);
  }
  if (sunset) {
    addSymbol(foot, "sunset.fill", 13, COLORS.storm);
    foot.addSpacer(4);
    const ss = foot.addText(fmt(new Date(sunset), "h:mm a"));
    ss.textColor = COLORS.text;
    ss.font = Font.systemFont(11);
  }

  foot.addSpacer();

  const aqiVal = air && air.current ? air.current.us_aqi : null;
  const info = aqiInfo(aqiVal);
  addSymbol(foot, "aqi.medium", 13, info.color);
  foot.addSpacer(4);
  const aqiText = foot.addText(aqiVal == null ? "AQI —" : `AQI ${r(aqiVal)} · ${info.label}`);
  aqiText.textColor = info.color;
  aqiText.font = Font.semiboldSystemFont(11);
  aqiText.lineLimit = 1;

  w.addSpacer();
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
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
