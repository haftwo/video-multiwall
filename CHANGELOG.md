# Changelog

The version is in `package.json`. The app shows it in the side panel, the account menu, the admin console header and the sign-in page. The server also reports it at `/api/version`, at `/healthz` and in the container log at start-up.

## 1.5.4 — 2026-11-18
- Admin console: the stream sources list is now the last section, so users, the sign-in log and single sign-on settings are visible without scrolling past every channel.

## 1.5.3 — 2026-11-18
- Removed the header waveform strip (1.5.0–1.5.2). The top bar is back to the logo, name and account menu.

## 1.5.2 — 2026-11-18
- The header strip is now a waveform-monitor trace of composite colour bars. Each line has a front porch, a horizontal sync dip below blanking, colour burst, then the seven bars as coloured chroma bands around their luminance. Every fourth line comes the vertical interval: equalising pulses, serrated vertical sync, equalising pulses. The trace scrolls slowly, and stays still when the system asks for reduced motion.

## 1.5.1 — 2026-11-18
- The header strip is now colour bars with sync. Each scan line steps down from white to yellow, cyan, green, magenta, red and blue, in those colours at their luminance levels. A horizontal sync pulse sits between lines, and every fourth line comes the vertical sync interval of equalising and serrated pulses, in amber.

## 1.5.0 — 2026-11-18
- Video waveform strip in the page header. Mirrored bars trace scan lines as a waveform monitor shows them: picture lines, a colour-bar staircase every third line, and the sync pulse between lines. A brighter sweep moves across it, and it stays still when the system asks for reduced motion.

## 1.4.0 — 2026-11-18
- Sign-in log in the admin console. It records every sign-in and failed attempt (password or Microsoft, with the reason) and every sign-out, with the IP address and browser. It has filters, search, paging and CSV export, plus 24-hour and 30-day counts. Entries are kept for `LOGIN_LOG_DAYS` days (default 90).

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
