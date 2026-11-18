# MultiWall

A self-hosted multi-wall for HLS (`.m3u8`) streams. Viewers sign in, pick from the channels an admin has set up, and build their own wall of live panels.

- **Wall**: add and remove panels, per-panel mute and volume, drag to rearrange, fullscreen a panel or the whole wall. Each user's wall is saved and restored on their next visit.
- **Side panel** (collapsible, remembered per browser): volume and mute for the panel you are listening to, grid +/− to add or remove panels, numbered audio buttons to pick which panel you hear, a share link, and an Options menu (mute all, fullscreen wall, remove all, shortcuts).
- **Share links**: the share button makes a link holding the wall's channels, their order and which panel has sound. Anyone with an account on the same server who opens it gets that wall (after signing in, if they need to).
- **Channels**: preset by an admin in the admin console (add one at a time or paste an M3U playlist). Viewers can only choose from that list.
- **Sign-in**: local username/password accounts, Microsoft Entra ID (Azure AD) single sign-on, or both.
- **Roles**: administrators manage channels and users; viewers only see the wall.
- **Packaging**: one small Docker image, one data folder, no external database.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `A` | Add a panel |
| `1`–`9` | Select a panel |
| `M` | Mute / unmute the selected panel |
| `S` | Solo: unmute the selected panel and mute the rest |
| `F` | Fullscreen the selected panel (double-click also works) |
| `W` | Fullscreen the whole wall |
| `B` | Show / hide the side panel |

Panels you can currently hear are marked with an amber strip along the bottom edge.

---

## Install on Unraid

There is no published image, so you build it once on the server. It takes about a minute.

### 1. Copy the project to the server

In the Unraid terminal:

```bash
git clone https://github.com/haftwo/video-multiwall.git /mnt/user/appdata/multiwall-src
```

(No `git`? Download the ZIP from the repo page and unzip it to that folder over SMB.)

### 2. Build the image and create the data folder

Open the Unraid terminal (the `>_` icon, top right) and run:

```bash
cd /mnt/user/appdata/multiwall-src
docker build -t multiwall:latest .

mkdir -p /mnt/user/appdata/multiwall
chown -R 99:100 /mnt/user/appdata/multiwall
```

The build needs internet access once, to download Node and the hls.js player.

### 3. Add the container

```bash
cp unraid/my-multiwall.xml /boot/config/plugins/dockerMan/templates-user/
```

Then in the Unraid web UI: **Docker → Add Container → Template → MultiWall** (under "User templates"). Set an admin password, leave the rest as-is for now, and click **Apply**.

If the template route complains that it cannot pull `multiwall:latest`, start the container from the terminal instead. It appears on the Docker tab like any other:

```bash
docker run -d --name multiwall --restart unless-stopped \
  -p 8080:8080 \
  -v /mnt/user/appdata/multiwall:/data \
  -e ADMIN_PASSWORD='choose-a-password' \
  multiwall:latest
```

Open `http://<unraid-ip>:8080` and sign in as `admin`. If you left the password blank, a generated one is printed in the container log (Docker tab → MultiWall icon → Logs).

### Prefer Docker Compose?

With the Compose Manager plugin (or any Docker host):

```bash
cp .env.example .env      # then edit .env
docker compose up -d --build
```

### Updating

Run `cd /mnt/user/appdata/multiwall-src && git pull`, then `docker build -t multiwall:latest .` again, then recreate the container: on the Docker tab click the MultiWall icon → **Edit** → **Apply** (or `docker rm -f multiwall` and repeat the `docker run` command). Your data lives in `/mnt/user/appdata/multiwall` and is untouched.

### Backup

Everything is in `/mnt/user/appdata/multiwall` (`multiwall.db` and `session.secret`). Back up that folder.

---

## Adding channels

Sign in as an admin, open the menu (top right) → **Admin console**.

- **Add channel**: name, HLS URL, optional category, logo and sort order. **Test stream** tries the URL from your browser so you can see whether it plays before saving.
- **Import M3U**: paste a playlist; names, `group-title` and `tvg-logo` are read from each `#EXTINF` line.
- Three public demo streams are added on first start so the wall is not empty. Delete them when you have your own.

### When a stream will not play: the relay

Browsers apply two rules to HLS that players like VLC do not:

1. The stream's server must send CORS headers allowing your site to read it.
2. A page served over `https://` cannot load a stream served over `http://`.

If a channel fails for either reason, edit it and tick **Relay through this server**. The container then fetches the stream and passes it to the browser from its own address. It also lets viewers watch sources that only the Unraid box can reach. The cost is that every viewer's video for that channel flows through your server, so leave it off for streams that play directly.

