// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: right-to-bracket;

// ============================================================
// Minecraft Auth Setup — sign in for the Realm widget
// ------------------------------------------------------------
// Run this ONCE, inside the Scriptable app (not as a widget), to
// let MinecraftRealm.js talk to the Minecraft/Realms API. It
// writes "minecraft_refreshtoken" to the Keychain.
//
// WHY THIS EXISTS
// The Xbox widgets' own Azure app can reach Xbox Live but is not
// approved by Microsoft for the Minecraft API, so it returns
// "403 invalid app registration" at the Minecraft token step.
// Getting your own app approved needs a Microsoft application
// form / Xbox Developer program membership.
//
// So this signs in with Minecraft's own launcher client ID, which
// is inherently approved — the same approach launchers and
// libraries (prismarine-auth, gophertunnel, Minecraft Console
// Client) use. It's a public client identifier, not a secret:
// you authenticate your own Microsoft account to reach your own
// Minecraft data.
//
// It uses the legacy Microsoft Account DEVICE CODE flow, so there
// is no redirect URI to match: the script shows you a code, you
// enter it at microsoft.com/link, and it stores the token.
//
// This is kept entirely separate from the xbox_* Keychain keys,
// so the Xbox widgets are unaffected.
// ============================================================

// Minecraft launcher's public client ID + the classic Xbox Live scope.
// NOTE: this is the legacy MSA (login.live.com) flow, NOT the AAD
// v2.0 endpoint — that one rejects this client/scope with a 400.
const CLIENT_ID = "00000000402b5328";
const SCOPE = "service::user.auth.xboxlive.com::MBI_SSL";
const URL_DEVICE = "https://login.live.com/oauth20_connect.srf";
const URL_TOKEN = "https://login.live.com/oauth20_token.srf";

// How long to keep polling for you to finish signing in.
const MAX_WAIT_SECONDS = 300;

// Used to verify the token actually works, end to end, right after sign-in.
const URL_XBL_AUTH = "https://user.auth.xboxlive.com/user/authenticate";
const URL_XSTS = "https://xsts.auth.xboxlive.com/xsts/authorize";
const URL_MC_LOGIN = "https://api.minecraftservices.com/authentication/login_with_xbox";
const URL_MC_PROFILE = "https://api.minecraftservices.com/minecraft/profile";
const MC_RELYING_PARTY = "rp://api.minecraftservices.com/";

function sleep(ms) {
  return new Promise(resolve => {
    const t = new Timer();
    t.timeInterval = ms;
    t.schedule(() => resolve());
  });
}

async function toast(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.present();
}

async function form(url, params, extraHeaders) {
  const req = new Request(url);
  req.method = "POST";
  req.headers = Object.assign(
    { "Content-Type": "application/x-www-form-urlencoded" },
    extraHeaders || {}
  );
  req.body = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  req.timeoutInterval = 25;
  const text = await req.loadString();
  const status = req.response ? req.response.statusCode : 0;
  const headers = req.response ? (req.response.headers || {}) : {};
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status, text, json, headers };
}

// login.live.com hands back a cookie on the device-code call that it wants
// echoed back while polling.
function cookieFrom(headers) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === "set-cookie") {
      return String(headers[k]).split(";")[0];
    }
  }
  return null;
}

async function postJSON(url, body, extraHeaders) {
  const req = new Request(url);
  req.method = "POST";
  req.headers = Object.assign({
    "Content-Type": "application/json",
    "Accept": "application/json",
  }, extraHeaders || {});
  req.body = JSON.stringify(body);
  req.timeoutInterval = 25;
  const text = await req.loadString();
  const status = req.response ? req.response.statusCode : 0;
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status, text, json };
}

