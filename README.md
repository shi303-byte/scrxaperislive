# Scrxaper

Connect freely. Belong anywhere.

This is **Phase 1 only**: accounts and one-to-one messaging. Everything else in the master prompt is not built yet.

## Status

| Area | State |
|---|---|
| Register, login, logout, DB-backed sessions (scrypt, HttpOnly cookie) | Implemented, tested |
| Direct messages by username, history, unread counts, real-time (SSE), block | Implemented, tested via API |
| Group chats: members, admin/member roles, add/remove, leave (admin hand-over), invite codes (7 days) | Implemented, tested via API |
| Scrxaper Teams official account: warnings, suspensions, restores, announcements; read-only (no replies) | Implemented, tested |
| Birthday card + message from Teams (UTC date, once per year, optional, private) | Implemented, tested |
| HTTP bots: token auth (`Authorization: Bot <token>`), HMAC-signed webhooks, https-only, private addresses blocked | Implemented, tested |
| Owner login from env vars, stats dashboard, user search, warn/suspend/restore, announce, audit log | Implemented, tested via API |
| Communities: channels (text, announcement, read-only, staff-only), roles owner/admin/moderator/member, invites, kick/ban/timeout, message delete, moderation log | Implemented, tested via API |
| Studio: theme (dark/light/system), accent colour, density, reduced motion, profile bio/status; Sparks ledger (daily check-in, owner adjustments), cosmetics shop with inventory/equip, early/staff badges | Implemented, tested via API |
| AI buddy: Groq via your own key, AES-256-GCM encrypted at rest, model check, conversations, safe Markdown, errors never faked | Implemented, tested against a **fake** provider only; not tried against real Groq |
| Avatar and banner uploads (content-sniffed PNG/JPEG/GIF/WebP, size and dimension limits, signed-in access only), account deletion with data cleanup | Implemented, tested via API with real image bytes |
| Search over people, groups, communities, channels and your own messages (membership-scoped, staff-only channels hidden); who-can-message, do-not-disturb, previews, per-conversation mute, desktop notifications while the tab is hidden | Implemented, tested via API |
| Landing banner and logo from the supplied artwork; responsive layout | Implemented. Landing, chat, sidebar, Studio and mobile list were screenshotted in a real browser and fixed; community, Buddy, Owner, Bots, shop and light-theme screens were not visually reviewed |
| Voice, calls, custom ringtone uploads, non-image attachments, image resizing/thumbnails, S3 storage, native Windows/macOS/Linux/Android/iOS packages, end-to-end encryption, per-channel permission overrides, avatar upload/animated profiles, voice, stages, calls, Studio, Sparks, AI buddy, uploads, E2EE | **Not started** |

Messages are **not end-to-end encrypted**. The owner dashboard shows aggregate counts and moderation tools, not message contents.

## Calls

Calls are peer to peer (WebRTC): the server only relays the setup messages, and the audio and video go directly between the two browsers, encrypted by WebRTC. You still have to trust the server not to tamper with the setup messages, and there is no safety-number check, so this is not a verified end-to-end guarantee. A public STUN server is used by default. On strict networks (some offices, mobile carriers) a direct connection cannot be made and **you need a TURN server**: set `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL` (and optionally `STUN_URL`). Those values are sent to signed-in users. Group calls, voice channels and stages are **not built**; they need a media server (an SFU), which does not fit on a plain web host. Screen sharing works in desktop browsers that support it. Calls need HTTPS (or localhost) for camera and microphone access.

## Python bot

`bots/scrxaper_bot.py` needs only Python 3. Create a bot under **Bots**, add it to a group, set its webhook to wherever the script runs (it must be https on a real server), then run it with `SCRXAPER_URL`, `BOT_TOKEN`, `WEBHOOK_SECRET` and `PORT`. Commands: `!help`, `!ping`, `!roll [sides]`, `!time`.

## Desktop and mobile

Scrxaper is an installable web app today: open it in Chrome, Edge or Safari and use Install / Add to Home Screen. It gets its own window and icon and loads its shell offline (messages still need a connection). Native packages (Tauri or Electron for desktop, Capacitor for Android and iOS) are **not built**; they need their own toolchains, signing certificates and store accounts. The icons are upscaled from a small source and should be redrawn from vector artwork before store submission.

## Encryption

