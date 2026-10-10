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
- **Bad / ok / good rating** with keyboard shortcuts and a per-deck distribution bar
- **Filters**: subdeck, rating, tag; shuffle, skip, step back
- **WYSIWYG card editor** (bold, italic, underline, sub/superscript, lists); add and delete cards
- **Manage everything from the web UI**: create, rename, import CSV, export CSV, reset progress, delete (to a trash folder)
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
│   └── Logo.png       # app logo (can be changed)
├── data/          # your decks and ratings
│   ├── .auth                  # scrypt hash of the passphrase (created on first run)
│   ├── .ratings.json          # ratings, keyed by deck and card id
│   ├── .trash/                # deleted decks (auto-deleted after a week)
│   └── examples/    # a few examples, can delete
│       ├── Basics.csv
│       └── Verbs.csv
├── recto.service      # hardened systemd user unit (example, edit the paths)
├── .gitignore         # keeps passphrase hash, ratings, backups and TLS keys out of git
├── LICENSE            # AGPL-3.0
└── README.md          # this file
```

## Getting started (Linux)

Requirements: Python 3.8 or newer (developed and tested on 3.14; 3.8 is end-of-life, so prefer a recent version) and a web browser. Nothing to install with pip.

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
| `--data DIR`  | `RECTO_DATA`          | `data/` next to `server.py` | decks folder                                |
| `--host HOST` | `RECTO_HOST`          | `127.0.0.1`                 | interface to listen on                      |
| `--port PORT` | `RECTO_PORT`          | `8787`                      | port                                        |
| `--cert FILE` |                       |                             | TLS certificate (PEM), **required**         |
| `--key FILE`  |                       |                             | TLS private key (PEM), **required**         |
|               | `RECTO_ALLOWED_HOSTS` |                             | extra allowed `Host` names, comma-separated |

### Run in the background (systemd user service)

Copy `recto.service` to `~/.config/systemd/user/recto.service` and replace every `{...}` placeholder (`{RECTO_DIR}`, `{DATA_DIR}`, `{HOST}`, `{PORT}`, `{CERT}`, `{KEY}`) with absolute paths or values; the file is the single source of truth and its header explains each one.

```bash
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
- **POST**: must be `Content-Type: application/json`; if an `Origin` header is present its host must match `Host`. Behind a reverse proxy, forward the original `Host`.

## Deck format

Each CSV row is a card: `front,back[,tag1 tag2 ...]`.

```csv
#separator:{semicolon|comma|tab|space|pipe|colon}
#html:{true|false}
#tags column:{3 or higher}
front,back,tags
...
```

Example:

```csv
#separator:semicolon
#html:true
#tags column:3
front;back;tags
Hello;<b>Ciao</b>;greetings
Water;<b>Acqua</b>;nouns
```

(tags column is 1-based; it must be 3 or higher, columns 1-2 are front/back)

- A first row whose first cell is exactly `front` or `question` (case-insensitive) is a header and is ignored; a real card with that exact front must not be the first row.
- Delimiter is auto-detected (`,` `;` tab) or set explicitly at the top of the file, by name or as a single character other than `"`. Any other `#separator` value is rejected. When Recto rewrites a file without a `#separator` line, it adds one with the detected delimiter.
- Files must be UTF-8 (invalid bytes are replaced on read, and the replacement is saved on the next edit).
- Leading lines starting with `#` are treated as directives/comments (as in Anki), so a first card whose front starts with `#` must come after a header row.
- Quoted cells may contain newlines. In `#html:true` decks a raw newline is displayed as a space: use `<br>`.

## Usage

| Action                | Key                         |
| --------------------- | --------------------------- |
| Flip card             | Space / Enter / click       |
| Rate (after flipping) | `1` bad · `2` ok · `3` good |
| Skip / previous       | → / ←                       |
| Edit card             | `E`                         |

The bar above the card shows the deck distribution (green good, yellow ok, red bad, grey unrated). Skipping a card does not rate it.

On the home page, the gear on each row opens its menu:

- **New subdeck / Import CSV** (folders): import accepts several files at once (up to 10 MB each); names that already exist (as a deck or a folder), files without valid cards and files with duplicate cards are refused. The limit is on the JSON request, so the effective file size is slightly under 10 MB.
- **Export CSV** (decks): downloads the file as stored, directives included.
- **Rename**: renames the CSV (or folder), its `.bak` and the matching ratings.
- **Reset progress**: clears the ratings of a deck or of every subdeck in a folder; CSV files are untouched.
- **Delete**: moves the deck to `data/.trash/<timestamp>-<name>/` and clears its ratings. To restore, move it back by hand (ratings are not restored). Trash contents, `*.csv.bak` copies and quarantined ratings older than a week are deleted automatically (checked at startup and every hour).

The **+** button in the home header creates an empty top-level deck (a folder) from a name. To add cards, first create a subdeck (gear, *New subdeck*) or import a CSV.

### Editing notes

