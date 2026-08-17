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
// the "xbox_clientid" / "xbox_clientsecret" already there.
//
// IMPORTANT — the redirect URI must EXACTLY match one registered
// for your app. Find it here:
//   portal.azure.com (or entra.microsoft.com) -> App registrations
//   -> All applications -> the app whose Application (client) ID
//   matches your xbox_clientid -> Authentication -> Redirect URIs.
// The script lets you pick a common one or paste the exact value,
// and remembers your choice in the Keychain (xbox_redirecturi).
// ============================================================

const SCOPE = "Xboxlive.signin Xboxlive.offline_access";
const AUTHORIZE = "https://login.live.com/oauth20_authorize.srf";
const TOKEN = "https://login.live.com/oauth20_token.srf";

// Common redirect URIs to offer as quick picks.
const CANDIDATES = [
  "https://login.live.com/oauth20_desktop.srf",
  "https://login.microsoftonline.com/common/oauth2/nativeclient",
  "https://login.microsoftonline.com/consumers/oauth2/nativeclient",
];

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

// Let the user choose / enter the redirect URI (remembered in Keychain).
async function chooseRedirect() {
  const saved = kc("xbox_redirecturi");
  const a = new Alert();
  a.title = "Redirect URI";
  a.message = "Pick the redirect URI registered for your Xbox app, or enter it manually.\n\n" +
    "Find the exact value in the Azure app registration:\nApp registrations → your app → Authentication → Redirect URIs.";
  const actions = [];
  if (saved) { a.addAction(`Use saved: ${saved}`); actions.push(saved); }
  for (const c of CANDIDATES) { a.addAction(c); actions.push(c); }
  a.addAction("Enter manually…"); // last
  a.addCancelAction("Cancel");
  const idx = await a.present();
  if (idx === -1) return null;

  let chosen;
  if (idx < actions.length) {
    chosen = actions[idx];
  } else {
    const b = new Alert();
    b.title = "Enter redirect URI";
    b.message = "Paste the exact redirect URI registered for your app.";
    b.addTextField("https://…", saved || CANDIDATES[0]);
    b.addAction("Use this");
    b.addCancelAction("Cancel");
    const j = await b.present();
    if (j === -1) return null;
    chosen = (b.textFieldValue(0) || "").trim();
  }
  if (chosen) Keychain.set("xbox_redirecturi", chosen);
  return chosen;
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

  const REDIRECT = await chooseRedirect();
  if (!REDIRECT) return;

  await toast("Sign in to Xbox",
    "Next you'll sign in with your Microsoft account.\n\nAfter it finishes loading (the page may go blank), tap Done in the top-left to continue.\n\nUsing redirect URI:\n" + REDIRECT);

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
      oauthErr ? `Microsoft returned: ${oauthErr}` :
      "No authorization code was captured. If you saw an 'invalid redirect_uri' page, run the script again and choose a different redirect URI (the exact one from your app registration).");
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
      await toast("Token exchange failed", detail);
    }
  } catch (e) {
    await toast("Network error", String(e));
  }
}

await main();
Script.complete();
