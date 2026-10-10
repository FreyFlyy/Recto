#!/usr/bin/env python3
# server.py
# Copyright (C) 2026 Francesco Scolz
# License: AGPL-3.0 (see LICENSE)

"""Recto: local flashcards from CSV files. Python standard library only.

Layout on disk:
    <data>/<folder>/<file>.csv   folders are decks, CSV files are subdecks
    <data>/.auth                 scrypt hash of the UI passphrase (first-run setup)
    <data>/.ratings.json         bad/ok/good ratings, keyed by deck and card id
    <data>/.trash/               deleted decks (auto-deleted after a week, see cleanup_old_files)

Usage:  python3 server.py --cert FILE --key FILE [--data DIR] [--host HOST] [--port PORT]
Env:    RECTO_DATA, RECTO_HOST, RECTO_PORT, RECTO_ALLOWED_HOSTS
        (command-line flags take precedence over env vars)

License: AGPL-3.0 (see LICENSE)
"""

import argparse
import base64
import csv
import hashlib
import hmac
import io
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import sys
import threading
import time
import traceback
from html import escape
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

VERSION = "1.0.0"

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = Path(os.environ.get("RECTO_DATA", BASE / "data")).resolve()
STATE = DATA / ".ratings.json"
AUTH = DATA / ".auth"          # scrypt hash of the passphrase (created on first run)
HOST = os.environ.get("RECTO_HOST", "127.0.0.1")

# In-memory session tokens (lost on restart → re-login). token -> expiry (unix time).
# Single-user, so a small dict is enough; expired tokens are dropped on check.
SESSIONS = {}
COOKIE_NAME = "__Host-recto_sess"   # __Host- prefix: the browser enforces Secure, Path=/ and no Domain
SESSION_MAX_AGE = 86400  # seconds (matches cookie Max-Age)
TLS_ENABLED = False       # set True in main(): HTTPS is mandatory (cookies get Secure, HSTS is sent)
SETUP_CODE = None         # one-time code printed on the console while no passphrase exists (see setup_auth)

# Failed-login rate limit: at most 5 tries per IP per minute (in-memory, lost on restart).
LOGIN_ATTEMPTS = {}   # ip -> [unix times of failed attempts]
LOGIN_MAX_TRIES = 5
LOGIN_WINDOW = 60  # seconds

# Connection limits: one thread per connection, so cap how many are served at once and
# how long any single one may live (a client trickling bytes cannot hold a slot forever).
MAX_CONNECTIONS = 64      # extra connections are dropped immediately
CONN_DEADLINE = 300       # seconds, hard cap on the lifetime of one connection

# Hourly janitor: trash contents, *.bak copies, quarantined ratings and leftover
# temp files older than this are deleted.
TRASH_TTL = 7 * 24 * 3600  # seconds (one week)
CLEANUP_INTERVAL = 3600  # seconds (one hour)


