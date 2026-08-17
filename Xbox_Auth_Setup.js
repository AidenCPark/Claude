// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: green; icon-glyph: right-to-bracket;

// ============================================================
// Xbox Auth Setup — (re)generate the Keychain refresh token
// ------------------------------------------------------------
// Run this ONCE, inside the Scriptable app (not as a widget),
// whenever the Xbox widgets say "Check Keychain credentials" —
// e.g. after changing your Microsoft account password, which
// revokes the old refresh token.
//
// It signs you in to your Microsoft account in a web view and
// writes a fresh "xbox_refreshtoken" to the Keychain. It reuses
// the "xbox_clientid" / "xbox_clientsecret" that are already
// there (those don't change), so no other setup is needed.
//
// After it says "Success", open any Xbox widget to confirm.
// ============================================================

// Redirect URI your app was registered with. The classic Microsoft
// Account (login.live.com) desktop redirect is the default; only change
// this if your app registration used a different redirect URI.
const REDIRECT = "https://login.live.com/oauth20_desktop.srf";
const SCOPE = "Xboxlive.signin Xboxlive.offline_access";
const AUTHORIZE = "https://login.live.com/oauth20_authorize.srf";
const TOKEN = "https://login.live.com/oauth20_token.srf";

function kc(key) {
  return Keychain.contains(key) ? Keychain.get(key) : null;
}

async function toast(title, message) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  a.addAction("OK");
  await a.present();
}

function param(url, name) {
  const m = (url || "").match(new RegExp("[?&#]" + name + "=([^&]+)"));
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null;
}

async function main() {
  if (config.runsInWidget) return; // this is an interactive setup script

  const clientId = kc("xbox_clientid");
  const clientSecret = kc("xbox_clientsecret");
  if (!clientId || !clientSecret) {
    await toast("Missing credentials",
      "xbox_clientid and/or xbox_clientsecret are not in the Keychain. Those are needed to sign in and this script can't recreate them.");
    return;
  }

  await toast("Sign in to Xbox",
    "Next you'll sign in with your Microsoft account.\n\nAfter it finishes loading (the page may go blank), tap Done in the top-left to continue.");

  // 1) Authorization code via a web-view sign-in.
  const authUrl = `${AUTHORIZE}?client_id=${encodeURIComponent(clientId)}` +
    `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}` +
    `&scope=${encodeURIComponent(SCOPE)}&prompt=select_account`;

  const wv = new WebView();
  let code = null, oauthErr = null;
  wv.shouldAllowRequest = (req) => {
    const u = req.url || "";
    if (u.indexOf(REDIRECT) === 0) {
      code = param(u, "code");
      oauthErr = param(u, "error_description") || param(u, "error");
      return false; // stop navigating to the (blank) redirect page
    }
    return true;
  };
  await wv.loadURL(authUrl);
  await wv.present(true);

  if (!code) {
    await toast("Sign-in not completed",
      oauthErr ? `Microsoft returned: ${oauthErr}` : "No authorization code was captured. You can run the script again to retry.");
    return;
  }

  // 2) Exchange the code for tokens; save the refresh token.
  try {
    const req = new Request(TOKEN);
    req.method = "POST";
    req.headers = {
      "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    };
    req.body = `grant_type=authorization_code&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}`;
    const tok = await req.loadJSON();

    if (tok && tok.refresh_token) {
      Keychain.set("xbox_refreshtoken", tok.refresh_token);
      await toast("Success ✅",
        "A new refresh token was saved to the Keychain. Open any Xbox widget (or run one from the app) to confirm it's working.");
    } else {
      const detail = tok && (tok.error_description || tok.error) ? (tok.error_description || tok.error) : "No refresh_token was returned.";
      await toast("Token exchange failed", detail +
        "\n\nIf it mentions the redirect URI, your app was registered with a different one — tell me and I'll update REDIRECT.");
    }
  } catch (e) {
    await toast("Network error", String(e));
  }
}

await main();
Script.complete();