// Walk the whole chain with the freshly-issued access token and report where
// it breaks. This distinguishes "the sign-in token is no good" from "the
// widget's refreshed token is no good", which the widget alone can't tell.
async function verifyChain(accessToken) {
  const log = [];
  const note = line => { log.push(line); console.log(line); };

  // Xbox Live user token — try each documented RpsTicket format.
  let xblToken = null;
  for (const [label, ticket] of [["d=", "d=" + accessToken], ["t=", "t=" + accessToken], ["bare", accessToken]]) {
    const res = await postJSON(URL_XBL_AUTH, {
      Properties: { AuthMethod: "RPS", RpsTicket: ticket, SiteName: "user.auth.xboxlive.com" },
      RelyingParty: "http://auth.xboxlive.com",
      TokenType: "JWT",
    }, { "x-xbl-contract-version": "1" });
    note(`XBL [${label}] -> ${res.status}${res.status === 200 ? "" : " " + (res.text ? res.text.slice(0, 120) : "(empty body)")}`);
    if (res.json && res.json.Token) { xblToken = res.json.Token; note(`XBL [${label}] OK`); break; }
  }
  if (!xblToken) return { ok: false, step: "Xbox Live", log };

  // XSTS for Minecraft services.
  const xs = await postJSON(URL_XSTS, {
    Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
    RelyingParty: MC_RELYING_PARTY,
    TokenType: "JWT",
  });
  note(`XSTS -> ${xs.status}${xs.status === 200 ? "" : " " + (xs.text ? xs.text.slice(0, 120) : "(empty body)")}`);
  if (!xs.json || !xs.json.Token) return { ok: false, step: "XSTS", log };
  const uhs = xs.json.DisplayClaims.xui[0].uhs;

  // Minecraft services token.
  const mc = await postJSON(URL_MC_LOGIN, { identityToken: `XBL3.0 x=${uhs};${xs.json.Token}` });
  note(`login_with_xbox -> ${mc.status}${mc.status === 200 ? "" : " " + (mc.text ? mc.text.slice(0, 120) : "(empty body)")}`);
  if (!mc.json || !mc.json.access_token) return { ok: false, step: "Minecraft token", log };

  // Profile (proves Java Edition ownership).
  const pReq = new Request(URL_MC_PROFILE);
  pReq.headers = { "Authorization": "Bearer " + mc.json.access_token };
  const pText = await pReq.loadString();
  const pStatus = pReq.response ? pReq.response.statusCode : 0;
  const pName = (() => { try { return JSON.parse(pText).name; } catch (e) { return null; } })();
  note(`profile -> ${pStatus}${pStatus === 200 ? (pName ? ` (${pName})` : "") : " " + (pText ? pText.slice(0, 120) : "(empty body)")}`);
  if (pStatus !== 200) return { ok: false, step: "Minecraft profile", log };

  return { ok: true, step: "all", log };
}

async function main() {
  if (config.runsInWidget) return; // interactive setup only

  // 1) Ask Microsoft for a device code.
  const dev = await form(URL_DEVICE, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    response_type: "device_code",
  });
  if (!dev.json || !dev.json.device_code) {
    await toast("Couldn't start sign-in",
      `Microsoft said (${dev.status}):\n${dev.text.slice(0, 300)}`);
    return;
  }
  const { device_code, user_code } = dev.json;
  const verifyUrl = dev.json.verification_uri || dev.json.verification_url || "https://www.microsoft.com/link";
  const interval = (dev.json.interval || 5) * 1000;
  const cookie = cookieFrom(dev.headers);

  // 2) Show the code, put it on the clipboard, and open the sign-in page.
  Pasteboard.copyString(user_code);
  const a = new Alert();
  a.title = "Sign in to Microsoft";
  a.message = `Your code:\n\n${user_code}\n\n(Copied to the clipboard.)\n\n` +
    `Tap Continue to open ${verifyUrl}, paste the code, and sign in with the account that owns Minecraft.\n\n` +
    `When you're done, close the page to come back here.`;
  a.addAction("Continue");
  a.addCancelAction("Cancel");
  if (await a.present() === -1) return;

  await Safari.openInApp(verifyUrl, true);

  // 3) Poll for the token while you complete the sign-in.
  const pollHeaders = cookie ? { "Cookie": cookie } : {};
  const deadline = Date.now() + MAX_WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    const res = await form(`${URL_TOKEN}?client_id=${encodeURIComponent(CLIENT_ID)}`, {
      client_id: CLIENT_ID,
      device_code: device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }, pollHeaders);

    if (res.json && res.json.refresh_token) {
      Keychain.set("minecraft_refreshtoken", res.json.refresh_token);

      // Signed in — now prove the token actually reaches Minecraft.
      const v = await verifyChain(res.json.access_token);
      if (v.ok) {
        await toast("Success ✅",
          "Signed in and verified all the way to your Minecraft profile.\n\n" +
          "Open MinecraftRealm.js (or its widget) to see your Realm.");
      } else {
        await toast(`Signed in, but ${v.step} failed`,
          "The token was saved, but the chain broke at: " + v.step +
          "\n\n" + v.log.join("\n\n").slice(0, 700) +
          "\n\n(Full detail is in the console below.)");
      }
      return;
    }

    const err = res.json ? res.json.error : null;
    if (err === "authorization_pending") { await sleep(interval); continue; }
    if (err === "slow_down") { await sleep(interval + 5000); continue; }
    if (err === "authorization_declined") {
      await toast("Sign-in declined", "You cancelled the sign-in. Run the script again to retry.");
      return;
    }
    if (err === "expired_token" || err === "code_expired") {
      await toast("Code expired", "The code timed out. Run the script again for a new one.");
      return;
    }
    // Anything else is a real error worth showing.
    await toast("Sign-in failed",
      `Microsoft said (${res.status}):\n${res.text.slice(0, 300)}`);
    return;
  }

  await toast("Timed out",
    "Didn't finish signing in within the time limit. Run the script again to retry.");
}

await main();
Script.complete();