def _port(v):
    """Validate a TCP port; exit with a clear message instead of a traceback."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = 0

    if not 1 <= n <= 65535:
        sys.exit(f"invalid port: {v!r}")
    return n


PORT = _port(os.environ.get("RECTO_PORT", "8787"))


MAX_BODY = 1_000_000      # max JSON body for regular POSTs (bytes, 1MB)
MAX_IMPORT = 10_000_000   # max JSON body for CSV uploads (bytes, 10MB)
csv.field_size_limit(MAX_IMPORT)   # default 128 KB would make a deck with one long cell silently vanish

MAX_DEPTH = 8             # folder nesting limit (tree() is recursive: a runaway chain would break /api/tree)

RATINGS = ("bad", "ok", "good")
SEPARATORS = {"comma": ",", "semicolon": ";", "tab": "\t", "space": " ", "pipe": "|", "colon": ":"}
ID_RE = re.compile(r"[0-9a-f]{16}")   # shape of a card id (see card_id)
HEADER = {"front", "question"}   # first-cell values marking a header row
OK_TAGS = {"b", "i", "u", "br", "ul", "ol", "li", "sub", "sup"}   # HTML allowed in cards

# One global lock: single-user tool, so coarse locking keeps file writes simple and safe.
LOCK = threading.Lock()
_cache = {}   # CSV path -> (mtime, cards) to avoid re-parsing unchanged files

# Extra hostnames accepted in the Host header, e.g. a full MagicDNS name.
EXTRA_HOSTS = {h.strip().lower() for h in os.environ.get("RECTO_ALLOWED_HOSTS", "").split(",") if h.strip()}

# Files served from static/. Explicit whitelist: nothing else is reachable by URL.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
}


# ---------- paths and validation ----------

def host_ok(hostport):
    """DNS-rebinding guard for the Host header.
    Accepts IP literals, localhost, single-label names, *.local, *.ts.net and
    anything listed in RECTO_ALLOWED_HOSTS.
    """
    if hostport.startswith("["):   # IPv6 literal: validate what is inside the brackets
        end = hostport.find("]")
        if end < 0:
            return False
        rest = hostport[end + 1:]
        if rest and not re.fullmatch(r":[0-9]{1,5}", rest):
            return False   # garbage after "]" (e.g. "[::1]evil.com") must not pass
        try:    # validate IPv6 (or any IP) inside brackets
            ipaddress.ip_address(hostport[1:end])
            return True
        except ValueError:
            return False
    name = hostport.split(":")[0]

    if not name:
        return False

    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass

    return (name == "localhost" or "." not in name
            or name.endswith((".local", ".ts.net")) or name in EXTRA_HOSTS)


def rel(p):
    """Path relative to DATA, with forward slashes (the id used by the API)."""
    return p.relative_to(DATA).as_posix()


def safe(path):
    """Resolve a relative path inside DATA; reject traversal and hidden entries."""
    if path and any(s in ("", ".", "..") for s in path.split("/")):
        raise ValueError("invalid path")
    p = (DATA / path).resolve()

    if p != DATA and DATA not in p.parents:
        raise ValueError("invalid path")

    if any(s.startswith(".") for s in p.relative_to(DATA).parts):
        raise ValueError("invalid path")

    return p


def valid_name(name):
    """
    Deck/folder names: no separators, no leading dot, no control characters,
    at most 200 bytes (filesystems cap names at 255, and we add suffixes).
    """
    if (not name or "/" in name or "\\" in name or name.startswith(".")
            or any(ord(ch) < 32 for ch in name) or len(name.encode("utf-8")) > 200):
        raise ValueError("invalid name")

    return name


def taken(base, name, ignore=None):
    """
    True if base already holds an entry that would share the id `name`: a folder
    `name` or a deck `name.csv` (case-insensitive, as find_deck is). A deck and a
    folder with the same id would share ratings, and deleting one would wipe the other's.
    """
    low = name.lower()

    try:
        return any(e != ignore and e.name.lower() in (low, low + ".csv") for e in base.iterdir())
    except OSError:
        return False


def find_deck(path):
    """Return the CSV file for a deck id (case-insensitive extension), or None."""
    if not path:
        return None
    p = safe(path)

    if p.is_file() and p.suffix.lower() == ".csv":
        return p
    c = safe(path + ".csv")

    if c.is_file():
        return c

    if p.parent.is_dir():
        for f in p.parent.iterdir():
            if (f.is_file() and not f.is_symlink() and not f.name.startswith(".")
                    and f.stem.lower() == p.name.lower() and f.suffix.lower() == ".csv"):
                return f

    return None


def atomic_write(p, data, mode=None):
    """Write bytes to a temp file, fsync, then rename: p is never left half-written.
    With `mode` the temp file has that permission from the moment it exists."""
    tmp = p.with_name("." + p.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0),
                 0o666 if mode is None else mode)

    with os.fdopen(fd, "wb") as fh:
        if mode is not None:
            os.fchmod(fh.fileno(), mode)
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)


# ---------- passphrase auth (stdlib scrypt, high cost) ----------

# scrypt parameters to make offline brute-force expensive (OWASP profile N=2^16, r=8, p=2).
# No bcrypt (not in stdlib); scrypt is the intended KDF here. Memory used is about 128 * N * r bytes (64 MB).
SCRYPT_N = 2 ** 16   # CPU/memory cost
SCRYPT_R = 8    # block size
SCRYPT_P = 2    # parallelisation
SCRYPT_DKLEN = 64   # key length (bytes)
SCRYPT_SALT_LEN = 16    # salt length (bytes)
SCRYPT_MAXMEM = 256 * 1024 * 1024   # hashlib refuses more than 32 MB unless told otherwise
SCRYPT_SLOTS = threading.BoundedSemaphore(2)   # each hash needs 64+ MB: cap concurrent ones so a login flood cannot exhaust RAM


def _b64(b):
    """Encode in base64"""
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _unb64(s):
    """Decode from base64"""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def hash_passphrase(pw: str) -> dict:
    """Return a dict ready to be JSON-serialised into .auth."""
    salt = secrets.token_bytes(SCRYPT_SALT_LEN)
    with SCRYPT_SLOTS:
        dk = hashlib.scrypt(
            pw.encode("utf-8"), salt=salt,
            n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN, maxmem=SCRYPT_MAXMEM,
        )

    return {
        "salt": _b64(salt),
        "hash": _b64(dk),
        "n": SCRYPT_N,
        "r": SCRYPT_R,
        "p": SCRYPT_P,
        "dklen": SCRYPT_DKLEN,
    }


def verify_passphrase(pw: str, stored: dict) -> bool:
    """Constant-time verification against the stored scrypt parameters."""
    try:
        salt = _unb64(stored["salt"])
        expected = _unb64(stored["hash"])
        n = int(stored.get("n", SCRYPT_N))
        r = int(stored.get("r", SCRYPT_R))
        p = int(stored.get("p", SCRYPT_P))
        dklen = int(stored.get("dklen", SCRYPT_DKLEN))
        # A hand-edited or planted .auth must not force huge memory/CPU on login.
        if not (len(salt) <= 64 and len(expected) <= 256):
            return False
        if not (n & (n - 1) == 0 and 2 ** 10 <= n <= 2 ** 17
                and 1 <= r <= 8 and 1 <= p <= 4 and 16 <= dklen <= 256):
            return False
        with SCRYPT_SLOTS:
            got = hashlib.scrypt(
                pw.encode("utf-8"), salt=salt,
                n=n, r=r, p=p, dklen=dklen, maxmem=SCRYPT_MAXMEM,
            )
        return hmac.compare_digest(got, expected)

    except Exception:
        return False


def load_auth():
    """Load .auth or None if missing/corrupt."""
    try:
        raw = AUTH.read_bytes()
        if len(raw) > 100_000:   # .auth is <1 KB; anything bigger is not ours
            return None
        s = json.loads(raw)
        if not isinstance(s, dict) or "salt" not in s or "hash" not in s:
            return None
        return s
    except (FileNotFoundError, ValueError, OSError):
        return None


def auth_configured():
    """True if a .auth file exists, even a corrupt one: a damaged file must never reopen first-run setup."""
    return os.path.lexists(AUTH)


def save_auth(data: dict):
    """Save .auth atomically, with mode 600 from creation (never world-readable, not even briefly)"""
    atomic_write(AUTH, json.dumps(data, ensure_ascii=False).encode("utf-8"), 0o600)


# ---------- ratings store ----------

def load_state():
    """
    Load ratings state. A missing file means no ratings; an unreadable one is moved
    aside (never silently overwritten by the next save) and reported on stderr.
    """
    try:
        raw = STATE.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError as e:
        print(f"warning: ratings file unreadable ({e}); ignoring", file=sys.stderr)
        return {}

    try:
        s = json.loads(raw)
        if not isinstance(s, dict):
            raise ValueError("not a JSON object")
        # Keep only well-formed entries: a hand-edited file must not turn every request into a 500.
        return {d: {c: v for c, v in ds.items() if isinstance(v, dict) and v.get("r") in RATINGS}
                for d, ds in s.items() if isinstance(ds, dict)}

    except ValueError as e:
        bad = STATE.with_name(f".ratings.corrupt-{int(time.time())}.json")
        try:
            os.replace(STATE, bad)
            os.utime(bad)   # the quarantine's age counts from now (see cleanup_old_files)
        except OSError as e2:
            print(f"warning: ratings file unreadable ({e}); could not move aside ({e2})",
                  file=sys.stderr)
            return {}
        print(f"warning: ratings file unreadable ({e}); moved to {bad.name}", file=sys.stderr)
        return {}


def save_state(s):
    """Save ratings state"""
    atomic_write(STATE, json.dumps(s, ensure_ascii=False).encode("utf-8"), 0o600)


def drop_ratings(prefix):
    """Delete ratings of a deck id, or of every deck under a folder id. Returns count removed."""
    st = load_state()
    keys = [k for k in st if k == prefix or k.startswith(prefix + "/")]
    n = sum(len(st[k]) for k in keys)

    for k in keys:
        del st[k]
    if keys:
        save_state(st)

    return n


def remap_ratings(deck, mapping):
    """Re-key a deck's ratings after card ids changed ({old_id: new_id})."""
    st = load_state()
    ds = st.get(deck)
    if ds and mapping:
        st[deck] = {mapping.get(k, k): v for k, v in ds.items()}
        save_state(st)


# ---------- CSV parsing ----------

