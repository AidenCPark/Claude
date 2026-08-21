// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: cube;

// ============================================================
// Minecraft Realm — Who's Online  (Java Edition, small widget)
// ------------------------------------------------------------
// Shows how many players are currently on your Java Realm and
// who they are (with their skin heads).
//
// SETUP: run Minecraft_Auth_Setup.js once, in the Scriptable app.
// It writes "minecraft_refreshtoken" to the Keychain.
//
// This does NOT use the xbox_* credentials: that Azure app isn't
// approved by Microsoft for the Minecraft API and returns
// "403 invalid app registration" at the Minecraft token step. The
// setup script signs in with a public client ID that is approved
// (see its comments), stored under its own Keychain key — so the
// Xbox widgets are unaffected, and this widget keeps working even
// if the Xbox token needs re-authenticating.
//
// Auth chain: Microsoft OAuth -> Xbox Live -> XSTS (relying
// party rp://api.minecraftservices.com/) -> Minecraft services
// token -> Realms API cookie.
//
// NOTE: the Realms API is an unofficial/private Mojang API. It
// works (community tools rely on it) but isn't supported and can
// change. Presence data comes via the Xbox network, so it can lag
// the live server by a little.
//
// Add a Scriptable widget, long-press -> "Edit Widget", pick
// this script, and choose the Small size.
// ============================================================

// Leave blank to auto-detect the latest Minecraft release (the
// Realms API rejects outdated client versions). Set e.g. "1.21.4"
// to pin a specific version.
const GAME_VERSION = "";
// Leave blank to use your first Realm; set a name to pick one.
const REALM_NAME = "";
// How many online players to list.
const MAX_SHOWN = 3;
// Fallback version if the manifest can't be reached.
const FALLBACK_VERSION = "1.21.4";

// ------------------------------------------------------------
// Endpoints
// ------------------------------------------------------------
// Public client ID approved for Minecraft (see Minecraft_Auth_Setup.js).
const MC_CLIENT_ID = "389b1b32-b5d5-43b2-bddc-84ce938d6737";
const MC_SCOPE = "XboxLive.signin offline_access";
const URL_MS_TOKEN = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const URL_XBL_AUTH = "https://user.auth.xboxlive.com/user/authenticate";
const URL_XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";
const URL_MC_LOGIN = "https://api.minecraftservices.com/authentication/login_with_xbox";
const URL_MC_PROFILE = "https://api.minecraftservices.com/minecraft/profile";
const URL_VERSIONS = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const REALMS_BASE = "https://pc.realms.minecraft.net";
const AVATAR_BASE = "https://crafatar.com/avatars";

// XSTS relying party for Minecraft services (Xbox widgets use
// http://xboxlive.com; Minecraft needs this one instead).
const MC_RELYING_PARTY = "rp://api.minecraftservices.com/";

// ------------------------------------------------------------
// Colors / theme  (grass green)
// ------------------------------------------------------------
const COLORS = {
  bg1: new Color("#141f0d"),
  bg2: new Color("#25381b"),
  text: new Color("#ffffff"),
  dim: new Color("#a9bfa0"),
  faint: new Color("#7d9174"),
  green: new Color("#6fdc4a"),
  offline: new Color("#8d9a88"),
};

// Auth state.
let MC_TOKEN = null, MC_UUID = null, MC_NAME = null, GAME_VER = null;

// ============================================================
// Authentication
// ============================================================
// Trim a response body down to something displayable in a widget.
function snippet(text, n) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// Run a request and return { status, text, json } so failures can report
// what the server actually said instead of being guessed at.
async function send(req) {
  const text = await req.loadString();
  const status = req.response ? req.response.statusCode : 0;
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status, text, json };
}

