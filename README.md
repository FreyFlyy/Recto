# Recto

![Version](https://img.shields.io/badge/version-v1.0.0-green.svg) [![License: AGPL v3](https://img.shields.io/badge/License-AGPLv3-red.svg)](https://www.gnu.org/licenses/agpl-3.0.html) ![Python](https://img.shields.io/badge/python-3.8%2B-blue?logo=python&logoColor=white) ![Linux](https://img.shields.io/badge/platform-Linux-FCC624?logo=linux&logoColor=black)

A free, open-source, self-hosted flashcard service with easy imports and a KISS design.

## Project goal

Commercial flashcard apps force a choice:

- **StudySmarter / Vaia**: a good study model (rate each card *bad / ok / good*, filter by rating) but closed, paywalled and cloud-only.
- **Anki**: open and powerful, but its spaced-repetition scheduler decides when you review each card, bad/ok cards keep coming back at intervals whether you want them or not (plus it can be hard to get used to).

Recto aims for the middle: **a free, open-source Vaia-style app, or Anki without the forced scheduler.**

- **You rate cards *bad / ok / good***. Ratings are stored, never used to schedule anything.
- **You decide what to review**: filter by rating, tag or subdeck, shuffle, skip.
- **Your data stays yours and open to export**: decks are plain CSV files on your disk, readable by any tool.
- **Self-hosted and device-independent**: run it on a laptop, a Raspberry Pi or a VPS and open it from any browser (phone included).

**Deliberately out of scope (KISS)**: spaced repetition, review statistics/history, cloze, `.apkg` import, multi-user accounts.

## Features

- **Deck tree**: folders are decks, CSV files are subdecks (nested folders allowed)
- **Bad / ok / good rating** with keyboard shortcuts, the rating of the current card always shown, and a per-deck distribution bar
- **Ratings are kept in the browser while you study** and pushed to the server in one request when you leave the study view (or press *Sync*): no request per rating, so a high-latency link stays fast
- **Filters**: subdeck, rating, tag; rating and tag are multi-select (a card matches if it has *any* ticked rating / *any* ticked tag); shuffle, skip, step back
- **Markdown cards**: GFM tables, `$inline$` and `$$block$$` equations, images, code blocks, lists, quotes. Study view always renders them
- **Card editor opens on the Markdown source**; one button (or `Ctrl+/`) switches to a rendered WYSIWYG editor and back; add and delete cards
- **Manage everything from the web UI**: create, rename, import CSV, export CSV, reset progress, delete (to a trash you can restore decks, cards and images from)
- **Anki-style CSV directives** (`#separator`, `#html`, `#tags column`), delimiter auto-detection
- **Dark mode, mobile-friendly layout**

## Repository structure

```
Recto/
├── server.py          # HTTP server + JSON API + CSV management (stdlib only)
├── static/
│   ├── index.html     # single-page UI shell
│   ├── app.js         # frontend logic (vanilla JS)
│   ├── style.css      # styles (light/dark)
│   ├── editor.js      # prebuilt bundle: Markdown editor + renderer (generated, do not edit)
│   ├── editor.css     # prebuilt editor styles (generated)
│   └── Logo.png       # app logo (can be changed)
├── editor-src/        # source of the bundle (Node only needed to rebuild it, see below)
├── data/          # your decks and ratings
│   ├── .auth                  # scrypt hash of the passphrase (created on first run)
│   ├── .ratings.json          # ratings, keyed by deck and card id
│   ├── .media/                # images uploaded from the editor (named by content hash)
│   ├── .trash/                # deleted decks, cards and unused images (restorable, auto-deleted after a week)
│   └── examples/    # a few examples, can delete
│       ├── Basics.csv
│       └── Verbs.csv
├── recto.service      # hardened systemd user unit (example, edit the paths)
├── .gitignore         # keeps passphrase hash, ratings, backups and TLS keys out of git
├── LICENSE            # AGPL-3.0
└── README.md          # this file
```

## Getting started (Linux)

Requirements: Python 3.8 or newer (developed and tested on 3.14; 3.8 is end-of-life, so prefer a recent, security-patched release: the stdlib `html.parser` used for sanitising has received several security fixes) and a web browser. Nothing to install with pip.

Release 1.0.0:

```bash
git clone --branch 1.0.0 https://github.com/FreyFlyy/Recto.git
cd Recto
# HTTPS is mandatory: create a self-signed certificate OUTSIDE the repository (once)
# (add your server's IP / DNS name to subjectAltName, otherwise phones and some browsers reject the certificate)
mkdir -p ~/.config/recto && openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Recto" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout ~/.config/recto/key.pem -out ~/.config/recto/cert.pem && chmod 600 ~/.config/recto/key.pem
# Start server manually for the first time (add --host <interface-ip> to reach it from other devices)
python3 server.py --cert ~/.config/recto/cert.pem --key ~/.config/recto/key.pem
```

Open <https://127.0.0.1:8787> (or the host and port you chose; the browser warns about the self-signed certificate: accept it once). On the first run the server prints a **one-time setup code** (in the terminal, or under systemd in the journal: `journalctl --user -u recto -n 20`): enter it in the browser together with the passphrase you choose.

Options (CLI flags win over environment variables):

| Flag          | Env var               | Default                     | Meaning                                     |
| ------------- | --------------------- | --------------------------- | ------------------------------------------- |
| `--data DIR`  | `RECTO_DATA`          | `data/` next to `server.py` | decks folder (`~` is expanded)              |
| `--host HOST` | `RECTO_HOST`          | `127.0.0.1`                 | interface to listen on                      |
| `--port PORT` | `RECTO_PORT`          | `8787`                      | port                                        |
| `--cert FILE` |                       |                             | TLS certificate (PEM), **required**         |
| `--key FILE`  |                       |                             | TLS private key (PEM), **required**         |
|               | `RECTO_ALLOWED_HOSTS` |                             | extra allowed `Host` names, comma-separated |
|               | `RECTO_HSTS`          |                             | set to `1` to send `Strict-Transport-Security` (it applies to the whole host name, every port) |

### Run in the background (systemd user service)

Copy `recto.service` to `~/.config/systemd/user/recto.service` and replace every `{...}` placeholder (`{RECTO_DIR}`, `{DATA_DIR}`, `{HOST}`, `{PORT}`, `{CERT}`, `{KEY}`) with absolute paths or values; the file is the single source of truth and its header explains each one.

```bash
mkdir -p {DATA_DIR} && chmod 700 {DATA_DIR}   # the unit refuses to start if the data folder does not exist
systemctl --user daemon-reload
systemctl --user enable --now recto
loginctl enable-linger "$USER"   # start at boot even without a login session
```

### Access from other devices

By default the server only listens on the local machine. Access is protected by a **passphrase** (set on first run). Still restrict the port at the network level for defence in depth.

| Goal                      | How                                                        |
| ------------------------- | ---------------------------------------------------------- |
| Localhost only            | `--host 127.0.0.1`                                         |
| Trusted LAN / open access | `--host 0.0.0.0`                                           |
| Specific interface only   | `--host <interface-ip>` (e.g. for tailscale = `100.x.y.z`) |

The server also checks every request:

- **Host header** (DNS-rebinding guard): accepts IP literals, `localhost`, single-label names (e.g. a MagicDNS short name), `*.local` and `*.ts.net`. Any other hostname must be listed in `RECTO_ALLOWED_HOSTS`.
- **POST**: must be `Content-Type: application/json`; if an `Origin` header is present its host must match `Host`. A reverse proxy must forward the original `Host` and reach Recto over HTTPS (TCP passthrough or re-encrypting); a plain-HTTP upstream is not supported.

## Deck format

Each CSV row is a card: `front,back[,tag1 tag2 ...]`.

```csv
#separator:{semicolon|comma|tab|space|pipe|colon}
#tags column:{3 or higher}
front,back,tags
...
```

Front and back are **Markdown** (quoted cells may contain newlines). Example:

```csv
#separator:semicolon
#tags column:3
front;back;tags
Hello;**Ciao**;greetings
Euler's identity;"$e^{i\pi}+1=0$";math
```

(tags column is 1-based; it must be 3 or higher, columns 1-2 are front/back)

- A first row whose first cell is exactly `front` or `question` (case-insensitive) is a header and is ignored; a real card with that exact front must not be the first row.
- Delimiter is auto-detected (`,` `;` tab) or set explicitly at the top of the file, by name or as a single character other than `"`. Any other `#separator` value is rejected. When Recto rewrites a file without a `#separator` line, it adds one with the detected delimiter.
- Files must be UTF-8 (invalid bytes are replaced on read, and the replacement is saved on the next edit).
- Leading lines starting with `#` are treated as directives/comments (as in Anki), so a first card whose front starts with `#` must come after a header row.
- Raw HTML in a card is never interpreted: it is shown as text. An Anki `#html:true` directive is ignored (and kept in the file).
- Images are referenced as `![](media/<hash>.png)` and live in `data/.media/`. **Export CSV does not include them**: a CSV opened elsewhere shows broken image links.

## Usage

| Action                | Key                         |
| --------------------- | --------------------------- |
| Flip card             | Space / Enter / click       |
| Rate (after flipping) | `1` bad · `2` ok · `3` good |
| Skip / previous       | → / ←                       |
| Edit card             | `E`                         |

The bar above the card shows the deck distribution (green good, yellow ok, red bad, grey unrated). Skipping a card does not rate it. The line under the card shows its current rating (and tags).

**Shuffle** restarts from the cards that match the filters *at that moment*: cards you rated out of the filter (e.g. filter *Bad*, card rated *Good*) do not come back. With nothing left it says so.

### Ratings and sync

Rating a card only changes the page's memory. The ratings reach the server in **one request** when you leave the study view (Back, another deck, logout, editing or deleting a card, any gear action) or when you press **Sync** (it shows how many ratings are waiting). The server **merges per card**: for each rating sent, the one with the most recent time wins (a tie goes to the incoming one), cards the client did not send keep their server rating, and the server answers with the ratings it kept so the page adopts them. Times in the future are clamped to the server's clock. Decks you did not rate are not sent, so they are never touched. A reset is remembered for 90 days: ratings made before the reset of their deck are ignored, so a stale tab cannot bring them back.

- If a push fails (offline, session expired) the ratings stay in memory, the home page shows a warning with *Sync now*, and a reconnect retries automatically. Reopening that deck shows your pending ratings, not the server's.
- A hidden tab (switching apps on a phone) pushes immediately; closing the tab with ratings pending asks for confirmation. Pending ratings live in memory only: if the browser kills the page before a push goes out, they are lost.
- Two devices studying the same deck: each card keeps its most recent rating, whichever device made it. This relies on the devices' clocks being roughly right.

On the home page, the gear on each row opens its menu:

- **New subdeck / Import CSV** (folders): import accepts several files at once (up to 10 MB each); names that already exist (as a deck or a folder), files without valid cards and files with duplicate cards are refused. The limit is on the JSON request, so the effective file size is slightly under 10 MB.
- **Export CSV** (decks): downloads the file as stored, directives included.
- **Rename**: renames the CSV (or folder), its `.bak` and the matching ratings.
- **Reset progress**: clears the ratings of a deck or of every subdeck in a folder; CSV files are untouched.
- **Delete**: moves the deck to `data/.trash/<timestamp>-<name>/` and clears its ratings (kept in the trash entry). Restore it from the **Trash** button in the home header.

### Trash

The **Trash** button in the home header lists what was deleted, newest first, each with a *Restore* button:

- **Decks and subdecks**: restored to their old location, recreating missing parent folders, with their ratings and `.bak`. If the name is taken now, the copy is called `<name> (restored)`.
- **Cards** (deleted from the study view): appended back to their deck with tags and rating. The deck must still exist; a card identical to one already there is refused.
- **Images**: an image that no card, `.csv.bak`, trashed deck or trashed card references is moved here by the hourly cleanup, once it is more than a day old (an image is uploaded before the card that uses it is saved). Restoring puts it back in `data/.media/`.

Entries are deleted for good a week after they were trashed, together with `*.csv.bak` copies and quarantined ratings older than a week (checked at startup and every hour). An image stays referenced, hence out of the trash, for as long as a `.csv.bak` or trashed deck that uses it exists.

The **+** button in the home header creates an empty top-level deck (a folder) from a name. To add cards, first create a subdeck (gear, *New subdeck*) or import a CSV.

### Editing notes

- The editor opens on the Markdown source (textareas). The **Rendered** button starts the WYSIWYG editor (toolbar, `/` menu, tables, equations, code blocks, image upload); **Raw** goes back. A field you did not touch in the rendered editor keeps its original text; one you did is re-serialised by the editor (e.g. table separator rows are normalised).
- Saving a card without changes writes nothing. Esc / Cancel with unsaved changes asks for confirmation.
- Underline, sub/superscript and colors do not exist in Markdown; use `$x_2$` / `$x^2$` for scripts.
- Equations are rendered as MathML (no fonts to ship, works under the CSP). Their look depends on the browser's maths font.
- Images: PNG, JPEG, GIF or WebP up to 5 MB; JPEG/PNG over 1.5 MB are scaled to 1600 px before upload. Only uploaded images display (the CSP blocks external ones). Images no card references are moved to the trash (see *Trash*).
- The file is copied to `<file>.csv.bak` before the first write and that copy is never overwritten, until the hourly cleanup deletes it after a week (the next edit then makes a new copy of the file as it is at that moment).
- The CSV is rewritten on save: directives and header are kept (a `#separator` line is added if missing), but quoting and line endings may change.
- A card's id is a hash of front + back, so editing a card moves its rating to the new id.
- Cards changed or removed by editing the CSV outside Recto leave their ratings behind in `.ratings.json` (harmless, never cleaned up).
- Tags can only be set when adding a card; editing a card leaves its tags unchanged.
- Two cards with identical front and back share one id (and one rating). Adding a card, editing one into such a duplicate, or importing a file that contains them is refused; files edited by hand outside Recto may still contain them (they share one id and one rating).
- A deck and a folder cannot share a name in the same location, because they would share an id.

## API

| Method | Endpoint           | Body / query                    | Description                                                          |
| ------ | ------------------ | ------------------------------- | -------------------------------------------------------------------- |
| GET    | `/api/tree`        |                                 | deck tree with rating counts                                         |
| GET    | `/api/cards`       | `?path=X`                       | `{cards, decks}` for a deck or folder (each card has `r`, `ts`); `decks` includes empty ones |
| POST   | `/api/sync`        | `{decks: {deck: {cardId: [r, ts]}}}` | per-card merge, latest `ts` wins (`r` is `bad`, `ok` or `good`); unknown cards are dropped; returns `{decks, skipped, updates}`, `updates` being `{deck: {cardId: [r, ts] or null}}` for the cards whose result differs from what was sent |
| GET    | `/api/trash`       |                                 | `{items}`: deleted decks, folders, cards and images, newest first (max 500) |
| GET    | `/api/trash/image` | `?id=<entry id>`                | thumbnail of a trashed image                                         |
| POST   | `/api/trash/restore` | `{id}`                        | restore a trash entry; returns its new `path`                        |
| POST   | `/api/card`        | `{deck, id, f, b}`              | edit a card (`f`, `b` are Markdown)                                  |
| POST   | `/api/card/add`    | `{deck, f, b, tags?}`           | append a card                                                        |
| POST   | `/api/media`       | `{data}`                        | upload an image (base64); returns `{path: "media/<hash>.<ext>"}`      |
| GET    | `/api/media/<name>`|                                 | serve an uploaded image                                              |
| POST   | `/api/card/delete` | `{deck, id}`                    | remove a card (it goes to the trash)                                 |
| POST   | `/api/reset`       | `{path}`                        | clear ratings of a deck or folder                                    |
| POST   | `/api/rename`      | `{path, name}`                  | rename a deck or folder                                              |
| POST   | `/api/deck/create` | `{parent, name, type}`          | `type` is `folder` or `deck` (a deck must be inside a folder; folders nest up to 8 levels) |
| POST   | `/api/deck/delete` | `{path}`                        | move to `data/.trash/`                                               |
| POST   | `/api/import`      | `{parent, name, content}`       | create a subdeck from CSV text                                       |
| GET    | `/api/export`      | `?path=X`                       | download a deck's CSV                                                |
| GET    | `/api/health`      |                                 | `{ok, auth, setup_needed}` (public); `version` is added only with a valid session |
| POST   | `/api/setup`       | `{code, passphrase, confirm}`   | first-run: `code` is the one-time code printed by the server; creates hash + session (public, only if no `.auth`) |
| POST   | `/api/login`       | `{passphrase}`                  | sets session cookie (public)                                         |
| POST   | `/api/logout`      |                                 | clears session cookie                                                |

## Security notes

- **Path traversal is rejected**; hidden files and folders (leading `.`) are ignored. Deck and folder names cannot contain control, bidi-override or line-separator characters.
- **Response headers** (on every response, parser-level errors included: malformed requests and unsupported methods get a JSON error, never the stdlib HTML page; `HEAD` is supported, `PUT`/`DELETE`/`PATCH`/`OPTIONS` answer 405): `nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`.
- **Content-Security-Policy**: same-origin resources only (images included), no inline scripts and no style attributes. `<style>` elements are allowed only with a nonce the server generates on every load of `index.html` (the code-block editor injects its stylesheet that way).
- **Cards are Markdown, rendered through a sanitising pipeline** (raw HTML is shown as text, never parsed). Uploaded images are accepted by magic bytes (PNG/JPEG/GIF/WebP, never SVG) and served `nosniff` from content-hash names.
- **Static files** are served gzip-compressed with an ETag (`no-cache`, so updates apply on the next load).
- **CSV cells are stored and exported verbatim**: a front/back starting with `=`, `+`, `-` or `@` is a live formula if the exported file is opened in Excel/LibreOffice. Only open exports from decks you trust.
- **A corrupt `.ratings.json` is moved aside** to `.ratings.corrupt-<timestamp>.json` instead of being overwritten; malformed entries inside a valid file are dropped on read.
- **Writes (decks and ratings) are atomic and fsynced** (file and directory); ratings are accepted only for cards that exist.
- **Login rate limiting**: at most 5 login/setup attempts per IP per minute, counted before the passphrase is checked so parallel requests cannot bypass it (further attempts get HTTP 429 with `Retry-After`). A successful login resets the counter. IPv6 clients are grouped by /64. Behind a reverse proxy all clients share the proxy's address. Failed logins are written to stderr (`journalctl --user -u recto`).
- **First-run takeover protection**: while no passphrase exists, setup requires a random one-time code printed on the server console, so a stranger who reaches the port first cannot claim the instance. If `.auth` exists but is unreadable, the server refuses logins instead of reopening setup.
- **Passphrase authentication (web UI only)**: on first visit the browser asks for a passphrase (with confirmation). Only a scrypt hash (N=2^16, r=8, p=2) is stored in `data/.auth` (mode 600 from creation). Every new browser session requires the passphrase again; sessions live in memory (with expiry matching the cookie Max-Age of 24 h) and vanish on server restart. There is no direct web access recovery if the passphrase is lost, direct machine access is needed.
- **Known limits**: one user per instance, no spaced repetition, ratings merge per card by timestamp, so a device with a wrong clock can overwrite the others. Cookie is `HttpOnly; SameSite=Strict; Secure` with the `__Host-` prefix (the browser refuses it unless it is Secure and path-wide), because HTTPS is mandatory.
- **Slow or idle clients**: the TLS handshake runs per connection in its own thread under a 30 s timeout, so a silent TCP connection cannot stall the server. At most 64 connections are served at once, at most 16 per client address (IPv6: per /64), so one host cannot fill every slot (extra ones are dropped) and no connection lives longer than 5 minutes, so a client trickling bytes cannot hold a slot forever; concurrent scrypt hashes are capped at 2 to bound memory.
- **File permissions**: the server sets `umask 077`, so decks, backups and the trash are created readable only by its user. Files that already exist keep their mode.
- **`.auth` lives in the data folder**: if you sync or share that folder (Syncthing, Nextcloud...), exclude `.auth` and `.ratings.json`, or the passphrase hash leaves the machine.
- **HTTPS (required)**: TLS 1.2 or newer; the server refuses to start without `--cert` and `--key`, so the passphrase and the session cookie never travel in cleartext. A self-signed certificate is fine when only you access the instance (the browser warns once per device); on Tailscale, `tailscale cert <machine>.<tailnet>.ts.net` gives a trusted one. Keep the private key outside the repository (see *Getting started*). Recto always speaks TLS itself: a proxy that terminates TLS and forwards plain HTTP cannot be used.

## Roadmap

Tests; swipe gestures on mobile; export with images (zip).

## Rebuilding the editor bundle

`static/editor.js` and `static/editor.css` are generated from `editor-src/` (Milkdown/Crepe editor, remark/rehype renderer, KaTeX, CodeMirror) and committed, so running Recto needs no Node. To change them:

```bash
cd editor-src && npm ci && npm run build
```

Third-party licence notices are written to `static/editor.js.LEGAL.txt`.

## Author

**Francesco Scolz**

* [LinkedIn](https://www.linkedin.com/in/francesco-scolz)
* [GitHub](https://github.com/FreyFlyy)
* [Hugging Face](https://huggingface.co/FreyFlyy)

## License

This project is licensed under the **[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html)**.

You may use, modify and distribute this software under the same license.
If you modify it and let users interact with it over a network, you must offer them the corresponding source code (AGPL section 13).