- Formatting is saved as HTML. Only `b i u sub sup ul ol li br` are allowed; everything else (images, colors, tables) is stripped, on the server too.
- A plain-text deck is converted to `#html:true` on its first edit, after confirmation. Existing text is escaped and ratings are migrated.
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
| GET    | `/api/cards`       | `?path=X`                       | `{cards, decks}` for a deck or folder; `decks` includes empty ones   |
| POST   | `/api/rate`        | `{deck, id, r}`                 | `r` is `bad`, `ok`, `good` or `null`; 404 if the card does not exist |
| POST   | `/api/card`        | `{deck, id, f, b, convert?}`    | edit a card; 409 if `convert` is needed                              |
| POST   | `/api/card/add`    | `{deck, f, b, tags?, convert?}` | append a card                                                        |
| POST   | `/api/card/delete` | `{deck, id}`                    | remove a card                                                        |
| POST   | `/api/reset`       | `{path}`                        | clear ratings of a deck or folder                                    |
| POST   | `/api/rename`      | `{path, name}`                  | rename a deck or folder                                              |
| POST   | `/api/deck/create` | `{parent, name, type}`          | `type` is `folder` or `deck` (a deck must be inside a folder; folders nest up to 8 levels) |
| POST   | `/api/deck/delete` | `{path}`                        | move to `data/.trash/`                                               |
| POST   | `/api/import`      | `{parent, name, content}`       | create a subdeck from CSV text                                       |
| GET    | `/api/export`      | `?path=X`                       | download a deck's CSV                                                |
| GET    | `/api/health`      |                                 | `{ok, version, auth, setup_needed}` (public)                         |
| POST   | `/api/setup`       | `{code, passphrase, confirm}`   | first-run: `code` is the one-time code printed by the server; creates hash + session (public, only if no `.auth`) |
| POST   | `/api/login`       | `{passphrase}`                  | sets session cookie (public)                                         |
| POST   | `/api/logout`      |                                 | clears session cookie                                                |

## Security notes

- **Path traversal is rejected**; hidden files and folders (leading `.`) are ignored.
- **Response headers**: `nosniff`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`.
- **Content-Security-Policy**: same-origin resources only (images included), no inline scripts and no inline styles. Decks with `#html:true` may contain markup but cannot run code.
- **HTML in cards is sanitised on read and on write**: only `b i u sub sup ul ol li br` survive, everything else becomes plain text.
- **CSV cells are stored and exported verbatim**: a front/back starting with `=`, `+`, `-` or `@` is a live formula if the exported file is opened in Excel/LibreOffice. Only open exports from decks you trust.
- **A corrupt `.ratings.json` is moved aside** to `.ratings.corrupt-<timestamp>.json` instead of being overwritten; malformed entries inside a valid file are dropped on read.
- **Writes (decks and ratings) are atomic and fsynced**; ratings are accepted only for cards that exist.
- **Login rate limiting**: at most 5 login/setup attempts per IP per minute, counted before the passphrase is checked so parallel requests cannot bypass it (further attempts get HTTP 429 with `Retry-After`). A successful login resets the counter. IPv6 clients are grouped by /64. Behind a reverse proxy all clients share the proxy's address. Failed logins are written to stderr (`journalctl --user -u recto`).
- **First-run takeover protection**: while no passphrase exists, setup requires a random one-time code printed on the server console, so a stranger who reaches the port first cannot claim the instance. If `.auth` exists but is unreadable, the server refuses logins instead of reopening setup.
- **Passphrase authentication (web UI only)**: on first visit the browser asks for a passphrase (with confirmation). Only a scrypt hash (N=2^16, r=8, p=2) is stored in `data/.auth` (mode 600 from creation). Every new browser session requires the passphrase again; sessions live in memory (with expiry matching the cookie Max-Age of 24 h) and vanish on server restart. There is no direct web access recovery if the passphrase is lost, direct machine access is needed.
- **Known limits**: one user per instance, no spaced repetition, no multi-device session sync. Cookie is `HttpOnly; SameSite=Strict; Secure` with the `__Host-` prefix (the browser refuses it unless it is Secure and path-wide), because HTTPS is mandatory.
- **Slow or idle clients**: the TLS handshake runs per connection in its own thread under a 30 s timeout, so a silent TCP connection cannot stall the server. At most 64 connections are served at once (extra ones are dropped) and no connection lives longer than 5 minutes, so a client trickling bytes cannot hold a slot forever; concurrent scrypt hashes are capped at 2 to bound memory.
- **File permissions**: the server sets `umask 077`, so decks, backups and the trash are created readable only by its user. Files that already exist keep their mode.
- **`.auth` lives in the data folder**: if you sync or share that folder (Syncthing, Nextcloud...), exclude `.auth` and `.ratings.json`, or the passphrase hash leaves the machine.
- **HTTPS (required)**: TLS 1.2 or newer; the server refuses to start without `--cert` and `--key`, so the passphrase and the session cookie never travel in cleartext. A self-signed certificate is fine when only you access the instance (the browser warns once per device); on Tailscale, `tailscale cert <machine>.<tailnet>.ts.net` gives a trusted one. Keep the private key outside the repository (see *Getting started*). Behind a TLS-terminating reverse proxy Recto cannot be used as is.

## Roadmap

Tests, swipe gestures on mobile, images in cards.

## Author

**Francesco Scolz**

* [LinkedIn](https://www.linkedin.com/in/francesco-scolz)
* [GitHub](https://github.com/FreyFlyy)
* [Hugging Face](https://huggingface.co/FreyFlyy)

## License

This project is licensed under the **[GNU AGPL v3](https://www.gnu.org/licenses/agpl-3.0.html)**.

You may use, modify and distribute this software under the same license.
If you modify it and let users interact with it over a network, you must offer them the corresponding source code (AGPL section 13).
