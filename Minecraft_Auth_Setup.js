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
// So this signs in with a public client ID that is already
// approved for Minecraft — the same approach open-source tools
// (prismarine-auth, Prism Launcher, mineflayer) use. It is a
// public client identifier, not a secret: you authenticate your
// own Microsoft account to reach your own Minecraft data.
//
// It uses the OAuth DEVICE CODE flow, so there is no redirect URI
// to match: the script shows you a code, you enter it at
// microsoft.com/link, and it stores the resulting token.
//
// This is kept entirely separate from the xbox_* Keychain keys,
// so the Xbox widgets are unaffected.
// ============================================================

// Public client ID approved for Minecraft (prismarine-auth's app).
// Alternative, if this ever stops working: Minecraft's own launcher
// client ID "00000000402b5328", which uses the legacy login.live.com
// device endpoint (https://login.live.com/oauth20_connect.srf) instead.
const CLIENT_ID = "389b1b32-b5d5-43b2-bddc-84ce938d6737";
const SCOPE = "XboxLive.signin offline_access";
const URL_DEVICE = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const URL_TOKEN = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

// How long to keep polling for you to finish signing in.
const MAX_WAIT_SECONDS = 300;

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

async function form(url, params) {
  const req = new Request(url);
  req.method = "POST";
  req.headers = { "Content-Type": "application/x-www-form-urlencoded" };
  req.body = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  req.timeoutInterval = 25;
  const text = await req.loadString();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: req.response ? req.response.statusCode : 0, text, json };
}

async function main() {
  if (config.runsInWidget) return; // interactive setup only

  // 1) Ask Microsoft for a device code.
  const dev = await form(URL_DEVICE, { client_id: CLIENT_ID, scope: SCOPE });
  if (!dev.json || !dev.json.device_code) {
    await toast("Couldn't start sign-in",
      `Microsoft said (${dev.status}):\n${dev.text.slice(0, 300)}`);
    return;
  }
  const { device_code, user_code, verification_uri } = dev.json;
  const interval = (dev.json.interval || 5) * 1000;

  // 2) Show the code, put it on the clipboard, and open the sign-in page.
  Pasteboard.copyString(user_code);
  const a = new Alert();
  a.title = "Sign in to Microsoft";
  a.message = `Your code:\n\n${user_code}\n\n(Copied to the clipboard.)\n\n` +
    `Tap Continue to open ${verification_uri}, paste the code, and sign in with the account that owns Minecraft.\n\n` +
    `When you're done, close the page to come back here.`;
  a.addAction("Continue");
  a.addCancelAction("Cancel");
  if (await a.present() === -1) return;

  await Safari.openInApp(verification_uri || "https://microsoft.com/link", true);

  // 3) Poll for the token while you complete the sign-in.
  const deadline = Date.now() + MAX_WAIT_SECONDS * 1000;
  let waited = 0;
  while (Date.now() < deadline) {
    const res = await form(URL_TOKEN, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: device_code,
    });

    if (res.json && res.json.refresh_token) {
      Keychain.set("minecraft_refreshtoken", res.json.refresh_token);
      await toast("Success ✅",
        "Signed in. The Minecraft Realm widget can now read your Realm.\n\n" +
        "Open MinecraftRealm.js (or its widget) to confirm.");
      return;
    }

    const err = res.json ? res.json.error : null;
    if (err === "authorization_pending") {
      await sleep(interval);
      waited += interval;
      continue;
    }
    if (err === "slow_down") {
      await sleep(interval + 5000);
      continue;
    }
    if (err === "authorization_declined") {
      await toast("Sign-in declined", "You cancelled the sign-in. Run the script again to retry.");
      return;
    }
    if (err === "expired_token") {
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
