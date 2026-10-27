# Newsdesk — reporter upload & publishing portal

A web portal for the Lokadarshan News and Belagavi Insider newsroom.

1. **Reporters** sign in, write or paste the story script (Kannada, Marathi, Hindi, Urdu, Konkani or English), and upload photos, audio, video and data files (PDF, Excel, CSV and similar). Uploads support drag and drop, show progress and take files up to 2 GB each.
2. **Translate to English**: one click produces an English headline, summary and story with Claude. The translation can be edited before publishing.
3. **Submit for review**: an editor checks the story, then either returns it to the reporter with a note or publishes it.
4. **Publish**: pick the websites, choose the language for each one (for example, Lokadarshan in Kannada and Belagavi Insider in English), and choose whether to publish live or save as a draft. Text, photos, audio, video and documents all go to each site's backend.
5. Every publish attempt is logged on the story, with a link to the live post or the error message.

## Run it

Requires Node.js 22 or later.

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
| `DATA_DIR` | Where the database and uploads live; defaults to `./data` |

## Deploying

- Run it on any VPS or cloud VM with Node 22 (for example behind Nginx with HTTPS). Set Nginx `client_max_body_size` to at least `MAX_UPLOAD_MB`.
- Back up the `data/` folder. It holds the SQLite database and every uploaded file.
- Use HTTPS in production so session cookies and the stored site credentials are protected in transit.

## Layout

```
src/server.js      HTTP API (auth, stories, uploads, translate, publish, admin)
src/publishers.js  Test mode / WordPress / custom-CRM connectors
src/translate.js   Claude translation to English
src/db.js          SQLite schema and first-run seed
public/            Browser app (plain HTML/CSS/JS)
test/              Connector tests against a mock WordPress + CRM
```
