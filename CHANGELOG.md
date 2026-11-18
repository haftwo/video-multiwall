# Changelog

The version is in `package.json`. The app shows it in the side panel, the account menu, the admin console header and the sign-in page. The server also reports it at `/api/version`, at `/healthz` and in the container log at start-up.

## 1.3.0 — 2026-11-18
- Version number shown in the app and reported by the server.

## 1.2.1 — 2026-11-18
- App scripts and styles are no longer cached by the browser, so updates apply without a hard refresh.

## 1.2.0 — 2026-11-18
- Renamed to MultiPlayer 2000, with a new logo, favicon and Unraid icon.
- Channel import accepts CSV (Name, HLS URL, Group, Status at capture, Browser playback) as well as M3U, from a file or pasted text. It previews what will be added and skips channels already on the list. Offline rows are imported switched off, and "Needs relay" rows with the relay on.

## 1.1.0 — 2026-11-18
- Collapsible side panel: volume and mute, grid +/−, audio selector, share link, Options menu.
- Share links that survive the sign-in page.

## 1.0.0 — 2026-11-18
- First release: HLS multi-wall, local and Microsoft Entra ID sign-in, admin console, per-user saved walls, signed HLS relay, Docker image and Unraid template.
