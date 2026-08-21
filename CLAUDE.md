# Scriptable Widgets

A collection of iOS [Scriptable](https://scriptable.app) widgets (plain `.js`
files). Each file's first lines are Scriptable metadata comments — leave them
intact.

## Keep Xbox and RetroAchievements widgets in sync

These widgets come in **Xbox / RetroAchievements pairs**. When asked to change
one widget in a pair, **always make the equivalent change to its partner**, and
vice versa — even if the request only names one of them. Adapt the change to
each service's API/terminology where needed (e.g. Xbox "gamerscore" ↔ RA
"points"; Xbox "100% completion" ↔ RA "mastered").

| Purpose | Xbox | RetroAchievements |
|---|---|---|
| Main stats + recent achievements | `Xbox.js` | `RetroAchievements.js` |
| Per-day score heatmap (small) | `Xbox_Heatmap.js` | `RetroAchievements_Heatmap.js` |
| Completed/mastered games grid | `Xbox_CompletionGrid.js` | `RetroAchievements_MasteryGrid.js` |

Notes on the pairs:
- Xbox has no "beaten" tier, so its grid shows only 100% completions (gold);
  the RA grid shows mastered (gold) **and** beaten (silver).

Widgets without a pair: `CityDashboard.js` (weather/air-quality dashboard),
`BoxOffice.js` (current #1 box-office movie poster + total gross),
`BillboardHot100.js` (current #1 song cover art + artist + weeks on chart),
`MinecraftRealm.js` (who's online on a Java Realm).

Helper scripts (not widgets):
- `Xbox_Auth_Setup.js` — interactive sign-in that regenerates
  `xbox_refreshtoken`. Run it when the Xbox-based widgets report bad
  credentials (e.g. after a Microsoft password change, which revokes the old
  refresh token).
- `Minecraft_Auth_Setup.js` — device-code sign-in that writes
  `minecraft_refreshtoken`, used only by `MinecraftRealm.js`.

`MinecraftRealm.js` deliberately does **not** use the `xbox_*` credentials:
that Azure app isn't approved for the Minecraft API and returns
`403 invalid app registration` at the `login_with_xbox` step. Getting an own
app approved requires a Microsoft application form / Xbox Developer program,
so it instead signs in as Minecraft's own launcher client
(`00000000402b5328`) and keeps its token under a separate Keychain key. Its
XSTS token uses relying party `rp://api.minecraftservices.com/` rather than
`http://xboxlive.com`.

That sign-in must use the **legacy MSA flow** — `login.live.com` with scope
`service::user.auth.xboxlive.com::MBI_SSL`. The AAD v2.0 endpoint
(`login.microsoftonline.com/consumers`) with scope `XboxLive.signin` returns
400 for this client. The client ID and scope must match between
`Minecraft_Auth_Setup.js` and `MinecraftRealm.js`, since a refresh token is
only valid for the client that issued it.

## Testing

The remote environment can't reach the Xbox / RetroAchievements / weather APIs,
so widgets can't be run here — validate with `node --check <file>.js` for syntax
and rely on the user to verify rendering on-device.