The relay is not an open proxy: it only serves signed URLs that came from an admin-entered playlist, and only to signed-in users.

---

## Microsoft sign-in (Entra ID / Azure AD)

Microsoft requires the redirect address to be `https://` (plain `http://` is only allowed for `localhost`), so put MultiWall behind a reverse proxy with a certificate first (Nginx Proxy Manager, SWAG, Traefik or a Cloudflare Tunnel all work; point it at `http://<unraid-ip>:8080`).

1. In the [Entra admin centre](https://entra.microsoft.com): **Applications → App registrations → New registration**.
   - Supported account types: *Accounts in this organizational directory only*.
   - Redirect URI: platform **Web**, value `https://wall.example.com/auth/microsoft/callback` (your address + `/auth/microsoft/callback`).
2. From the app's **Overview** page copy the **Application (client) ID** and **Directory (tenant) ID**.
3. **Certificates & secrets → New client secret**. Copy the secret **Value** (not the Secret ID). Note the expiry date; sign-in stops working when it lapses.
4. In the Unraid template set:

   | Variable | Value |
   | --- | --- |
   | `BASE_URL` | `https://wall.example.com` |
   | `ENTRA_TENANT_ID` | Directory (tenant) ID |
   | `ENTRA_CLIENT_ID` | Application (client) ID |
   | `ENTRA_CLIENT_SECRET` | the secret value |
   | `ENTRA_ADMIN_EMAILS` | your work email, so you are an admin when you sign in with Microsoft |

5. Apply. The sign-in page now shows **Sign in with Microsoft**. The admin console's *Single sign-on* section shows the exact redirect URI the server is using, which must match step 1 character for character.

No API permissions beyond the default sign-in scopes are needed, and the app does not read anything from Microsoft Graph.

**Who gets in.** By default (`ENTRA_AUTO_PROVISION=true`) anyone in your tenant can sign in and becomes a viewer. To restrict it, either limit the app in Entra (*Enterprise applications → your app → Properties → Assignment required*), or set `ENTRA_AUTO_PROVISION=false` and pre-approve people by email under **Admin console → Add user → Microsoft account**.

**Going SSO-only.** Once Microsoft sign-in works and at least one Microsoft user is an administrator, set `LOCAL_LOGIN_ENABLED=false` to hide the password form. Set it back to `true` if you ever lock yourself out.

---

## Settings reference

All settings are environment variables; see `.env.example` for the annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / generated | First admin account, created on first start only |
| `BASE_URL` | none | Public address; required (https) for Microsoft sign-in |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | none | Turn on Microsoft sign-in when all three are set |
| `ENTRA_AUTO_PROVISION` | `true` | Create Microsoft users automatically on first sign-in |
| `ENTRA_ADMIN_EMAILS` | none | Microsoft users who are always administrators |
| `ENTRA_ALLOWED_DOMAINS` | none | Restrict Microsoft sign-in to these email domains |
| `LOCAL_LOGIN_ENABLED` | `true` | Show the username/password form |
| `MAX_PANELS` | `16` | Panel limit per wall (1–36) |
| `APP_NAME` | `MultiWall` | Name shown in the UI |
| `SESSION_DAYS` | `7` | How long a sign-in lasts |
| `SEED_DEMO_CHANNELS` | `true` | Add demo streams on first start |
| `PORT` | `8080` | Port inside the container |

---

## How it is built

```
server/         Node.js server, built-in modules only (no npm dependencies)
  index.js      routes: pages, viewer API, admin API
  http.js       tiny router, JSON bodies, signed-cookie sessions, static files
  auth.js       local login, session checks, Microsoft callback
  entra.js      OpenID Connect code flow with PKCE and ID-token verification
  proxy.js      the signed HLS relay
  db.js         SQLite schema (users, channels, layouts) and password hashing
  config.js     environment variables
views/          login, wall and admin pages
public/         CSS and browser JavaScript (wall.js is the player logic)
Dockerfile      two-stage build; stage 1 downloads hls.js into the image
```

Notes for tinkering:

- Data is one SQLite file, via Node's built-in `node:sqlite`. Passwords are stored as salted scrypt hashes.
- Playback uses [hls.js](https://github.com/video-dev/hls.js) and falls back to the browser's native HLS support (Safari, iOS, recent Chrome). It asks for the rendition that fits the panel size, so a 4×4 wall does not pull sixteen full-HD streams.
- Browsers block autoplay with sound until you interact with the page, so after a reload any unmuted panel may come back muted. One click on its speaker restores it.
- To run without Docker: Node 22.13 or newer, `npm run vendor` (downloads hls.js), then `npm start`.
