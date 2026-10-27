# Newsdesk — reporter upload & publishing portal

A phone-first web app for the Lokadarshan News and Belagavi Insider newsroom. Staff can install it on their home screen like an app.

1. **Cameramen** open *Upload*, then record a video, take a photo or pick from the gallery, adding a one-line note and the place. Uploads go up in 8 MB pieces. If the signal drops, the upload waits and continues by itself, and the screen stays awake until it finishes.
2. **The server** compresses each video to a 720p web version and takes **10 screenshots** from it. Camera originals are deleted after `ORIGINAL_RETENTION_DAYS` (7 by default); web versions are kept.
3. **Reporters** open the *Media library*, tag the right video for the story, and tap the best screenshot as the main photo. They can also pause the video and use that exact moment. They write or paste the **headline and script**; *Copy a ready-made prompt* builds a prompt for ChatGPT, Gemini or Claude from the cameraman's notes. Then they add the **Instagram caption, keywords and hashtags**.
4. **Translate to English** with one click (Claude), then review the result.
5. **Editors** review, then **publish**. For example, Lokadarshan gets the Kannada story with the main photo and video, and Belagavi Insider gets the English story with the main photo only. Each site can be set to send everything or only the main photo.
6. **Voiceover:** the reporter records the narration in the story (*● Record*) or uploads an audio file. The server converts it to `.m4a`, which Premiere, CapCut and similar editors open.
7. **Video desk:** the reporter taps *Send to video desk* for an Instagram Reel and/or a YouTube video. The **video editor** works on a PC: *Download everything (.zip)* gets the original camera video, voiceover, main photo, scripts, Instagram caption and hashtags, YouTube title, description and tags. After posting, the editor marks each job done with its link. Camera originals are kept until the editing is done (up to 30 days).
8. When the YouTube link is in, website posts embed the YouTube video instead of uploading the raw clip.
9. The story list shows every story's status on all four outlets: Instagram, YouTube, Lokadarshan and Belagavi Insider.

Roles: **cameraman** (upload only), **journalist**, **video_editor** (video desk and library), **editor** (also publishes), **admin** (also team, websites and storage).

**Install on a phone:** open the site in Chrome on Android, then tap ⋮ → *Add to Home screen* / *Install app*. On iPhone, open it in Safari, then tap Share → *Add to Home Screen*.

## Run it on your own computer (local copy)

**Windows:**
1. On GitHub, click **Code → Download ZIP**, then unzip it, for example to `C:\Newsdesk`.
2. Double-click **`start-windows.bat`**. On the first run it installs Node.js and ffmpeg (using *winget*) and asks you to double-click it once more. It then installs the app, starts it, and opens **http://localhost:3000** in your browser.
3. Sign in with `admin@newsdesk.local` / `changeme123` and change the password.
4. If Windows Firewall asks, click **Allow on private networks**, so phones on the office Wi-Fi can open the address shown in the black window (for example `http://192.168.1.20:3000`).

**Mac:** double-click **`start-mac.command`** (if macOS blocks it: right-click → Open). It needs Node.js 22+ from nodejs.org. ffmpeg is installed with Homebrew if available.

Keep the black window open while people use Newsdesk; closing it stops the app. Everything, including the database and uploaded videos, is stored in the `data` folder next to the start file, so back that folder up. For English translation, open the `.env` file in Notepad and paste your key after `ANTHROPIC_API_KEY=`, then restart.

Limitations of a local copy: only people on the same Wi-Fi can reach it, it stops when the computer is off or asleep, and phones cannot record voiceovers in the browser without https (reporters upload a recording from their voice recorder app instead). For field staff, use the server install below.

## Run it

Requires Node.js 22 or later and ffmpeg (`sudo apt install ffmpeg`).

```bash
npm install
cp .env.example .env        # then edit the values
node --env-file=.env src/server.js
```

Open http://localhost:3000 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. If these are not set, the defaults are `admin@newsdesk.local` / `changeme123`. Change the password straight away, then add reporters and editors under **Admin → Newsroom team**.

Run the tests with `npm test`.

## Connecting the websites (Admin → Websites & CRM connections)

Both sites start in **Test mode**. Publishing then writes the exact payload to `data/outbox/` and sends nothing, so you can try the full workflow safely.

| Connection | When to use | What you need |
|---|---|---|
| **WordPress** | The site runs on WordPress | Site URL; a WordPress user with Editor role; an *Application Password* (WP Admin → Users → Profile → Application Passwords). Files go to the Media Library. The first photo becomes the featured image. Video and audio are embedded. Documents are linked. Category and tags are created when missing. Tick *Send language* if the site uses Polylang or WPML. |
| **Custom CRM / API** | The site uses its own backend or CRM | The endpoint URL and API token. Newsdesk sends a `multipart/form-data` POST: a `story` field holding JSON (title, summary, body, language, category, tags, location, author, status, media list) plus the files as `file0`, `file1`, and so on. It sends `Authorization: Bearer <token>`, or the header you configure. If the response is JSON like `{ "id": ..., "url": ... }`, the link is shown on the story. |

Click **Save & test connection** to check the credentials before going live.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Enables *Translate to English* (get one at console.anthropic.com) |
| `TRANSLATION_MODEL` | Optional; defaults to `claude-opus-5-5` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First admin account, created on first start only |
| `PORT` | Defaults to 3000 |
| `MAX_UPLOAD_MB` | Per-file limit; defaults to 2048 |
| `ORIGINAL_RETENTION_DAYS` | Days to keep camera-original videos and photos (web versions are kept); defaults to 7 |
| `DATA_DIR` | Where the database and uploads live; defaults to `./data` |

## Deploying

On a fresh Ubuntu 22.04 or 24.04 server, first point a DNS record (for example `desk.lokadarshan.news`) to the server's IP address. Then run:

```bash
curl -fsSL https://raw.githubusercontent.com/desaijaylaxmi01-cyber/Lokadarshan-Content-Flow/main/deploy/install.sh -o install.sh
sudo bash install.sh desk.lokadarshan.news you@example.com
```

The script installs Node.js 22 and Nginx, gets a free HTTPS certificate, runs the portal as a service that restarts automatically, and prints the admin password. To install later updates from GitHub, run `sudo bash /opt/newsdesk/deploy/update.sh`.

- To deploy by hand instead, run it on any VPS or cloud VM with Node 22, behind Nginx with HTTPS. Set Nginx `client_max_body_size` to at least `MAX_UPLOAD_MB`.
- Back up the `data/` folder. It holds the SQLite database and every uploaded file.
- Use HTTPS in production so session cookies and the stored site credentials are protected in transit.

## Layout

```
src/server.js      HTTP API (auth, stories, uploads, translate, publish, admin)
src/publishers.js  Test mode / WordPress / custom-CRM connectors
src/media.js       Video compression, screenshots, cleanup of old originals (ffmpeg)
src/translate.js   Claude translation to English
src/db.js          SQLite schema and first-run seed
public/            Browser app (plain HTML/CSS/JS)
test/              Connector tests against a mock WordPress + CRM
```