async function authenticate() {
  if (!Keychain.contains("minecraft_refreshtoken")) throw new Error("NO_SETUP");
  const refreshToken = Keychain.get("minecraft_refreshtoken");

  // 1) Microsoft access token from the refresh token. Public client, so
  // there's no client secret — the client_id goes in the body.
  const msReq = new Request(URL_MS_TOKEN);
  msReq.method = "POST";
  msReq.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  msReq.body = "grant_type=refresh_token" +
    "&client_id=" + encodeURIComponent(MC_CLIENT_ID) +
    "&scope=" + encodeURIComponent(MC_SCOPE) +
    "&refresh_token=" + encodeURIComponent(refreshToken);
  const msRes = await send(msReq);
  const ms = msRes.json || {};
  if (ms.refresh_token) Keychain.set("minecraft_refreshtoken", ms.refresh_token); // rotation
  if (!ms.access_token) throw new Error(`MSAUTH ${msRes.status}: ${snippet(msRes.text, 100)}`);

  // 2) Xbox Live user token.
  const xblReq = new Request(URL_XBL_AUTH);
  xblReq.method = "POST";
  xblReq.headers = { "Content-Type": "application/json" };
  xblReq.body = JSON.stringify({
    Properties: { AuthMethod: "RPS", RpsTicket: "d=" + ms.access_token, SiteName: "user.auth.xboxlive.com" },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  const xbl = await xblReq.loadJSON();

  // 3) XSTS token for Minecraft services (not xboxlive.com).
  const xstsReq = new Request(URL_XSTS);
  xstsReq.method = "POST";
  xstsReq.headers = { "Content-Type": "application/json" };
  xstsReq.body = JSON.stringify({
    Properties: { SandboxId: "RETAIL", UserTokens: [xbl.Token] },
    RelyingParty: MC_RELYING_PARTY,
    TokenType: "JWT",
  });
  const xstsRes = await send(xstsReq);
  const xsts = xstsRes.json || {};
  if (!xsts.Token) {
    // XErr codes are very diagnostic (e.g. 2148916233 = no Xbox account).
    const xerr = xsts.XErr != null ? ` XErr ${xsts.XErr}` : "";
    throw new Error(`XSTS ${xstsRes.status}${xerr}: ${snippet(xstsRes.text, 90)}`);
  }
  const uhs = xsts.DisplayClaims.xui[0].uhs;

  // 4) Trade the XSTS token for a Minecraft services token. A failure here
  // usually means the Azure app isn't authorised for Minecraft services —
  // NOT that the account lacks Java Edition, so report what came back.
  const mcReq = new Request(URL_MC_LOGIN);
  mcReq.method = "POST";
  mcReq.headers = { "Content-Type": "application/json", "Accept": "application/json" };
  mcReq.body = JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` });
  const mcRes = await send(mcReq);
  console.log(`login_with_xbox -> ${mcRes.status}: ${mcRes.text}`);
  if (!mcRes.json || !mcRes.json.access_token) {
    throw new Error(`MCLOGIN ${mcRes.status}: ${snippet(mcRes.text, 110)}`);
  }
  MC_TOKEN = mcRes.json.access_token;

  // 5) Profile gives the UUID + username the Realms cookie needs. A 404 here
  // genuinely does mean no Java Edition owned by this account.
  const pReq = new Request(URL_MC_PROFILE);
  pReq.headers = { "Authorization": "Bearer " + MC_TOKEN };
  const pRes = await send(pReq);
  console.log(`profile -> ${pRes.status}: ${pRes.text}`);
  if (pRes.status === 404) throw new Error("NO_JAVA");
  if (!pRes.json || !pRes.json.id) {
    throw new Error(`PROFILE ${pRes.status}: ${snippet(pRes.text, 110)}`);
  }
  MC_UUID = pRes.json.id;   // undashed
  MC_NAME = pRes.json.name;
}

// ============================================================
// Realms API
// ============================================================
// The Realms API refuses outdated client versions, so use the current
// release (cached for a day) unless a version is pinned above.
async function resolveVersion() {
  if (GAME_VERSION) return GAME_VERSION;
  const fm = FileManager.local();
  const path = fm.joinPath(fm.cacheDirectory(), "mc_version.json");
  try {
    if (fm.fileExists(path)) {
      const c = JSON.parse(fm.readString(path));
      if (c.v && c.ts && Date.now() - c.ts < 24 * 60 * 60 * 1000) return c.v;
    }
  } catch (e) {}
  try {
    const req = new Request(URL_VERSIONS);
    req.timeoutInterval = 15;
    const j = await req.loadJSON();
    const v = j && j.latest && j.latest.release ? j.latest.release : null;
    if (v) {
      try { fm.writeString(path, JSON.stringify({ v, ts: Date.now() })); } catch (e) {}
      return v;
    }
  } catch (e) {}
  return FALLBACK_VERSION;
}

async function realmsGet(path) {
  const req = new Request(REALMS_BASE + path);
  req.headers = {
    "Cookie": `sid=token:${MC_TOKEN}:${MC_UUID};user=${MC_NAME};version=${GAME_VER}`,
    "Is-Prerelease": "false",
    "Content-Type": "application/json",
  };
  req.timeoutInterval = 20;
  const body = await req.loadString();
  const status = req.response ? req.response.statusCode : 0;
  if (status === 403) throw new Error("FORBIDDEN"); // outdated version or no Realms access
  if (status >= 400) throw new Error("HTTP_" + status);
  try { return JSON.parse(body); } catch (e) { throw new Error("BAD_JSON"); }
}

// Returns { name, state, online:[{name,uuid}], memberCount, maxPlayers }.
async function getRealmStatus() {
  GAME_VER = await resolveVersion();

  const list = await realmsGet("/worlds");
  const servers = (list && list.servers) || [];
  if (servers.length === 0) throw new Error("NO_REALMS");

  let realm = servers[0];
  if (REALM_NAME) {
    const match = servers.find(s => (s.name || "").toLowerCase() === REALM_NAME.toLowerCase());
    if (match) realm = match;
  } else {
    const open = servers.find(s => s.state === "OPEN");
    if (open) realm = open;
  }

  // The /worlds list leaves players empty — the per-realm endpoint has it.
  let players = [];
  try {
    const detail = await realmsGet(`/worlds/${realm.id}`);
    if (detail) {
      if (Array.isArray(detail.players)) players = detail.players;
      realm = Object.assign({}, realm, detail);
    }
  } catch (e) { /* fall back to whatever the list gave us */ }

  const online = players
    .filter(p => p && p.online)
    .map(p => ({ name: p.name || "Player", uuid: (p.uuid || "").replace(/-/g, "") }));

  return {
    name: realm.name || "Realm",
    state: realm.state || "",
    expired: !!realm.expired,
    online,
    memberCount: players.length,
    maxPlayers: realm.maxPlayers || 0,
  };
}

// ============================================================
// Avatars + disk cache
// ============================================================
async function loadAvatar(uuid) {
  if (!uuid) return null;
  const fm = FileManager.local();
  const dir = fm.joinPath(fm.cacheDirectory(), "mc_avatars");
  if (!fm.fileExists(dir)) fm.createDirectory(dir, true);
  const path = fm.joinPath(dir, `${uuid}.png`);
  if (fm.fileExists(path)) return fm.readImage(path);
  try {
    const img = await new Request(`${AVATAR_BASE}/${uuid}?size=32&overlay`).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch (e) {
    return null;
  }
}

function cachePath() {
  const fm = FileManager.local();
  return { fm, path: fm.joinPath(fm.cacheDirectory(), "mc_realm_data.json") };
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
// Build widget
// ============================================================
async function buildWidget() {
  const w = new ListWidget();
  const grad = new LinearGradient();
  grad.colors = [COLORS.bg1, COLORS.bg2];
  grad.locations = [0, 1];
  w.backgroundGradient = grad;
  w.setPadding(10, 11, 10, 11);

  let data = null, failure = null;
  try {
    await authenticate();
    data = await getRealmStatus();
    saveCache(data);
  } catch (e) {
    failure = String(e && e.message ? e.message : e);
    data = loadCache(); // show last known state if we have one
  }

  if (!data) {
    const title = w.addText("Realm");
    title.textColor = COLORS.text;
    title.font = Font.boldSystemFont(12);
    w.addSpacer(4);
    const msg = w.addText(failureText(failure));
    msg.textColor = COLORS.dim;
    msg.font = Font.systemFont(8.5);
    msg.lineLimit = 0;
    msg.minimumScaleFactor = 0.7;
    return w;
  }

  // ---- Realm name ----
  const head = w.addStack();
  head.centerAlignContent();
  const name = head.addText(data.name);
  name.textColor = COLORS.text;
  name.font = Font.boldSystemFont(12);
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.7;

  w.addSpacer(3);

  // ---- Online count ----
  const countRow = w.addStack();
  countRow.centerAlignContent();
  const n = data.online.length;
  const cnt = countRow.addText(String(n));
  cnt.textColor = n > 0 ? COLORS.green : COLORS.offline;
  cnt.font = Font.boldSystemFont(26);
  countRow.addSpacer(4);
  const lbl = countRow.addText(n === 1 ? "online" : "online");
  lbl.textColor = COLORS.dim;
  lbl.font = Font.systemFont(10);
  countRow.addSpacer();

  w.addSpacer(5);

  // ---- Player list ----
  if (n === 0) {
    const none = w.addText(data.expired ? "Realm expired"
      : data.state === "CLOSED" ? "Realm closed" : "Nobody online");
    none.textColor = COLORS.faint;
    none.font = Font.systemFont(10);
  } else {
    const shown = data.online.slice(0, MAX_SHOWN);
    const avatars = [];
    for (const p of shown) avatars.push(await loadAvatar(p.uuid));

    for (let i = 0; i < shown.length; i++) {
      const row = w.addStack();
      row.centerAlignContent();
      if (avatars[i]) {
        const im = row.addImage(avatars[i]);
        im.imageSize = new Size(14, 14);
        im.cornerRadius = 3;
        row.addSpacer(5);
      }
      const t = row.addText(shown[i].name);
      t.textColor = COLORS.text;
      t.font = Font.systemFont(11);
      t.lineLimit = 1;
      t.minimumScaleFactor = 0.7;
      row.addSpacer();
      if (i < shown.length - 1) w.addSpacer(3);
    }

    if (n > shown.length) {
      w.addSpacer(2);
      const more = w.addText(`+${n - shown.length} more`);
      more.textColor = COLORS.faint;
      more.font = Font.systemFont(9);
    }
  }

  w.addSpacer();
  // Presence changes often, so refresh more eagerly than the other widgets.
  w.refreshAfterDate = new Date(Date.now() + 10 * 60 * 1000);
  return w;
}

function failureText(f) {
  if (f === "NO_JAVA") return "Minecraft says this account owns no Java Edition profile.";
  if (f === "NO_REALMS") return "No Realms found for this account.";
  if (f === "FORBIDDEN") return "Realms refused the request — game version may be outdated. Try setting GAME_VERSION.";
  if (f === "NO_SETUP") return "Run Minecraft Auth Setup once to sign in.";
  if (f === "AUTH") return "Microsoft sign-in failed. Re-run Minecraft Auth Setup.";
  if (f && /^MSAUTH/.test(f)) return "Sign-in expired. Re-run Minecraft Auth Setup.\n" + f;
  // Anything else is a real server response — show it so it can be diagnosed.
  if (f && /^(MCLOGIN|PROFILE|XSTS|HTTP_)/.test(f)) return f;
  return f || "No data yet. Check Keychain credentials and run once online.";
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
