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
// Minecraft launcher's public client ID + classic Xbox Live scope, matching
// the legacy MSA flow used by Minecraft_Auth_Setup.js. Must stay in sync with
// that script: the refresh token is only valid for the client that issued it.
const MC_CLIENT_ID = "00000000402b5328";
const MC_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const URL_MS_TOKEN = "https://login.live.com/oauth20_token.srf";
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

// Cache of the Microsoft access token, so we don't burn (and rotate) the
// refresh token on every widget run. Invalidated whenever Xbox rejects it,
// so a revoked/re-issued sign-in always recovers.
const TOKEN_CACHE_KEY = "minecraft_accesstoken_cache";
function readTokenCache() {
  try {
    return Keychain.contains(TOKEN_CACHE_KEY) ? JSON.parse(Keychain.get(TOKEN_CACHE_KEY)) : null;
  } catch (e) { return null; }
}
function writeTokenCache(o) {
  try { Keychain.set(TOKEN_CACHE_KEY, JSON.stringify(o)); } catch (e) {}
}
function clearTokenCache() {
  try { if (Keychain.contains(TOKEN_CACHE_KEY)) Keychain.remove(TOKEN_CACHE_KEY); } catch (e) {}
}

let LAST_XBL = null; // most recent Xbox Live rejection, for error reporting

// Try to exchange a Microsoft access token for an Xbox Live user token.
// Xbox needs the x-xbl-contract-version header, and which RpsTicket format
// it accepts depends on how the token was issued ("d=", "t=", or bare).
// Returns the token, or null if Xbox rejected every form.
async function tryXblToken(accessToken) {
  // "t=" is what the legacy MSA (MBI_SSL) token needs; the others are kept
  // as fallbacks in case the token source ever changes.
  const forms = [["t=", "t=" + accessToken], ["d=", "d=" + accessToken], ["bare", accessToken]];
  for (const [label, ticket] of forms) {
    const req = new Request(URL_XBL_AUTH);
    req.method = "POST";
    req.headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-xbl-contract-version": "1",
    };
    req.body = JSON.stringify({
      Properties: { AuthMethod: "RPS", RpsTicket: ticket, SiteName: "user.auth.xboxlive.com" },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    });
    const res = await send(req);
    // Log status only — the body carries a live Xbox token.
    console.log(`xbl [${label}] -> ${res.status}`);
    if (res.json && res.json.Token) return res.json.Token;
    LAST_XBL = res;
  }
  return null;
}

// A Microsoft access token is printable ASCII. loadString() has been seen
// mangling login.live.com's token response (the access_token came back with
// garbled multibyte characters), which yields a token Xbox rejects with a
// bare 401 — so validate before using one.
function looksLikeToken(t) {
  return typeof t === "string" && t.length > 20 && /^[\x21-\x7E]+$/.test(t);
}

// POST a form and read the reply as JSON. loadJSON() decodes the response
// bytes natively, avoiding the string-decoding corruption above; fall back
// to the text path only if it can't parse.
async function postForm(url, bodyStr) {
  const mk = () => {
    const r = new Request(url);
    r.method = "POST";
    r.headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    };
    r.body = bodyStr;
    r.timeoutInterval = 25;
    return r;
  };
  try {
    const r = mk();
    const json = await r.loadJSON();
    return { status: r.response ? r.response.statusCode : 0, json, text: "" };
  } catch (e) {
    return await send(mk());
  }
}

// Refresh the Microsoft access token. The scope parameter is required —
// omitting it returns 400 invalid_scope.
async function msRefresh() {
  const refreshToken = Keychain.get("minecraft_refreshtoken");
  const body = [
    "grant_type=refresh_token",
    "client_id=" + encodeURIComponent(MC_CLIENT_ID),
    "scope=" + encodeURIComponent(MC_SCOPE),
    "refresh_token=" + encodeURIComponent(refreshToken),
  ].join("&");
  const res = await postForm(URL_MS_TOKEN, body);
  const tok = res.json || {};
  console.log(`msa refresh -> ${res.status} (token ok=${looksLikeToken(tok.access_token)})`);
  // Refresh tokens rotate, so always keep the newest one.
  if (tok.refresh_token) Keychain.set("minecraft_refreshtoken", tok.refresh_token);
  if (!tok.access_token) throw new Error(`MSAUTH ${res.status}: ${snippet(res.text, 90)}`);
  if (!looksLikeToken(tok.access_token)) throw new Error("TOKEN_CORRUPT");
  return tok;
}