Messages are protected in transit by TLS (set up by Railway) and are **not end-to-end encrypted**: the server can read them. Real E2EE needs a reviewed protocol (for example Signal's or MLS) from a maintained library, plus key verification, multi-device and backup design. It also conflicts with server-side search and moderation reports, which this app relies on. It was deliberately not improvised.

## Uploads

Files go to `UPLOAD_DIR` (default `./data/uploads`). On Railway set `UPLOAD_DIR=/data/uploads` on the same Volume as the database. Images are checked by their bytes (not extension or declared type), limited by size and pixel dimensions, stored under random ids, and served only to signed-in users. There is **no resizing or thumbnailing** and no S3 driver yet, so large avatars are served at full size. Reduce motion cannot pause animated GIFs.

## AI buddy

Set `AI_KEY_SECRET` (32+ random characters) to enable it; without it the buddy stays off. Changing the secret makes stored keys unreadable, so users re-enter them. Text sent to Groq: the chat messages, the personality and local time the user typed or has. Nothing else. `GROQ_BASE_URL` exists for testing.

## Owner account

Set `OWNER_USERNAME` and `OWNER_PASSWORD` (12+ characters). The owner is created or updated on every boot, so changing the variable rotates the password and moves ownership. Log in normally; an **Owner** button appears.

## Bots

Create a bot under **Bots**; the token and webhook secret are shown once. Add the bot to a group by username (admin only). Messages in that group, or DMs to the bot, are POSTed as JSON to your https webhook with `X-Scrxaper-Signature: sha256=<hmac of the raw body>`. A bot may only DM users who messaged it first. `ALLOW_PRIVATE_WEBHOOKS=1` permits http/private targets and is for local testing only.

## Deviations from the master prompt

The build sandbox had no network, so no packages could be installed. This base uses only Node 22 built-ins: `node:sqlite` instead of PostgreSQL, SSE instead of WebSockets, vanilla JS instead of Next.js. Moving to Postgres, Drizzle and Next is the first task of the next phase; the route and schema shapes carry over.

SQLite lives on one disk, so on Railway attach a **Volume** at `/data` and set `DB_PATH=/data/scrxaper.db`. Without it, a redeploy erases all data. Run a single instance.

## Run

    npm start        # http://localhost:3000, data in ./data
    npm test         # 59 tests, last run: all passing

Requires Node >= 22.5.

## Deploy to Render

1. Push this folder to a GitHub repository.
2. In Render choose **New > Blueprint** and select the repository. `render.yaml` creates one Docker web service with a 1 GB persistent disk at `/var/data`.
3. When asked, enter `OWNER_USERNAME` and `OWNER_PASSWORD` (12+ characters). `AI_KEY_SECRET` is generated for you; do not change it later or stored AI keys become unreadable.
4. After the first deploy, open the service URL, log in as the owner and check `/healthz`.

Things to know:
- **Use a paid instance.** Persistent disks are not available on Render's free plan, and the free plan sleeps when idle and loses its files, so every account and message would disappear. SQLite and uploads live on the disk.
- A service with a disk runs **one instance** only and restarts briefly on each deploy. Do not scale it horizontally.
- `TRUST_PROXY_HOPS=1` makes the login rate limit work per visitor instead of treating everyone as one address. Check it after deploying: the number must be right for Render's proxy chain, and I have not been able to confirm that against a live Render service.
- Back up `/var/data` with Render's disk snapshots.

## Deploy to Railway

1. Push to GitHub, create a Railway project from the repo (uses `Dockerfile` and `railway.json`).
2. Add a Volume mounted at `/data`.
3. Set `DB_PATH=/data/scrxaper.db`, `UPLOAD_DIR=/data/uploads`, `TRUST_PROXY_HOPS=1` and `NODE_ENV=production`. Railway supplies `PORT`.
4. Health check: `/healthz`. **Not yet deployed or verified on Railway.**

## Known limits

- Not built: voice channels, stages, group calls, message threads, reactions, custom ringtone uploads, native apps, end-to-end encryption.
- Communities use four fixed roles; custom roles and per-channel overrides are not built. Bots are not wired into community channels yet.

- Login rate limiting is in memory (resets on restart, per instance).
- Birthdays use the UTC date; 29 Feb birthdays only fire in leap years.
- Bot webhook delivery is fire-and-forget (no retries).
- Group/bot management uses browser prompts in places.
- No email, password reset, session list, edit/delete, typing, or presence yet.
- The landing banner and logo are cropped directly from the supplied brand artwork (`public/brand/`). Search uses SQL `LIKE`, limited to what you can access; there is no full-text index, and notifications work only while Scrxaper is open in a tab (no push).
