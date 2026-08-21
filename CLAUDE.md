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

Helper scripts (not widgets): `Xbox_Auth_Setup.js` — interactive sign-in that
regenerates `xbox_refreshtoken` in the Keychain. Run it when the Xbox-based
widgets report bad credentials (e.g. after a Microsoft password change, which
revokes the old refresh token).

`MinecraftRealm.js` reuses the same Xbox Keychain credentials, but takes its
XSTS token with relying party `rp://api.minecraftservices.com/` instead of
`http://xboxlive.com`, then trades it for a Minecraft services token.

## Testing

The remote environment can't reach the Xbox / RetroAchievements / weather APIs,
so widgets can't be run here — validate with `node --check <file>.js` for syntax
and rely on the user to verify rendering on-device.