def card_id(front, back):
    """
    A card's id is a hash of its content, so editing a card changes its id
    (ratings are migrated by the edit functions below). The front is length-prefixed
    so that (front, back) pairs can never collide by moving text across a separator.
    """
    return hashlib.sha256(f"{len(front)}:{front}{back}".encode("utf-8")).hexdigest()[:16]


def cid_of(front, back, html):
    """
    Card id of content as the API exposes it. HTML decks are sanitised on
    read (see read_deck), so ids are computed on the sanitised text the client
    actually displays; edits then keep ratings attached to the right card.
    """
    if html:
        front, back = sanitize(front), sanitize(back)
    return card_id(front.strip(), back.strip())


def parse_file(p):
    """
    Parse a CSV keeping everything needed to rewrite it later.
    Returns a dict: dirs (directive lines), sep, html, tagcol (0-based or None),
    header (row or None), rows (list of lists).
    """
    raw = p.read_text("utf-8-sig", errors="replace")
    sep, html_on, tagcol = None, False, None
    lines = raw.splitlines(keepends=True)
    pos = 0

    while pos < len(lines):    # leading "#key:value" directives (Anki style)
        s = lines[pos].strip()
        if not s.startswith("#"):
            break
        if s.startswith("#separator:"):
            v = s.split(":", 1)[1].strip()
            if v.lower() in SEPARATORS:
                sep = SEPARATORS[v.lower()]
            elif len(v) == 1 and v not in "\"\r\n":    # a literal delimiter character
                sep = v
            elif v:    # a typo like "semicolons" must not silently split on "s"; a quote would corrupt the file
                raise ValueError(f"unsupported #separator value: {v[:20]!r}")
            else:    # fallback
                sep = ","

        elif s.startswith("#html:"):
            html_on = s.split(":", 1)[1].strip().lower() in {"true", "1", "yes"}

        elif s.startswith("#tags column:"):
            try:
                n = int(s.split(":", 1)[1].strip())   # Counts from 1
                tagcol = n - 1 if n >= 3 else None    # columns 1-2 are front/back
            except ValueError:
                tagcol = None

        pos += 1    # unknown directives are kept as-is on rewrite

    txt = "".join(lines[pos:])
    explicit = sep is not None

    if sep is None:    # no directive: guess from the first line
        first = txt.splitlines()[0] if txt else ""
        sep = max(["\t", ";", ","], key=first.count)

    rows = [r for r in csv.reader(io.StringIO(txt, newline=""), delimiter=sep)
            if any(x.strip() for x in r)]
    header = rows.pop(0) if rows and rows[0][0].strip().lower() in HEADER else None

    return {"dirs": lines[:pos], "sep": sep, "sep_explicit": explicit, "html": html_on, "tagcol": tagcol,
            "header": header, "rows": rows}


def split_tags(s):
    """Split card tags (comma, semicolon...)"""
    return [t.lower() for t in re.split(r"[;,\s]+", s) if t]


def read_deck(p):
    """Cards of a CSV deck, cached by mtime. Unreadable files yield no cards."""
    s = p.stat()
    m = (s.st_mtime_ns, s.st_size)    # size too: a same-tick external edit must not serve stale cards
    c = _cache.get(p)

    if c and c[0] == m:
        return c[1]
    cards = []

    try:
        d = parse_file(p)
        for r in d["rows"]:
            if len(r) < 2:
                continue
            front, back = r[0].strip(), r[1].strip()
            if not front or not back:
                continue
            if d["tagcol"] is not None:
                src = " ".join(r[d["tagcol"]:]) if d["tagcol"] < len(r) else ""
            else:
                src = " ".join(r[2:])
            if d["html"]:   # sanitise on read: imported or hand-edited HTML
                front, back = sanitize(front), sanitize(back)   # cannot smuggle markup past the whitelist
            cards.append({"id": cid_of(front, back, False), "f": front, "b": back,
                          "t": split_tags(src), "html": d["html"], "deck": None})

    except Exception as e:    # one broken file must not take down the whole tree
        print(f"warning: cannot read {p.name}: {e}", file=sys.stderr)

    _cache[p] = (m, cards)
    return cards


def card_rows(m):
    """
    (row index, card id) for every valid card row of a parsed file.
    Ids match what read_deck exposes (sanitised content for HTML decks).
    """
    return [(k, cid_of(r[0], r[1], m["html"])) for k, r in enumerate(m["rows"])
            if len(r) >= 2 and r[0].strip() and r[1].strip()]


# ---------- HTML sanitising ----------

class _Sanitizer(HTMLParser):
    """Whitelist filter: allowed tags without attributes, escaped text, everything else dropped."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = []

    def handle_starttag(self, tag, attrs):
        if tag in OK_TAGS:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if tag in OK_TAGS and tag != "br":
            self.out.append(f"</{tag}>")

    def handle_data(self, data):
        self.out.append(escape(data.replace("\r", "").replace("\n", " "), quote=False))


def sanitize(s):
    """Sanitize a text"""
    p = _Sanitizer()
    p.feed(s)
    p.close()
    return "".join(p.out)


def clean_pair(f, b):
    """Sanitise front/back from the editor; both must keep some visible text."""
    if not all(isinstance(x, str) for x in (f, b)):
        raise ValueError("invalid fields")

    f, b = sanitize(f).strip(), sanitize(b).strip()
    if not all(re.sub(r"<[^>]*>", "", x).strip() for x in (f, b)):
        raise ValueError("front and back cannot be empty")

    return f, b


# ---------- card editing ----------

def write_file(p, m):
    """Rewrite a CSV from its parsed form (directives and header preserved).
    The original is copied to <file>.bak before the first write and never
    overwritten afterwards. Quoting and line endings may change."""
    buf = io.StringIO(newline="")
    w = csv.writer(buf, delimiter=m["sep"], lineterminator="\n")

    if not m["header"] and m["rows"] and m["rows"][0][0].lstrip().startswith("#"):
        m["header"] = ["front", "back"]   # a first card starting with "#" would be read back as a directive and vanish

    if m["header"]:
        w.writerow(m["header"])

    w.writerows(m["rows"])
    dirs = list(m["dirs"])

    if not m.get("sep_explicit"):
        # The separator was auto-detected from the first line, and rewriting can change that
        # line (e.g. "&amp;" adds a ";"), flipping the guess and corrupting the deck. Pin it.
        name = next((k for k, v in SEPARATORS.items() if v == m["sep"]), None)
        if name:
            dirs.insert(0, f"#separator:{name}\n")

    head = "".join(d if d.endswith("\n") else d + "\n" for d in dirs)
    bak = p.with_name(p.name + ".bak")

    if not bak.exists():
        shutil.copy2(p, bak)
        os.utime(bak)   # the safety copy's age counts from now (see cleanup_old_files)

    atomic_write(p, (head + buf.getvalue()).encode("utf-8"))
    _cache.pop(p, None)


def to_html(m):
    """Convert a plain-text deck to HTML in place (text is escaped).
    Returns {old_id: new_id} so ratings can follow."""
    idmap = {}

    for r in m["rows"]:
        if len(r) >= 2 and r[0].strip() and r[1].strip():
            oid = card_id(r[0].strip(), r[1].strip())
            # newlines become <br>: sanitize() turns raw newlines into spaces, which would flatten the card
            r[0], r[1] = (escape(x.strip().replace("\r\n", "\n").replace("\r", "\n"), quote=False)
                          .replace("\n", "<br>") for x in (r[0], r[1]))
            idmap.setdefault(oid, cid_of(r[0], r[1], True))

    m["dirs"] = [d for d in m["dirs"] if not d.strip().startswith("#html:")] + ["#html:true\n"]
    m["html"] = True

    return idmap


def edit_card(p, deck, m, cid, f, b):
    """Replace a card's front/back. Returns the new id, or None if the card is gone."""
    idmap = to_html(m) if not m["html"] else {}
    cur = idmap.get(cid, cid)
    k = next((k for k, i in card_rows(m) if i == cur), None)

    if k is None:
        return None

    nid = card_id(f, b)
    if nid != cur and any(i == nid for j, i in card_rows(m) if j != k):
        raise ValueError("a card with the same front and back already exists")

    m["rows"][k][0], m["rows"][k][1] = f, b
    write_file(p, m)

    remap_ratings(deck, {o: (nid if n == cur else n) for o, n in idmap.items()} or {cid: nid})
    return nid