async function authenticate() {
  if (!Keychain.contains("minecraft_refreshtoken")) throw new Error("NO_SETUP");

  // 1+2) Get an Xbox Live token. Prefer the cached Microsoft access token;
  // if Xbox won't take it, drop it and refresh (trying both body forms).
  let xblToken = null;
  const cached = readTokenCache();
  if (cached && looksLikeToken(cached.token) && cached.exp > Date.now() + 60 * 1000) {
    xblToken = await tryXblToken(cached.token);
    if (!xblToken) clearTokenCache(); // stale/revoked — fall through to refresh
  }

  if (!xblToken) {
    const tok = await msRefresh();
    xblToken = await tryXblToken(tok.access_token);
    if (xblToken) {
      writeTokenCache({
        token: tok.access_token,
        exp: Date.now() + ((Number(tok.expires_in) || 3600) * 1000),
      });
    }
  }

  if (!xblToken) {
    const detail = snippet(LAST_XBL ? LAST_XBL.text : "", 80);
    throw new Error(`XBL ${LAST_XBL ? LAST_XBL.status : 0}${detail ? ": " + detail : " — token rejected"}`);
  }

  // 3) XSTS token for Minecraft services (not xboxlive.com).
  const xstsReq = new Request(URL_XSTS);
  xstsReq.method = "POST";
  xstsReq.headers = { "Content-Type": "application/json" };
  xstsReq.body = JSON.stringify({
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
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
  // Status only: the body contains a live Minecraft bearer token.
  console.log(`login_with_xbox -> ${mcRes.status}`);
  if (!mcRes.json || !mcRes.json.access_token) {
    throw new Error(`MCLOGIN ${mcRes.status}: ${snippet(mcRes.text, 110)}`);
  }
  MC_TOKEN = mcRes.json.access_token;

  // 5) Profile gives the UUID + username the Realms cookie needs. A 404 here
  // genuinely does mean no Java Edition owned by this account.
  const pReq = new Request(URL_MC_PROFILE);
  pReq.headers = { "Authorization": "Bearer " + MC_TOKEN };
  const pRes = await send(pReq);
  console.log(`profile -> ${pRes.status}` +
    (pRes.json && pRes.json.name ? ` (${pRes.json.name})` : ""));
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

function normUuid(u) {
  return String(u || "").replace(/-/g, "").toLowerCase();
}

// Parse /activities/liveplayerlist. Its shape is awkward: the per-realm entry
// carries playerList as a JSON-encoded STRING that has to be parsed again.
// Accept the plain-array variant too, in case the shape differs.
function parseLivePlayers(resp, realmId, names) {
  const out = [];
  const lists = (resp && (resp.lists || resp.servers)) || [];
  for (const entry of lists) {
    if (!entry) continue;
    const id = entry.serverId != null ? entry.serverId : entry.id;
    if (id != null && String(id) !== String(realmId)) continue;
    let pl = entry.playerList != null ? entry.playerList : entry.players;
    if (typeof pl === "string") {
      try { pl = JSON.parse(pl); } catch (e) { pl = []; }
    }
    if (!Array.isArray(pl)) continue;
    for (const p of pl) {
      if (!p) continue;
      if (p.loggedIn === false || p.online === false) continue; // explicitly offline
      const uuid = normUuid(p.playerId || p.uuid || p.id);
      const name = p.name || names.get(uuid) || (uuid ? uuid.slice(0, 8) : "Player");
      out.push({ name, uuid });
    }
  }
  return out;
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

  // The per-realm endpoint carries the invited-member list. That's a roster,
  // not presence — and it excludes the realm owner — so it's used here only
  // to map UUIDs to display names.
  let players = [];
  try {
    const detail = await realmsGet(`/worlds/${realm.id}`);
    if (detail) {
      if (Array.isArray(detail.players)) players = detail.players;
      realm = Object.assign({}, realm, detail);
    }
  } catch (e) { /* fall back to whatever the list gave us */ }

  const names = new Map();
  for (const p of players) if (p && p.uuid) names.set(normUuid(p.uuid), p.name);
  if (realm.ownerUUID) names.set(normUuid(realm.ownerUUID), realm.owner || "Owner");

  // Who is actually in the world right now.
  let online = [];
  try {
    const live = await realmsGet("/activities/liveplayerlist");
    console.log("liveplayerlist: " + JSON.stringify(live).slice(0, 300));
    online = parseLivePlayers(live, realm.id, names);
  } catch (e) {
    console.log("liveplayerlist failed: " + (e && e.message ? e.message : e));
  }

  // Fall back to the roster's online flags if the live list gave nothing.
  if (online.length === 0) {
    online = players
      .filter(p => p && p.online)
      .map(p => ({ name: p.name || "Player", uuid: normUuid(p.uuid) }));
  }
  console.log(`online: ${online.length} (${online.map(p => p.name).join(", ")})`);

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
  try {
    const { fm, path } = cachePath();
    fm.writeString(path, JSON.stringify(Object.assign({}, data, { ts: Date.now() })));
  } catch (e) {}
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

  let data = null, failure = null, stale = false;
  try {
    await authenticate();
    data = await getRealmStatus();
    saveCache(data);
  } catch (e) {
    failure = String(e && e.message ? e.message : e);
    console.log("realm fetch failed: " + failure);
    // Only fall back to cached data if it's recent, and always flag it.
    // Otherwise a broken auth chain renders as "0 online", which looks
    // identical to an empty realm — reporting a failure as real data.
    const c = loadCache();
    if (c && c.ts && Date.now() - c.ts < 30 * 60 * 1000) { data = c; stale = true; }
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

  if (stale) {
    w.addSpacer(3);
    const df = new DateFormatter();
    df.dateFormat = "h:mm a";
    const st = w.addText(`⚠︎ can't refresh · ${df.string(new Date(data.ts))}`);
    st.textColor = new Color("#e8b64a");
    st.font = Font.systemFont(8);
    st.lineLimit = 1;
    st.minimumScaleFactor = 0.7;
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
  if (f === "TOKEN_CORRUPT") return "Microsoft returned an unreadable token. Re-run Minecraft Auth Setup.";
  if (f === "AUTH") return "Microsoft sign-in failed. Re-run Minecraft Auth Setup.";
  if (f && /^MSAUTH/.test(f)) return "Sign-in expired. Re-run Minecraft Auth Setup.\n" + f;
  // Anything else is a real server response — show it so it can be diagnosed.
  if (f && /^(MCLOGIN|PROFILE|XSTS|XBL|HTTP_)/.test(f)) return f;
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