def add_card(p, deck, m, f, b, tags=()):
    """Append a card; tags go to the tags column (3rd unless '#tags column' says otherwise)."""
    idmap = to_html(m) if not m["html"] else {}
    nid = card_id(f, b)

    if any(i == nid for _, i in card_rows(m)):
        raise ValueError("a card with the same front and back already exists")

    idx = m["tagcol"] if m["tagcol"] is not None else 2
    if idx < 2:    # a tags column inside front/back would silently corrupt cards
        raise ValueError("#tags column must be 3 or higher (index counts from 1)")
    row = [f, b]

    if tags:
        row += [""] * (idx - 2) + [" ".join(tags)]

    m["rows"].append(row)
    write_file(p, m)
    remap_ratings(deck, idmap)

    return nid


def delete_card(p, deck, m, cid):
    """Delete a card from a deck from its cid"""
    k = next((k for k, i in card_rows(m) if i == cid), None)

    if k is None:
        return None

    del m["rows"][k]
    write_file(p, m)

    if not any(i == cid for _, i in card_rows(m)):   # duplicates share one id (and one rating)
        st = load_state()
        if st.get(deck, {}).pop(cid, None) is not None:
            save_state(st)

    return cid


# ---------- deck management ----------

def counts(deck_id, f, st):
    """Return rating counts (total/bad/ok/good/new) for a deck file."""
    ds = st.get(deck_id, {})
    cs = read_deck(f)
    c = {"total": len(cs), "bad": 0, "ok": 0, "good": 0}

    for x in cs:
        r = ds.get(x["id"], {}).get("r")
        if r in RATINGS:
            c[r] += 1

    c["new"] = c["total"] - c["bad"] - c["ok"] - c["good"]
    return c


def tree(d, st):
    """
    Recursive deck tree with rating counts; hidden entries, symlinks and
    non-CSV files are skipped.
    """
    n = {"name": d.name, "path": "" if d == DATA else rel(d), "children": []}
    tot = {"total": 0, "bad": 0, "ok": 0, "good": 0, "new": 0}

    try:
        entries = sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
    except OSError:
        entries = []

    for e in entries:
        if e.name.startswith(".") or e.is_symlink():
            continue
        try:
            rp = e.resolve()

            if rp != DATA and DATA not in rp.parents:
                continue   # symlink pointing outside the data folder

            if e.is_dir():
                ch = tree(e, st)

            elif e.suffix.lower() == ".csv":
                did = rel(e)[:-4]
                ch = {"name": e.stem, "path": did, "deck": True, "counts": counts(did, e, st)}

            else:
                continue

            n["children"].append(ch)

            for k in tot:
                tot[k] += ch["counts"][k]

        except (OSError, ValueError):
            continue   # a broken entry must not take down the whole tree

    n["counts"] = tot
    return n


def cards_for(path, st):
    """
    All cards under a deck id or folder, plus every deck id (empty ones included).
    Returns None if `path` is neither a deck nor a folder.
    """
    f = find_deck(path) if path else None

    if f is not None:
        files = [f]
    else:
        p = safe(path) if path else DATA
        if not p.is_dir():
            return None
        files = sorted(f for f in p.rglob("*")
                       if f.is_file() and not f.is_symlink() and f.suffix.lower() == ".csv")

    out, decks = [], []
    for fp in files:
        try:
            rp = fp.resolve()
            if rp != DATA and DATA not in rp.parents:
                continue    # symlink pointing outside the data folder
            if any(s.startswith(".") for s in fp.relative_to(DATA).parts):
                continue
            did = rel(fp)[:-4]
            decks.append(did)
            ds = st.get(did, {})
            for c in read_deck(fp):
                out.append({**c, "deck": did, "r": ds.get(c["id"], {}).get("r")})
        except (OSError, ValueError):
            continue   # a broken entry must not take down the whole folder

    return out, decks


def reset_progress(path):
    """Clear ratings of a deck or folder. Returns how many were cleared, None if not found."""
    f = find_deck(path)
    p = safe(path)
    prefix = rel(f)[:-4] if f else (rel(p) if p.is_dir() else None)
    return None if prefix is None else drop_ratings(prefix)


def create_deck(parent, name, kind, content=None):
    """
    Create a folder ('folder') or an empty/imported CSV ('deck') under parent ('' = root).
    Returns the new id, or None if parent is not a folder.
    """
    name = valid_name(name)
    base = safe(parent) if parent else DATA

    if not base.is_dir():
        return None
    if kind == "deck":
        if not parent:
            raise ValueError("a subdeck must be created inside a deck")
        name = valid_name(re.sub(r"\.csv$", "", name, flags=re.I))
    if parent and parent.count("/") + 1 >= MAX_DEPTH:
        raise ValueError(f"folders cannot be nested more than {MAX_DEPTH} levels")

    dst = base / (name + ".csv" if kind == "deck" else name)
    safe(rel(dst))

    if dst.exists() or taken(base, name):
        raise ValueError("a deck or folder with that name already exists")

    if kind == "deck":
        text = content if content is not None else "#html:true\nfront,back,tags\n"
        atomic_write(dst, text.encode("utf-8"))
    else:
        dst.mkdir()

    _cache.clear()
    return rel(dst)[:-4] if kind == "deck" else rel(dst)


def import_csv(parent, name, content):
    """Create a subdeck from uploaded CSV text. Returns (id, card_count) or None."""
    if not parent:
        raise ValueError("choose a deck to import into")

    if not content.strip():
        raise ValueError("empty file")

    new_id = create_deck(parent, name, "deck", content)
    if new_id is None:
        return None
    f = find_deck(new_id)

    try:
        parse_file(f)   # surfaces the real reason (e.g. a bad #separator) instead of "no valid cards"
        cards = read_deck(f)
    except Exception:
        f.unlink()   # unparsable: undo the import
        _cache.clear()
        raise

    if not cards:   # nothing usable: undo the import
        f.unlink()
        _cache.clear()
        raise ValueError("no valid cards found (need at least two columns: front, back)")

    seen, dups, example = set(), 0, ""
    for c in cards:
        if c["id"] in seen:
            dups += 1
            if dups == 1:
                example = re.sub(r"<[^>]*>", "", c["f"]).strip()[:60]
        seen.add(c["id"])
    if dups:   # identical front+back twice would share one id (and one rating): refuse the import
        f.unlink()
        _cache.clear()
        raise ValueError(f"duplicate cards found ({dups}, e.g. {example!r}): "
                         "every card must have a unique front and back")

    return new_id, len(cards)


def rename_path(path, new_name):
    """Rename a deck or folder; its .bak follows and ratings are re-keyed. None if missing."""
    valid_name(new_name)
    f = find_deck(path) if path else None
    src = f or (safe(path) if path else None)

    if src is None or (f is None and not src.is_dir()):
        return None
    if f:
        new_name = valid_name(re.sub(r"\.csv$", "", new_name, flags=re.I))

    dst = src.with_name(new_name + ".csv" if f else new_name)
    safe(rel(dst))

    if dst.exists() or taken(dst.parent, dst.stem if f else dst.name, ignore=src):
        raise ValueError("a deck or folder with that name already exists")

    old_id, new_id = (rel(src)[:-4], rel(dst)[:-4]) if f else (rel(src), rel(dst))
    bak = src.with_name(src.name + ".bak")
    src.rename(dst)

    if f and bak.exists():
        bak.rename(dst.with_name(dst.name + ".bak"))

    st = load_state()
    st = {(new_id + k[len(old_id):] if k == old_id or k.startswith(old_id + "/") else k): v
          for k, v in st.items()}

    save_state(st)
    _cache.clear()
    return new_id


def trash_path(path):
    """
    Move a deck (plus .bak) or folder to data/.trash/<timestamp>-<name>/ and clear its
    ratings. Ratings are not restored if the deck is moved back by hand.
    """
    if not path:
        raise ValueError("invalid path")

    f = find_deck(path)
    src = f or safe(path)
    if f is None and not src.is_dir():
        return False

    prefix = rel(src)[:-4] if f else rel(src)
    stamp, k = time.strftime("%Y%m%d-%H%M%S"), 0
    dest = DATA / ".trash" / f"{stamp}-{src.name}"
    while dest.exists():
        k += 1
        dest = DATA / ".trash" / f"{stamp}-{k}-{src.name}"

    dest.mkdir(parents=True)
    bak = src.with_name(src.name + ".bak")
    shutil.move(str(src), str(dest / src.name))

    if f and bak.exists():
        shutil.move(str(bak), str(dest / bak.name))
    drop_ratings(prefix)
    _cache.clear()
    return True


def cleanup_old_files():
    """
    Delete janitor-managed leftovers older than TRASH_TTL: trashed decks,
    *.csv.bak safety copies, quarantined .ratings files and orphaned temp files.
    Returns {kind: count}.
    """
    now = time.time()
    removed = {"trash": 0, "bak": 0, "corrupt": 0}
    with LOCK:
        try:
            entries = list((DATA / ".trash").iterdir())
        except OSError:
            entries = []
        for e in entries:
            try:
                if e.is_symlink() or now - e.stat().st_mtime < TRASH_TTL:
                    continue
                if e.is_dir():
                    shutil.rmtree(e, ignore_errors=True)
                else:
                    e.unlink()
                removed["trash"] += 1
            except OSError:
                continue
        # os.walk never descends into symlinked folders (a link to a directory outside)
        for root, dirs, names in os.walk(DATA, followlinks=False):
            dirs[:] = [d for d in dirs if d != ".trash"]
            for name in names:
                x = Path(root) / name
                try:
                    if x.is_symlink() or not x.is_file():
                        continue
                    if now - x.stat().st_mtime < TRASH_TTL:
                        continue
                    if name.lower().endswith(".csv.bak"):
                        x.unlink()
                        removed["bak"] += 1
                    elif name.startswith(".ratings.corrupt-") and name.endswith(".json"):
                        x.unlink()
                        removed["corrupt"] += 1
                    elif name.startswith(".") and name.endswith(".tmp"):
                        x.unlink()
                except OSError:
                    continue
    return removed


# ---------- HTTP layer ----------

def throttle_key(ip):
    """
    Rate-limit bucket of a client address: IPv6 clients are grouped by /64 (one host can
    own millions of addresses in it); IPv4-mapped addresses count as plain IPv4.
    """
    try:
        a = ipaddress.ip_address(ip.split("%")[0])
    except ValueError:
        return ip
    if a.version == 6:
        if a.ipv4_mapped:
            return str(a.ipv4_mapped)
        return str(ipaddress.ip_network(f"{a}/64", strict=False))
    return str(a)


def login_throttle(ip):
    """
    Atomically check AND record one login/setup attempt from `ip`.
    Returns the seconds to wait (0 = allowed). Recording before the passphrase is checked
    means a burst of parallel requests cannot all slip under the limit.
    """
    ip = throttle_key(ip)
    now = time.time()
    with LOCK:
        if len(LOGIN_ATTEMPTS) > 1000:   # bound memory under a flood of distinct addresses
            for k in [k for k, v in LOGIN_ATTEMPTS.items() if not v or now - v[-1] >= LOGIN_WINDOW]:
                del LOGIN_ATTEMPTS[k]
        hits = [t for t in LOGIN_ATTEMPTS.get(ip, []) if now - t < LOGIN_WINDOW]
        if len(hits) >= LOGIN_MAX_TRIES:
            LOGIN_ATTEMPTS[ip] = hits
            return int(hits[0] + LOGIN_WINDOW - now) + 1
        hits.append(now)
        LOGIN_ATTEMPTS[ip] = hits
        return 0


def clear_login_attempts(ip):
    """Forget the recorded attempts from `ip` after a successful login."""
    with LOCK:
        LOGIN_ATTEMPTS.pop(throttle_key(ip), None)


class Handler(BaseHTTPRequestHandler):
    """Class for HTTP Handling"""
    server_version = f"Recto/{VERSION}"
    sys_version = ""    # do not advertise the Python version
    timeout = 30    # seconds: drop stalled connections instead of blocking a thread forever

    def log_message(self, fmt, *args):
        pass    # silent by default; remove this override to get access logs when debugging

    def setup(self):
        super().setup()
        self._deadline = threading.Timer(CONN_DEADLINE, self._abort)
        self._deadline.daemon = True
        self._deadline.start()

    def _abort(self):
        """
        Deadline hit: shut the socket down so a blocked read returns at once.
        The plain socket method is used on purpose: SSLSocket.shutdown() would unwrap it under the reading thread.
        """
        try:
            socket.socket.shutdown(self.connection, socket.SHUT_RDWR)
        except OSError:
            pass

    def finish(self):
        self._deadline.cancel()
        super().finish()

    def reply(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()

        extra = extra or {}
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if "Cache-Control" not in extra:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        if TLS_ENABLED:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        # Decks with #html:true carry markup (possibly from third-party files):
        # no inline scripts or style attributes, so injected HTML cannot execute code.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; "
            "style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'",
        )
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()

        self.wfile.write(body)

    def fail(self):
        """Unexpected error: details go to stderr, the client gets a generic message."""
        traceback.print_exc()
        self.reply(500, {"error": "internal error, see logs in stderr"})

    def _cookies(self):
        """Parse Cookie header into a dict (simple, no attributes)."""
        out = {}
        raw = self.headers.get("Cookie") or ""

        for part in raw.split(";"):
            if "=" in part:
                k, v = part.split("=", 1)
                out[k.strip()] = v.strip()

        return out

    def session_ok(self):
        """True if the request carries a valid non-expired in-memory session token."""
        tok = self._cookies().get(COOKIE_NAME)

        if not tok:
            return False

        with LOCK:
            exp = SESSIONS.get(tok)
            if exp is None:
                return False
            if time.time() > exp:
                del SESSIONS[tok]
                return False
            return True

    def require_auth(self):
        """Return True if authenticated; otherwise send 401 and return False."""
        if self.session_ok():
            return True
        self.reply(401, {"error": "authentication required"})
        return False

    def guard(self, post=False):
        """Host check on every request; JSON content type and same-origin check on POST."""

        host = (self.headers.get("Host") or "").lower()

        if not host_ok(host):
            self.reply(403, {"error": "host not allowed (see RECTO_ALLOWED_HOSTS)"})
            return False

        if post:
            ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                self.reply(415, {"error": "Content-Type must be application/json"})
                return False

            origin = self.headers.get("Origin")
            if origin:
                try:
                    same = urlparse(origin).netloc.lower() == host
                except ValueError:   # malformed Origin
                    same = False
                if not same:
                    self.reply(403, {"error": "cross-origin requests are not allowed"})
                    return False

        return True

    def logo(self):
        """Return logo path"""
        f = STATIC / "Logo.png"
        return f if f.is_file() else None

    def do_GET(self):
        """GET request handler"""
        if not self.guard():
            return

        try:
            u = urlparse(self.path)   # inside try: a malformed URL raises ValueError
            q = parse_qs(u.query)

            if u.path in STATIC_FILES:
                name, ctype = STATIC_FILES[u.path]
                try:
                    return self.reply(200, (STATIC / name).read_bytes(), ctype)
                except FileNotFoundError:
                    return self.reply(404, {"error": "not found"})

            if u.path == "/Logo.png":
                logo = self.logo()
                if logo:
                    try:
                        return self.reply(200, logo.read_bytes(), "image/png", {"Cache-Control": "public, max-age=86400"})
                    except OSError:
                        pass
                return self.reply(404, {"error": "not found"})

            if u.path == "/api/health":
                # Public: version, whether a passphrase is configured, and session state
                configured = auth_configured()
                return self.reply(200, {
                    "ok": True,
                    "version": VERSION,
                    "auth": self.session_ok(),
                    "setup_needed": not configured,
                })

            # Everything else under /api/ requires a valid session
            if u.path.startswith("/api/"):
                if not self.require_auth():
                    return

            if u.path == "/api/tree":
                with LOCK:
                    data = tree(DATA, load_state())
                return self.reply(200, data)   # sent outside the lock: a slow client must not stall everyone

            if u.path == "/api/cards":
                with LOCK:
                    res = cards_for(q.get("path", [""])[0], load_state())
                if res is None:
                    return self.reply(404, {"error": "deck not found"})
                return self.reply(200, {"cards": res[0], "decks": res[1]})

            if u.path == "/api/export":
                with LOCK:
                    f = find_deck(q.get("path", [""])[0])
                    if f is None:
                        return self.reply(404, {"error": "deck not found"})
                    data = f.read_bytes()
                disp = ("attachment; filename=\"deck.csv\"; filename*=UTF-8''"
                        + quote(f.stem + ".csv", safe=""))
                return self.reply(200, data, "text/csv; charset=utf-8",
                                  {"Content-Disposition": disp})

            self.reply(404, {"error": "not found"})

        except (ValueError, csv.Error) as e:
            self.reply(400, {"error": str(e)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass   # client went away or stalled: nothing to answer
        except Exception:    # other exceptions
            self.fail()

    def do_POST(self):
        """POST request handler"""
        if not self.guard(post=True):
            return

        try:
            path = urlparse(self.path).path
            # Auth endpoints are public (logout works without a valid session)
            if path == "/api/setup":
                return self.setup_auth()
            if path == "/api/login":
                return self.login()
            if path == "/api/logout":
                return self.logout()

            ops = {
                "/api/rate": self.rate, "/api/card": self.edit, "/api/card/add": self.add,
                "/api/card/delete": self.delete, "/api/reset": self.reset,
                "/api/rename": self.rename, "/api/deck/create": self.create,
                "/api/deck/delete": self.trash, "/api/import": self.import_deck,
            }
            if not self.require_auth():
                return

            if path not in ops:
                return self.reply(404, {"error": "not found"})

            n = int(self.headers.get("Content-Length", 0) or 0)
            if n <= 0 or n > (MAX_IMPORT if path == "/api/import" else MAX_BODY):
                return self.reply(413, {"error": "payload missing or too large"})

            body = json.loads(self.rfile.read(n))
            if not isinstance(body, dict):
                raise ValueError("body must be a JSON object")

            ops[path](body)

        except KeyError as e:
            self.reply(400, {"error": f"missing field: {e.args[0]}"})
        except (ValueError, csv.Error, RecursionError) as e:   # RecursionError: deeply nested JSON
            self.reply(400, {"error": "invalid request" if isinstance(e, RecursionError) else str(e)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass   # client went away or stalled: nothing to answer
        except Exception:    # other exception
            self.fail()

    # --- specific POST handlers: validate the body, take the lock, call the helpers above ---

    def _read_json_body(self):
        """Helper to read a JSON"""
        n = int(self.headers.get("Content-Length", 0) or 0)

        if n <= 0 or n > MAX_BODY:
            self.reply(413, {"error": "payload missing or too large"})
            return None

        try:
            body = json.loads(self.rfile.read(n))
        except (ValueError, RecursionError):
            self.reply(400, {"error": "invalid request"})
            return None

        if not isinstance(body, dict):
            self.reply(400, {"error": "body must be a JSON object"})
            return None

        return body

    def _issue_session(self):
        """Helper to issue a session cookie"""
        tok = secrets.token_urlsafe(32)
        with LOCK:
            SESSIONS[tok] = time.time() + SESSION_MAX_AGE
            # Drop any already-expired tokens (cheap cleanup)
            now = time.time()
            for t in [t for t, e in SESSIONS.items() if e < now]:
                del SESSIONS[t]
        cookie = f"{COOKIE_NAME}={tok}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age={SESSION_MAX_AGE}"
        self.reply(200, {"ok": True}, extra={"Set-Cookie": cookie})

    def setup_auth(self):
        """First-run: set passphrase from the web UI (only if .auth is missing and the
        one-time code printed on the server console is provided)."""
        global SETUP_CODE
        ip = self.client_address[0] if self.client_address else "?"
        wait = login_throttle(ip)
        if wait > 0:
            return self.reply(429, {"error": "too many attempts, try again later"},
                              extra={"Retry-After": str(wait)})

        body = self._read_json_body()
        if body is None:
            return

        with LOCK:
            if auth_configured():
                return self.reply(409, {"error": "passphrase already configured"})

            code = body.get("code")
            if not (SETUP_CODE and isinstance(code, str)
                    and hmac.compare_digest(code.strip().encode("utf-8"), SETUP_CODE.encode("utf-8"))):
                print(f"setup refused: wrong setup code from {ip}", file=sys.stderr, flush=True)
                return self.reply(403, {"error": "invalid setup code (see the server console)"})

            pw = body.get("passphrase")
            confirm = body.get("confirm")

            if not isinstance(pw, str) or not isinstance(confirm, str):
                return self.reply(400, {"error": "passphrase and confirm required"})

            if len(pw) < 8:
                return self.reply(400, {"error": "passphrase too short (min 8 characters)"})

            if pw != confirm:
                return self.reply(400, {"error": "passphrases do not match"})
            save_auth(hash_passphrase(pw))
            SETUP_CODE = None

        clear_login_attempts(ip)
        self._issue_session()

    def login(self):
        """Verify passphrase and issue a session cookie."""
        ip = self.client_address[0] if self.client_address else "?"
        wait = login_throttle(ip)
        if wait > 0:   # checked before reading the body: blocked IPs cost one header parse
            return self.reply(429, {"error": "too many attempts, try again later"},
                              extra={"Retry-After": str(wait)})

        body = self._read_json_body()
        if body is None:
            return

        pw = body.get("passphrase")
        if not isinstance(pw, str) or not pw:
            return self.reply(400, {"error": "passphrase required"})

        stored = load_auth()
        if stored is None:
            if auth_configured():   # file present but unreadable: refuse, never fall back to setup
                return self.reply(500, {"error": "auth file unreadable, check data/.auth"})
            return self.reply(409, {"error": "passphrase not configured yet", "setup_needed": True})

        # Slow by design (scrypt).
        ok = verify_passphrase(pw, stored)
        if not ok:
            print(f"failed login from {ip}", file=sys.stderr, flush=True)   # visible in journalctl
            time.sleep(0.5)
            return self.reply(401, {"error": "wrong passphrase"})

        clear_login_attempts(ip)
        self._issue_session()

    def logout(self):
        """Clear the session token and expire the cookie."""
        tok = self._cookies().get(COOKIE_NAME)

        if tok:
            with LOCK:
                SESSIONS.pop(tok, None)

        # Expire the cookie
        cookie = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0"
        self.reply(200, {"ok": True}, extra={"Set-Cookie": cookie})

    def rate(self, body):
        """Rate a card based on cid and deck"""
        deck, cid, r = body["deck"], body["id"], body.get("r")

        if not isinstance(deck, str) or not isinstance(cid, str) or not ID_RE.fullmatch(cid):
            raise ValueError("invalid fields")

        if r is not None and r not in RATINGS:
            raise ValueError("invalid rating")

        known = True
        with LOCK:   # find_deck inside the lock: a concurrent rename must not leave a stale id
            f = find_deck(deck)
            if f is not None:
                deck = rel(f)[:-4]   # canonical id, whatever the case of the request
                # Only existing cards can be rated: no junk keys, no orphans after a concurrent edit.
                known = r is None or any(c["id"] == cid for c in read_deck(f))
                if known:
                    st = load_state()
                    ds = st.setdefault(deck, {})

                    if r is None:
                        ds.pop(cid, None)
                    else:
                        ds[cid] = {"r": r, "ts": int(time.time())}

                    save_state(st)

        if f is None:
            return self.reply(404, {"error": "deck not found"})
        if not known:
            return self.reply(404, {"error": "card not found (file changed?)"})

        self.reply(200, {"ok": True})

    def reset(self, body):
        """Reset a deck's ratings"""
        path = body["path"]

        if not isinstance(path, str) or not path:
            raise ValueError("invalid path")
        with LOCK:
            n = reset_progress(path)

        if n is None:
            return self.reply(404, {"error": "deck not found"})

        self.reply(200, {"ok": True, "reset": n})

    def create(self, body):
        """Create a deck handler"""
        parent, name, kind = body["parent"], body["name"], body["type"]

        if not (isinstance(parent, str) and isinstance(name, str) and kind in ("folder", "deck")):
            raise ValueError("invalid fields")

        with LOCK:
            new = create_deck(parent, name.strip(), kind)

        if new is None:
            return self.reply(404, {"error": "parent folder not found"})

        self.reply(200, {"ok": True, "path": new})

    def trash(self, body):
        """Trash a deck handler"""
        path = body["path"]

        if not isinstance(path, str):
            raise ValueError("invalid fields")

        with LOCK:
            found = trash_path(path)

        if not found:
            return self.reply(404, {"error": "deck not found"})

        self.reply(200, {"ok": True})

    def import_deck(self, body):
        """Import deck handler (.csv)"""
        parent, name, content = body["parent"], body["name"], body["content"]

        if not all(isinstance(x, str) for x in (parent, name, content)):
            raise ValueError("invalid fields")

        with LOCK:
            res = import_csv(parent, name.strip(), content)
        if res is None:
            return self.reply(404, {"error": "parent folder not found"})

        self.reply(200, {"ok": True, "path": res[0], "cards": res[1]})

    def rename(self, body):
        """Rename a deck handler"""
        path, name = body["path"], body["name"]

        if not isinstance(path, str) or not isinstance(name, str):
            raise ValueError("invalid fields")

        with LOCK:
            new = rename_path(path, name.strip())
        if new is None:
            return self.reply(404, {"error": "deck not found"})

        self.reply(200, {"ok": True, "path": new})

    def _mutate(self, body, op, needs_html):
        """Locate and parse the deck, require plain-text -> HTML conversion consent (409 until the client sends convert=true), then apply op."""
        deck = body["deck"]

        if not isinstance(deck, str):
            raise ValueError("invalid fields")

        with LOCK:
            p = find_deck(deck)
            if p is None:
                return self.reply(404, {"error": "deck not found"})

            deck = rel(p)[:-4]   # canonical id
            m = parse_file(p)
            conv = needs_html and not m["html"]
            if conv and not body.get("convert"):
                return self.reply(409, {"error": "plain-text deck: conversion to HTML required", "needs_convert": True})

            res = op(p, deck, m)

        if res is None:
            return self.reply(404, {"error": "card not found (file changed?)"})

        self.reply(200, {"ok": True, "id": res, "converted": conv})

    def edit(self, body):
        """Edit a card handler"""
        cid = body["id"]

        if not isinstance(cid, str):
            raise ValueError("invalid fields")

        f, b = clean_pair(body["f"], body["b"])

        self._mutate(body, lambda p, d, m: edit_card(p, d, m, cid, f, b), True)

    def add(self, body):
        """Add a card handler"""
        f, b = clean_pair(body["f"], body["b"])
        tags = body.get("tags", "")

        if not isinstance(tags, str):
            raise ValueError("invalid fields")

        self._mutate(body, lambda p, d, m: add_card(p, d, m, f, b, split_tags(tags)), True)

    def delete(self, body):
        """Delete a card handler"""
        cid = body["id"]

        if not isinstance(cid, str):
            raise ValueError("invalid fields")

        self._mutate(body, lambda p, d, m: delete_card(p, d, m, cid), False)


def main():
    global DATA, STATE, AUTH, HOST, PORT, TLS_ENABLED, SETUP_CODE

    sys.stdout.reconfigure(line_buffering=True)   # under systemd stdout is a pipe: show the setup code immediately
    os.umask(0o077)    # decks, backups and trash are private to this user, whatever the shell's umask

    ap = argparse.ArgumentParser(description="Recto: local flashcards, zero dependencies")
    ap.add_argument("--data", help="decks folder (default: ./data)")
    ap.add_argument("--host", help="listen interface (default: 127.0.0.1)")
    ap.add_argument("--port", type=int, help="port (default: 8787)")
    ap.add_argument("--cert", required=True, help="TLS certificate file (PEM), required")
    ap.add_argument("--key", required=True, help="TLS private key file (PEM), required")
    ap.add_argument("--version", action="version", version=f"Recto {VERSION}")
    a = ap.parse_args()

    if a.data:
        DATA = Path(a.data).resolve()
        STATE = DATA / ".ratings.json"
        AUTH = DATA / ".auth"

    HOST = a.host or HOST
    if a.port is not None:
        PORT = _port(a.port)

    cert_path = Path(a.cert).expanduser().resolve()
    key_path = Path(a.key).expanduser().resolve()
    if not cert_path.is_file() or not key_path.is_file():
        sys.exit(f"certificate or key not found: {cert_path} / {key_path}")

    DATA.mkdir(parents=True, exist_ok=True, mode=0o700)

    jan = cleanup_old_files()
    if any(jan.values()):
        print(f"Cleanup: removed {jan} (older than a week).")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(str(cert_path), str(key_path))   # before binding: a bad key fails cleanly

    scheme = "https"
    shown = f"[{HOST}]" if ":" in HOST else HOST
    print(f"Recto {VERSION} -> {scheme}://{shown}:{PORT}  (data: {DATA})")

    if not auth_configured():
        SETUP_CODE = secrets.token_urlsafe(9)
        print(f"No passphrase set yet. Open the web UI and enter this one-time setup code: {SETUP_CODE}")

    elif load_auth() is None:
        print(f"WARNING: {AUTH} exists but is unreadable or corrupt: logins are refused. "
              "Restore it, or delete it to run the first-run setup again.", file=sys.stderr)

    if HOST not in ("127.0.0.1", "localhost", "::1"):
        print("WARNING: listening beyond localhost. Access is protected by passphrase, "
              "but still restrict the port at the network level (see README).", file=sys.stderr)

    print("TLS enabled (self-signed certificates are fine for personal use).")
    print("Press Ctrl+C to stop.")

    class Server(ThreadingHTTPServer):
        address_family = socket.AF_INET6 if ":" in HOST else socket.AF_INET
        slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

        def process_request(self, request, client_address):
            if not self.slots.acquire(blocking=False):    # too many open connections: drop this one
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except BaseException:
                self.slots.release()
                raise

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()

        def get_request(self):    # Wrapping the LISTENING socket runs every TLS handshake inside accept(), in the main loop and with no timeout: one idle TCP connection would freeze the whole server.
            # Wrap each accepted socket instead: the handshake happens lazily on the first read, in the handler thread, under Handler.timeout.
            sock, addr = self.socket.accept()
            sock.settimeout(Handler.timeout)
            return ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr

        def handle_error(self, request, client_address):
            if isinstance(sys.exc_info()[1], (ssl.SSLError, ConnectionError, TimeoutError)):
                return   # scanners, plain-HTTP clients, failed or stalled handshakes: no traceback needed
            super().handle_error(request, client_address)

    httpd = Server((HOST, PORT), Handler)
    TLS_ENABLED = True

    def _janitor():
        """Hourly cleanup of trash/backups/quarantines older than a week."""
        while True:
            time.sleep(CLEANUP_INTERVAL)
            try:
                removed = cleanup_old_files()
                if any(removed.values()):
                    print(f"Cleanup: removed {removed} (older than a week).")
            except Exception:
                traceback.print_exc()

    threading.Thread(target=_janitor, daemon=True, name="recto-janitor").start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
