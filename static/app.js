// app.js
// Copyright (C) 2026 Francesco Scolz
// License: AGPL-3.0 (see LICENSE)

// Recto: frontend. Vanilla JS, no build step. The Markdown editor and renderer come from editor.js
// (a prebuilt bundle, source in editor-src/) as window.RectoEditor.
// Two views: home (deck tree) and study (one deck or folder), switched by the URL hash.


const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g,    // escaper
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Deck ids are slash-separated paths: encode each segment, keep the slashes.
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const dec = p => p.split('/').map(decodeURIComponent).join('/');

let authenticated = false;
let setupMode = false;    // true -> first-run passphrase creation

async function api(url, opts) {    // api caller function
  const r = await fetch(url, {credentials: 'same-origin', ...opts});
  if (r.status === 401) {
    showLogin(false);
    const err = new Error('authentication required');
    err.status = 401;
    throw err;
  }
  if (!r.ok) {
    let m = r.status;
    try { m = (await r.json()).error || m; } catch(e) {}
    const err = new Error(m);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

const post = (url, body) => api(url, {    // POST request creator
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body)
});


// ---------- auth (all web UI: first-run setup + unlock every session) ----------

function showLogin(isSetup) {    // function to display form
  authenticated = false;
  setupMode = !!isSetup;

  // Locked: drop deck data from memory and DOM (shared browser, back button)
  // pend (ratings not synced yet) survives a session expiry on purpose: they go out after the next unlock. Logout clears it.
  all = []; queue = []; deckIds = []; i = 0; flip = false; hist = []; path = ''; editing = null;
  edTok++; unmountEditors();   // card text must not stay in a live editor of a locked session
  $('#efr').value = $('#ebr').value = '';
  ['#tree', '#card', '#progbar', '#fsub', '#ftag .ms-list', '#edeck', '#ef', '#eb', '#stats', '#title', '#pos', '#trash-list']
    .forEach(s => $(s).replaceChildren());
  $('#etags').value = '';
  $('#dlg-title').textContent = $('#dlg-msg').textContent = $('#dlg-input').value = '';   // deck names must not linger in hidden dialogs
  $('#toast').textContent = '';
  menuTarget = null; importParent = '';

  document.title = 'Recto';   // the deck name must not stay in the tab title of a locked session
  $('#login').hidden = false;
  $('#home').hidden = true;
  $('#study').hidden = true;

  const edit = $('#edit');
  if (edit) edit.hidden = true;

  const dlg = $('#dlg');
  if (dlg) dlg.hidden = true;

  const menu = $('#menu');
  if (menu) menu.hidden = true;
  $('#trash').hidden = true;

  $('#login-title').textContent = 'Recto';
  $('#login-hint').textContent = setupMode
    ? 'Create a passphrase to protect this instance (min 8 characters)'
    : 'Enter the passphrase to unlock';
  $('#login-pw2').hidden = !setupMode;
  $('#login-pw2').required = setupMode;
  $('#login-code').hidden = !setupMode;
  $('#login-code').required = setupMode;
  $('#login-code').value = '';
  $('#login-pw').autocomplete = setupMode ? 'new-password' : 'current-password';
  $('#login-pw2').autocomplete = 'new-password';
  $('#login-pw').minLength = setupMode ? 8 : 1;
  $('#login-btn').textContent = setupMode ? 'Create & unlock' : 'Unlock';
  $('#login-msg').textContent = '';
  $('#login-pw').value = '';
  $('#login-pw2').value = '';
  $('#login-btn').disabled = false;
  setTimeout(() => (setupMode ? $('#login-code') : $('#login-pw')).focus(), 50);
}

function showApp() { // self-explicative
  authenticated = true;
  setupMode = false;
  $('#login').hidden = true;
  $('#login-pw').value = $('#login-pw2').value = $('#login-code').value = '';   // no passphrase left in the DOM
}

async function tryAuth(e) { // try creating passphase / authenticating with passphrase
  if (e) e.preventDefault();
  const pw = $('#login-pw').value;
  if (!pw) return;

  if (setupMode) {
    const pw2 = $('#login-pw2').value;
    if (pw.length < 8) {
      $('#login-msg').textContent = 'Passphrase too short (min 8 characters)';
      return;
    }
    if (pw !== pw2) {
      $('#login-msg').textContent = 'Passphrases do not match';
      $('#login-pw2').select();
      return;
    }
    if (!$('#login-code').value.trim()) {
      $('#login-msg').textContent = 'Enter the setup code printed by the server';
      $('#login-code').focus();
      return;
    }
  }

  $('#login-btn').disabled = true;
  $('#login-msg').textContent = setupMode ? 'Creating…' : 'Checking…';

  try{
    const url = setupMode ? 'api/setup' : 'api/login';
    const body = setupMode
      ? {passphrase: pw, confirm: $('#login-pw2').value, code: $('#login-code').value.trim()}
      : {passphrase: pw};

    const r = await fetch(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'same-origin',
      body: JSON.stringify(body)
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data.setup_needed) {
        showLogin(true);
        return;
      }
      if (setupMode && r.status === 409) {   // someone (or another tab) already completed the setup
        showLogin(false);
        return;
      }
      $('#login-msg').textContent = data.error || (setupMode ? 'Setup failed' : 'Wrong passphrase');
      $('#login-btn').disabled = false;
      $('#login-pw').select();
      return;
    }

    if (data.version) $('#version').textContent = `v${data.version}`;   // /api/health hides it until a session exists
    showApp();
    route();

  } catch(err) {
    $('#login-msg').textContent = 'Network error';
    $('#login-btn').disabled = false;
  }
}

$('#login-form').onsubmit = tryAuth;

$('#logout').onclick = async () => {
  if (pend.size && !await flush() && !await ask({
    title: 'Log out anyway?', message: 'Some ratings could not be synced and will be lost.', ok: 'Log out', danger: true
  })) return;

  let ok = false;
  try{
    ok = (await fetch('api/logout', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'same-origin',
      body: '{}'
    })).ok;
  }catch(e) {}
  pend.clear();
  showLogin(false);
  // The toast sits below the login overlay, so the warning goes in the login message line
  if (!ok) $('#login-msg').textContent = 'Logout not confirmed by the server: the session may still be active (24 h max)';
};

async function boot() { // boot service by checking health and showing either login screen or webUI
  try {
    const r = await fetch('api/health', { credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {   // e.g. 403 "host not allowed": say so instead of showing a login that can never work
      showLogin(false);
      $('#login-msg').textContent = data.error || ('Server error ' + r.status);
      return;
    }

    if (data.version) $('#version').textContent = `v${data.version}`;

    if (data.setup_needed) {
      showLogin(true);
    } else if (data.auth) {
      showApp();
      route();
    } else {
      showLogin(false);
    }

  } catch(e) {
    showLogin(false);
  }
}


// ---------- dialog and toast ----------

// In-app replacement for confirm()/prompt(). Resolves to true/false, or to the
// input value / null when `input` is set.
function ask({title = '', message = '', input = false, value = '',
              ok = 'OK', cancel = 'Cancel', danger = false}) { // In-app replacement for confirm()/prompt(). Resolves to true/false, or to the input value / null when `input` is set.
  return new Promise(resolve => {
    const d = $('#dlg'), inp = $('#dlg-input'),
          okb = $('#dlg-ok'), cb = $('#dlg-cancel'),
          prev = document.activeElement;

    // textContent, never innerHTML: deck names must not be parsed as HTML
    $('#dlg-title').textContent = title;
    $('#dlg-msg').textContent = message;
    $('#dlg-msg').hidden = !message;

    inp.hidden = !input;
    inp.value = value;
    okb.textContent = ok;
    cb.textContent = cancel;
    okb.classList.toggle('danger', danger);
    d.hidden = false;

    (input ? inp : (danger ? cb : okb)).focus();   // destructive dialogs focus "Cancel" first
    if (input) inp.select();

    const done = v => {
      d.hidden = true;
      d.onkeydown = d.onmousedown = okb.onclick = cb.onclick = null;
      prev && prev.focus && prev.focus();
      resolve(v);
    };

    okb.onclick = () => done(input ? inp.value : true);
    cb.onclick = () => done(input ? null : false);
    d.onmousedown = e => { if (e.target === d) cb.onclick(); };   // backdrop click = cancel

    d.onkeydown = e => {
      e.stopPropagation();   // keep global shortcuts (1/2/3, Space, E, Esc) out of the dialog
      if (e.key === 'Escape') { e.preventDefault(); cb.onclick(); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); okb.onclick(); }
    };
  });
}

// notification handling
let toastTimer;
const toast = (m, err = true) => { // show a notification
  const t = $('#toast');
  t.textContent = m;
  t.classList.toggle('err', err);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.textContent = ''; t.classList.remove('err'); }, 4000);
};

const loading = on => { $('#loading').hidden = !on; };


// ---------- home ----------

// cards divided by rating
const cn = c => `
  <span class="cn">
    <b class="b">${c.bad}</b>
    <b class="o">${c.ok}</b>
    <b class="g">${c.good}</b>
    <b>${c.new}</b>
  </span>`;

const countLeaves = n => n.deck ? 1 : n.children.reduce((s, c) => s + countLeaves(c), 0);

// The gear button carries everything the menu actions need in data-* attributes.
const gear = n => `<button class="gear" aria-label="Options for ${esc(n.name)}" aria-haspopup="menu"
  data-path="${esc(n.path)}" data-name="${esc(n.name)}" data-kind="${n.deck ? 'deck' : 'folder'}"
  data-rated="${n.counts.total - n.counts.new}" data-cards="${n.counts.total}"
  data-decks="${countLeaves(n)}">⚙︎</button>`;

function node(n) { // create a node of the tree (subdeck)
  const link = `<a href="#${enc(n.path)}">${esc(n.name)}</a>`;
  const row = link + cn(n.counts) + gear(n);

  if (n.deck) return `<div class="leaf">${row}</div>`;

  return `
    <details>
      <summary>${row}</summary>
      <div class="sub">
        ${n.children.map(node).join('') || '<div class="mut leaf">empty</div>'}
      </div>
    </details>`;
}

// Re-render the tree, keeping the folders that were open.
async function home() {    // get back to home
  const open = new Set(
    [...document.querySelectorAll('#tree details[open]')]
      .map(d => d.querySelector('a').getAttribute('href'))
  );
  await renderHome();
  document.querySelectorAll('#tree details').forEach(d => {
    if (open.has(d.querySelector('a').getAttribute('href'))) d.open = true;
  });
}

async function renderHome() {    // render home screen
  const tok = ++nav;   // abandon any study() request still in flight (and any older renderHome)
  $('#study').hidden = true;
  $('#home').hidden = false;
  document.title = 'Recto';
  loading(true);

  try {
    await flush();   // ratings made while studying reach the server before the counts are read
    if (tok !== nav) return;
    const t = await api('api/tree');
    if (tok !== nav) return;   // the user already moved to another view
    $('#tree').innerHTML = t.children.map(node).join('') ||
      '<p class="mut">No decks yet: use + above, or put folders and CSV files in the data folder.</p>';
  } catch(e) {
    if (tok !== nav) return;
    $('#tree').innerHTML = '<p class="b">Error: ' + esc(e.message) + '</p>';
  } finally {
    if (tok === nav) loading(false);
  }
}


// ---------- study ----------

let all = [];        // every card under the current path
let deckIds = [];    // every deck under the current path, empty ones included
let queue = [];      // cards matching the current filters, in study order
let i = 0;           // position in queue
let flip = false;    // showing the back?
let hist = [];       // positions already visited, for the Back button
let path = '';

let nav = 0;   // navigation counter: a slow response for a view we already left must be ignored

async function study(p) {    // go to study page for a subdeck
  const tok = ++nav;
  path = p;
  $('#home').hidden = true;
  $('#study').hidden = false;
  $('#title').textContent = p.split('/').join(' › ');
  document.title = (p.split('/').pop() || 'Recto') + ' · Recto';
  loading(true);

  try {
    await flush();   // pending ratings reach the server before the cards are read back
    if (tok !== nav) return;
    const res = await api('api/cards?path=' + encodeURIComponent(p));
    if (tok !== nav) return;
    adopt(res.cards);
    deckIds = res.decks;
  } catch(e) {
    if (tok !== nav) return;
    all = [];
    deckIds = [];
    toast(e.message);
  } finally {
    if (tok === nav) loading(false);
  }

  // Subdeck labels are shown relative to the current folder.
  $('#fsub').innerHTML = '<option value="">All subdecks</option>' +
    deckIds.map(d => {
      const label = d.slice(p.length ? p.length + 1 : 0) || d.split('/').pop();
      return `<option value="${esc(d)}">${esc(label)}</option>`;
    }).join('');
  $('#fsub').hidden = deckIds.length < 2;

  // Multi-select filters: checkboxes built with the DOM API (tag text never goes through innerHTML)
  const tags = [...new Set(all.flatMap(c => c.t))].sort();
  $('#ftag .ms-list').replaceChildren(...tags.map(t => {
    const l = document.createElement('label'), cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = t;
    l.append(cb, ' ' + t);
    return l;
  }));
  $('#ftag').hidden = !tags.length;
  $('#frating').querySelectorAll('input').forEach(cb => cb.checked = false);
  build();
}

// Multi-select dropdowns: no box ticked = no filter; ticked boxes combine with OR (any selected rating / any selected tag).
const ticked = id => [...document.querySelectorAll(id + ' input:checked')].map(cb => cb.value);

function msLabel(id, none) {   // summary text = ticked options, or the "all" label
  const v = [...document.querySelectorAll(id + ' input:checked')].map(cb => cb.parentElement.textContent.trim());
  $(id + ' summary').textContent = v.length ? v.join(', ') : none;
}

// Predicate for the current filters. Evaluated against each card's CURRENT rating, so it can be re-run after a rating change.
function matcher() {
  const fs = $('#fsub').value, fr = ticked('#frating'), ft = ticked('#ftag');
  return c =>
    (!fs || c.deck == fs) &&
    (!fr.length || fr.includes(c.r || 'new')) &&
    (!ft.length || c.t.some(t => ft.includes(t)));
}

function build() { // rebuild the queue from the filters and restart from the first card.
  queue = all.filter(matcher());
  msLabel('#frating', 'All ratings');
  msLabel('#ftag', 'All tags');

  i = 0;
  flip = false;
  hist = [];
  show();
}

function show() {    // show and update study UI
  const n = k => all.filter(c => k == null ? !c.r : c.r == k).length;
  const ng = n('good'), no = n('ok'), nb = n('bad'), nw = all.length - ng - no - nb;

  // card rating stats
  $('#stats').innerHTML = `
    <span class="b">${nb}</span> ·
    <span class="o">${no}</span> ·
    <span class="g">${ng}</span> ·
    <span>${nw}</span>
    `;

  const c = queue[i];

  $('#rate').hidden = !c || !flip;
  $('#prev').disabled = !hist.length;
  $('#skip').disabled = !c;
  $('#editbtn').disabled = !c;
  $('#delbtn').disabled = !c;

  // Rating distribution bar. Skipping a card does not rate it: it stays in the grey segment. Widths are set through the CSSOM
  $('#prog').hidden = !all.length;
  $('#progbar').replaceChildren(...[[ng, 'g'], [no, 'o'], [nb, 'b'], [nw, 'n']]
    .filter(([k]) => k)
    .map(([k, cls]) => {
      const d = document.createElement('div');
      d.className = cls;
      d.style.width = (k / all.length * 100) + '%';
      return d;
    }));

  // Live count: cards matching the filters right now (a card just rated stops matching, e.g. rating filter "Bad" -> 8/20 becomes 7/20),
  // while the queue keeps it so Previous still works.
  const sel = all.filter(matcher()).length;
  $('#pos').textContent = `${sel} / ${all.length} selected`;
  if (!c) {
    const msg = !all.length ? 'No cards'
              : !sel ? (queue.length ? 'Done: no card matches these filters any more' : 'No cards match these filters')
              : 'End of queue — press Shuffle to start over';
    $('#card').innerHTML = `<div class="content mut">${msg}</div>`;
    return;
  }

  // Rating of the card on screen, always shown (word as well as colour); its tags follow, if any
  const [cls, label] = {good: ['g', 'Good'], ok: ['o', 'Ok'], bad: ['b', 'Bad']}[c.r] || ['n', 'Unrated'];
  const tags = `<small class="meta"><span class="${cls}">● ${label}</span>` +
    (c.t.length ? ` · [${c.t.map(esc).join(' · ')}]` : '') + '</small>';

  // Markdown -> sanitised HTML (see editor-src/editor.js); rendered inside its own element, apart from the tags line.
  const box = document.createElement('div');
  box.className = 'content';
  box.innerHTML = RectoEditor.render(flip ? c.b : c.f);
  $('#card').replaceChildren(box);
  $('#card').insertAdjacentHTML('beforeend', tags);
}

// ---------- local ratings and sync ----------

// Rating a card only touches memory. The server hears about it later, in ONE request: when the study view is left
// (home, another deck, logout, editing or deleting a card) or when Sync is pressed. The server merges per card
// (latest time wins) and answers with the ratings it kept, which applyUpdates() adopts.
// Only decks rated since the last push are sent, each with every rating the client holds for it.
const pend = new Map();   // deck id -> {r: {card id: [rating, unix time]}, n: ratings made since the last push}
let chain = Promise.resolve();   // pushes run one after the other
let pushing = false;

const unsynced = () => [...pend.values()].reduce((sum, d) => sum + d.n, 0);

function syncUI() {   // Sync button (study view) and warning banner (home)
  const n = unsynced();
  $('#syncbtn').textContent = pushing ? 'Syncing…' : n ? `Sync (${n})` : 'Synced';
  $('#syncbtn').disabled = pushing || !n;
  $('#homesync').hidden = !n;
  $('#homesyncmsg').textContent = `${n} rating(s) not synced yet`;
}

function noteRating(c) {   // c.r and c.ts are already set
  let d = pend.get(c.deck);
  if (!d) {   // first rating in this deck since the last push: start from every rating the client holds for it
    d = {r: {}, n: 0};
    all.forEach(x => { if (x.deck === c.deck && x.r) d.r[x.id] = [x.r, x.ts || 0]; });
    pend.set(c.deck, d);
  }
  d.r[c.id] = [c.r, c.ts];
  d.n++;
  syncUI();
}

// The server merges per card (latest time wins): adopt the ratings it kept instead of ours, e.g. a card
// rated on another device after this page loaded, or a deck reset elsewhere (null = no rating).
function applyUpdates(updates, posted) {
  if (!updates) return;
  let n = 0;
  for (const [deck, cards] of Object.entries(updates)) {
    const cur = pend.get(deck);
    for (const [id, v] of Object.entries(cards)) {
      const mine = cur && cur.r[id], was = posted[deck] && posted[deck][id];
      if (mine && (!was || mine[0] !== was[0] || mine[1] !== was[1])) continue;   // rated again while the request was in flight
      const c = all.find(x => x.deck === deck && x.id === id);
      if (!c) continue;
      c.r = v ? v[0] : null;
      c.ts = v ? v[1] : null;
      if (cur) { if (v) cur.r[id] = [v[0], v[1]]; else delete cur.r[id]; }
      n++;
    }
  }
  if (n) { syncUI(); if (!$('#study').hidden) show(); }
}

async function push(keepalive) {   // resolves to true when nothing is left pending
  if (!pend.size) return true;
  const sent = new Map([...pend].map(([k, d]) => [k, d.n]));
  const decks = Object.fromEntries([...pend].map(([k, d]) => [k, d.r]));
  pushing = true;
  syncUI();

  try {
    const body = JSON.stringify({decks});
    // Browsers reject keepalive requests whose body exceeds 64 KiB: past ~60 KB send a normal request instead.
    const small = new TextEncoder().encode(body).length < 60000;
    const res = await api('api/sync', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body,
      keepalive: keepalive && small
    });
    for (const [k, n] of sent) {   // ratings made while the request was in flight stay pending
      const d = pend.get(k);
      if (!d) continue;
      d.n -= n;
      if (d.n <= 0) pend.delete(k);
    }
    if (res.skipped.length) toast('Not synced, deck no longer exists: ' + res.skipped.join(', '));
    applyUpdates(res.updates, JSON.parse(body).decks);
    return true;
  } catch(e) {
    if (e.status !== 401) toast('Sync failed: ' + e.message + '. Ratings are kept, press Sync to retry.');
    return false;
  } finally {
    pushing = false;
    syncUI();
  }
}

const flush = keepalive => (chain = chain.then(() => push(keepalive)));

// Cards come from the server, but ratings still waiting to be pushed win over what it sent.
function adopt(cards) {
  cards.forEach(c => {
    const x = pend.get(c.deck)?.r[c.id];
    if (x && x[1] >= (c.ts || 0)) { c.r = x[0]; c.ts = x[1]; }   // a pending rating wins over an older server copy
  });
  all = cards;
}

function rate(r) {    // handle card rating (memory only, see above)
  const c = queue[i];
  if (!c) return;

  c.r = r;
  c.ts = Math.floor(Date.now() / 1000);
  noteRating(c);

  hist.push(i);
  i++;
  flip = false;
  show();
}

$('#syncbtn').onclick = async () => { if (await flush()) toast('Synced', false); };
$('#homesyncbtn').onclick = async () => { if (await flush()) { toast('Synced', false); home(); } };

// Safety nets: a hidden tab (phone app switch) pushes right away, a closing tab asks first, a reconnect retries.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState == 'hidden' && pend.size) flush(true);
});
addEventListener('beforeunload', e => {
  if (pend.size) { e.preventDefault(); e.returnValue = ''; }
});
addEventListener('online', () => { if (pend.size) flush(); });


// ---------- controls ----------

$('#card').onclick = e => {    // flip card on click
  if (e.target.closest('a')) return;    // following a link must not flip the card
  if (String(getSelection())) return;   // text selected: don't flip
  if (queue[i]) { flip = !flip; show(); }
};

document.querySelectorAll('[data-r]').forEach(b => b.onclick = () => rate(b.dataset.r));

$('#skip').onclick = () => {    // skip card with button
  if (i < queue.length) {
    hist.push(i);
    i++;
    flip = false;
    show();
  }
};

$('#prev').onclick = () => {    // go to previous card with button
  if (hist.length) {
    i = hist.pop();
    flip = false;
    show();
  }
};

// Shuffle restarts from the cards that match the filters NOW: a card rated since the queue was built
// (e.g. filter "Bad", rated Good) must not come back. With nothing left it shows the empty message.
$('#shuf').onclick = () => {
  queue = all.filter(matcher());
  for(let k = queue.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [queue[k], queue[j]] = [queue[j], queue[k]];
  }

  i = 0;
  flip = false;
  hist = [];
  show();
};

['#fsub', '#frating', '#ftag'].forEach(s => $(s).onchange = build);   // change bubbles up from the checkboxes

// Close an open filter dropdown on outside click or Esc
document.addEventListener('click', e => {
  document.querySelectorAll('.ms[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
});
document.addEventListener('keydown', e => {
  if (e.key == 'Escape') document.querySelectorAll('.ms[open]').forEach(d => { d.open = false; });
});

$('#homebtn').onclick = () => { location.hash = ''; };


// ---------- keyboard ----------

document.addEventListener('keydown', e => {
  // Ignore shortcuts outside the study view, while the editor is open, or on focused controls
  if ($('#study').hidden || !$('#edit').hidden || !$('#dlg').hidden || /^(SELECT|INPUT|TEXTAREA|SUMMARY)$/.test(e.target.tagName)) return;
  // A button keeps focus after a mouse click and would swallow Space/Enter: only a button focused with the
  // keyboard (Tab) keeps its own behaviour, one focused by a click is blurred so the shortcut works.
  if (e.target.tagName == 'BUTTON') {
    if (e.target.matches(':focus-visible')) return;
    e.target.blur();
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;   // Ctrl/Alt+1..3 switch browser tabs, Ctrl+E is the search bar

  // keymap to actions
  if (e.key == ' ' || e.key == 'Enter') {
    e.preventDefault();
    $('#card').click();
  } else if (e.key == 'e' || e.key == 'E') {
    e.preventDefault();
    openEdit();
  } else if (e.key == 'ArrowRight') {
    $('#skip').click();
  } else if (e.key == 'ArrowLeft') {
    $('#prev').click();
  } else if (flip) {  // ratings only make sense once the back is visible
    const m = {'1': 'bad', '2': 'ok', '3': 'good'}[e.key];
    if (m) rate(m);
  }
});


// ---------- card editor (Markdown WYSIWYG) ----------

let editing = null;   // card being edited (null in add mode)
let mode = 'edit';    // 'edit' | 'add'
let view = 'raw';     // 'raw' (Markdown source in textareas, the default) | 'rendered' (WYSIWYG editors)
let eds = {f: null, b: null};   // live WYSIWYG editors (front, back); only exist in rendered view
let base = ['', ''];            // Markdown when the dialog opened, to detect unsaved changes
let loaded = ['', ''];          // what the editors showed right after loading (their normalised form of the source)
let loadedSrc = ['', ''];       // the Markdown the editors were started from
let edTok = 0;                  // bumped on every open/close/switch: a slow editor start must not outlive its dialog

function unmountEditors() {
  [eds.f, eds.b].forEach(e => e && e.destroy());
  eds = {f: null, b: null};
  $('#ef').replaceChildren();
  $('#eb').replaceChildren();
}

// Images are shrunk before upload (phone photos are several MB): long side at most 1600px, JPEG/PNG only.
async function shrink(file, max = 1600) {
  if (file.size <= 1.5e6 || !/^image\/(png|jpeg)$/.test(file.type)) return file;
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = await new Promise(res => c.toBlob(res, file.type, 0.85));
  return out && out.size < file.size ? out : file;
}

// Upload handler for the editor: stores the image on the server and returns the path saved in the card.
async function uploadImage(file) {
  try {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) throw new Error('use PNG, JPEG, GIF or WebP');
    const blob = await shrink(file);
    const data = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',', 2)[1]);
      r.onerror = () => rej(new Error('cannot read the file'));
      r.readAsDataURL(blob);
    });
    return (await post('api/media', {data})).path;
  } catch(e) {
    toast('Image upload failed: ' + e.message);
    throw e;
  }
}

const norm = s => s.replace(/\r\n?/g, '\n').trim();

// Current Markdown of both fields, whichever view is showing.
const getMd = () => view == 'raw'
  ? [norm($('#efr').value), norm($('#ebr').value)]
  : [eds.f && eds.f.getMarkdown(), eds.b && eds.b.getMarkdown()];

function showView(v) {    // show the textareas (raw) or the editors (rendered); the button names the OTHER view
  view = v;
  const raw = v == 'raw';
  $('#efr').hidden = $('#ebr').hidden = !raw;
  $('#ef').hidden = $('#eb').hidden = raw;
  $('#emode').textContent = raw ? 'Rendered' : 'Raw';
}

// Current Markdown of both fields. In rendered view a field left untouched returns the source it was
// started from, not the editor's normalised form: otherwise saving would rewrite it (and change the card id).
function currentMd() {
  const now = getMd();
  if (view != 'rendered') return now;
  return now.map((v, k) => v === loaded[k] ? loadedSrc[k] : v);
}

async function switchView() {
  if (switching) return;
  switching = true;
  $('#emode').disabled = true;
  const tok = ++edTok;

  try {
    if (view == 'raw') {    // raw -> rendered: start the WYSIWYG editors on the source
      const src = [norm($('#efr').value), norm($('#ebr').value)];
      const make = (el, value, hint) => RectoEditor.create(el, {value, placeholder: hint, onUpload: uploadImage});
      showView('rendered');
      let made;
      try {
        made = await Promise.all([make($('#ef'), src[0], 'Front'), make($('#eb'), src[1], 'Back')]);
      } catch(e) {
        unmountEditors();
        showView('raw');
        toast('Cannot start the rendered editor: ' + e.message);
        return;
      }
      if (tok !== edTok) { made.forEach(e => e.destroy()); return; }   // dialog closed meanwhile
      [eds.f, eds.b] = made;
      loaded = [made[0].getMarkdown(), made[1].getMarkdown()];
      loadedSrc = src;
      eds.f.focus();
    } else {    // rendered -> raw: a field left untouched keeps its original text (the editor would normalise it)
      const now = getMd();
      [['#efr', 0], ['#ebr', 1]].forEach(([sel, k]) => {
        if (now[k] !== loaded[k]) $(sel).value = now[k];
      });
      unmountEditors();
      showView('raw');
      $('#efr').focus();
    }
  } finally {
    switching = false;
    $('#emode').disabled = false;
  }
}

let switching = false;

function openDialog(f, b) {    // the editor always opens on the Markdown source
  edTok++;
  unmountEditors();
  $('#efr').value = f;
  $('#ebr').value = b;
  base = [norm(f), norm(b)];
  showView('raw');
  $('#emsg').textContent = '';
  $('#edit').hidden = false;
  $('#efr').focus();
}

function openEdit() {    // self-explicative
  const c = queue[i];
  if (!c) return;

  mode = 'edit';
  editing = c;
  $('#etitle').textContent = 'Edit card';
  $('#edeck').hidden = true;
  $('#etags').hidden = true;
  openDialog(c.f, c.b);
}

function openAdd() {    // self-explicative
  if (!deckIds.length) {   // an empty folder has no CSV to add to: the server would answer 404
    toast('No subdeck here yet: use the gear on the home page (New subdeck) or import a CSV.');
    return;
  }
  const list = deckIds;

  mode = 'add';
  editing = null;
  $('#etitle').textContent = 'New card';

  // Preselect the subdeck being filtered, else the deck of the current card
  $('#edeck').innerHTML = list.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  $('#edeck').value = $('#fsub').value || (queue[i] && queue[i].deck) || list[0];
  $('#edeck').hidden = list.length < 2;
  $('#etags').value = '';
  $('#etags').hidden = false;
  openDialog('', '');
}

function closeEdit() {    // self-explicative
  edTok++;
  unmountEditors();
  $('#efr').value = $('#ebr').value = '';
  $('#edit').hidden = true;
  editing = null;
}

// Cancel / Esc: with unsaved changes ask first, rich content is costly to lose.
async function cancelEdit() {
  const now = currentMd();
  if (now[0] !== base[0] || now[1] !== base[1]) {
    if (!await ask({title: 'Discard changes?', message: 'The card has unsaved changes.', ok: 'Discard', danger: true})) return;
  }
  closeEdit();
}

async function reload(key) {    // Re-fetch cards after a change and try to stay on the card identified by key ("deck|id") if still present.
  adopt((await api('api/cards?path=' + encodeURIComponent(path))).cards);
  build();
  const k = queue.findIndex(c => c.deck + '|' + c.id == key);
  if (k >= 0) { i = k; show(); }
}

let saving = false;   // a double click / double Ctrl+Enter must not add the card twice

async function saveEdit() {    // save an edited card
  if (saving) return;
  const add = mode == 'add';
  const c = editing;
  if (!add && !c) return;
  if (switching) return;   // editors still starting

  const [f, b] = currentMd();
  if (!f || !b) {
    $('#emsg').textContent = 'Front and back cannot be empty';
    return;
  }

  if (!add && f === base[0] && b === base[1]) {   // untouched: no write, so the card id (and its rating) cannot change
    closeEdit();
    return;
  }

  const deck = add ? ($('#edeck').value || path) : c.deck;

  saving = true;
  $('#esave').disabled = true;
  let r, err = null;
  try {
    // Editing moves a card's rating to its new id on the server: the server must hold our ratings first.
    if (!await flush()) throw new Error('sync the pending ratings first (Sync button)');
    r = await (add
      ? post('api/card/add', {deck, f, b, tags: $('#etags').value})
      : post('api/card', {deck, id: c.id, f, b}));
  } catch(e) {
    err = e;
  }
  saving = false;
  $('#esave').disabled = false;

  if (err) {
    $('#emsg').textContent = 'Save failed: ' + err.message;
    return;
  }

  closeEdit();

  try {
    if (add) {
      await study(path);   // also refreshes the subdeck list
      const k = queue.findIndex(x => x.deck + '|' + x.id == deck + '|' + r.id);
      if (k >= 0) { i = k; show(); }
    } else {
      await reload(deck + '|' + r.id);
    }
  } catch(e) {   // the card IS saved: do not report a failure
    toast('Saved, but the list could not be refreshed: ' + e.message);
    return;
  }

  toast(add ? 'Card added' : 'Saved', false);
}

// button mappings
$('#editbtn').onclick = openEdit;
$('#addbtn').onclick = openAdd;
$('#emode').onclick = switchView;
$('#esave').onclick = saveEdit;
$('#ecancel').onclick = cancelEdit;
$('#etags').onkeydown = e => {
  if (e.key == 'Enter') { e.preventDefault(); saveEdit(); }
};
$('#delbtn').onclick = async () => {
  const c = queue[i];
  if (!c) return;

  const preview = c.f.slice(0, 200).split(/\s+/).join(' ').trim().slice(0, 60);

  if (!await ask({
    title: 'Delete this card?',
    message: '"' + preview + '"\n\nThe card goes to the trash (home page, Trash) and is removed for good after 7 days.',
    ok: 'Delete', danger: true
  })) return;

  try {
    if (!await flush()) throw new Error('sync the pending ratings first (Sync button)');
    await post('api/card/delete', {deck: c.deck, id: c.id});
  } catch(e) {
    toast('Delete failed: ' + e.message);
    return;
  }

  try {
    const keep = i;
    await reload(null);
    i = Math.min(keep, Math.max(queue.length - 1, 0));
    show();
    toast('Card deleted', false);
  } catch(e) {   // the card IS deleted: do not report a failure
    toast('Deleted, but the list could not be refreshed: ' + e.message);
  }
};

document.addEventListener('keydown', e => {
  if ($('#edit').hidden || !$('#dlg').hidden) return;
  if (e.key == 'Escape' && !e.defaultPrevented) cancelEdit();   // an editor popup (slash menu...) that used Esc leaves it alone
  else if (e.key == 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(); }
  else if (e.key == '/' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); switchView(); }
});


// ---------- deck options menu ----------

let menuTarget = null;   // the gear button the menu is open for

const closeMenu = () => {    // self-explicative
  $('#menu').hidden = true;
  menuTarget = null;
};

$('#tree').addEventListener('click', e => {    // listener to catch clicks on the tree structure
  const g = e.target.closest('.gear');
  if (!g) return;

  e.preventDefault();      // gears sit inside <summary>/<a> rows: don't toggle or navigate
  e.stopPropagation();

  if (menuTarget === g) { closeMenu(); return; }

  menuTarget = g;
  const r = g.getBoundingClientRect();
  const m = $('#menu');

  m.querySelectorAll('[data-for]').forEach(b => b.hidden = b.dataset.for != g.dataset.kind);
  m.hidden = false;
  m.style.top = (r.bottom + 4) + 'px';
  m.style.right = (document.documentElement.clientWidth - r.right) + 'px';
});

document.addEventListener('click', e => {
  if (!e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', e => {
  if (e.key == 'Escape') closeMenu();
});
addEventListener('scroll', closeMenu, true);

const menuAction = (id, fn) => {    // run a menu action: close the menu, then hand over the gear that opened it.
  $(id).onclick = async () => {
    const g = menuTarget;
    closeMenu();
    if (g) await fn(g);
  };
};

async function run(call, okMsg, failMsg) {    // wrap a server call: toast the outcome and refresh the home tree on success.
  try {
    if (!await flush()) throw new Error('sync the pending ratings first');   // a reset/rename/delete must not be undone by a late push
    await call();
    toast(okMsg, false);
    home();
  } catch(e) {
    toast(failMsg + ': ' + e.message);
  }
}

$('#newdeck').onclick = async () => {    // create new deck listener
  const name = await ask({title: 'New deck', message: 'Name of the new deck:', input: true, ok: 'Create'});
  if (!name || !name.trim()) return;
  run(() => post('api/deck/create', {parent: '', name: name.trim(), type: 'folder'}),
      'Deck created', 'Create failed');
};

menuAction('#m-sub', async g => {    // create new subdeck listener
  const name = await ask({title: 'New subdeck', message: 'In "' + g.dataset.name + '"', input: true, ok: 'Create'});
  if (!name || !name.trim()) return;
  run(() => post('api/deck/create', {parent: g.dataset.path, name: name.trim(), type: 'deck'}),
      'Subdeck created', 'Create failed');
});

// Import: the menu opens the hidden file picker; the chosen folder is remembered here.
let importParent = '';

menuAction('#m-import', g => {    // subdeck import listener
  importParent = g.dataset.path;
  $('#importfile').click();
});

const MAX_IMPORT = 10000000;   // same limit as the server (JSON body, in bytes, = 10MB)

$('#importfile').onchange = async e => {    // import handler
  const files = [...e.target.files];
  e.target.value = '';   // allow picking the same file again

  let ok = 0;
  const errs = [];

  for(const f of files) {
    try{
      if (f.size > MAX_IMPORT) throw new Error('file too large (limit 10 MB)');   // before reading it into memory
      const text = await f.text();
      if (text.includes('\uFFFD') && !await ask({title: 'Not UTF-8?', message: f.name + ' contains characters that could not be decoded (Excel often saves CSV as Windows-1252). Re-save it as "CSV UTF-8" or import anyway?', ok: 'Import anyway', danger: true})) {
        throw new Error('skipped: not valid UTF-8');
      }
      const body = {
        parent: importParent,
        name: f.name.replace(/\.[^.]+$/, ''),
        content: text
      };
      // The server refuses oversized bodies without reading them
      if (new Blob([JSON.stringify(body)]).size > MAX_IMPORT) throw new Error('file too large (limit 10 MB)');
      await post('api/import', body);
      ok++;
    } catch(err) {
      errs.push(f.name + ': ' + err.message);
    }
  }

  toast((ok ? 'Imported ' + ok + '. ' : '') + (errs.length ? 'Failed — ' + errs.join(' | ') : ''),
        errs.length > 0);
  home();
};

menuAction('#m-export', async g => {    // export handler
  const p = g.dataset.path;
  let r;
  try {
    r = await fetch('api/export?path=' + encodeURIComponent(p), {credentials: 'same-origin'});
  } catch(e) {
    toast('Export failed: network error');
    return;
  }
  if (!r.ok) {
    if (r.status === 401) { showLogin(false); return; }   // session expired: ask to unlock again
    let m = r.status;
    try { m = (await r.json()).error || m; } catch(e) {}
    toast('Export failed: ' + m);
    return;
  }
  // Filename from Content-Disposition (filename*=UTF-8''...), else the deck name.
  let name = p.split('/').pop() + '.csv';
  try {
    const disp = r.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename\*=UTF-8''([^;\s]+)/i);
    if (m) name = decodeURIComponent(m[1]);
  } catch(e) {}
  let blob;
  try {
    blob = await r.blob();
  } catch(e) {
    toast('Export failed: network error');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Exported', false);
});

menuAction('#m-delete', async g => {    // delete deck/subdeck handler
  const {path: p, name, kind, cards, decks} = g.dataset;
  const what = kind == 'folder' ? `${decks} subdeck(s), ${cards} card(s)` : `${cards} card(s)`;

  if (!await ask({
    title: `Delete "${name}"?`,
    message: `${what}\n\nIt is moved to the trash (Trash button on the home page) for 7 days before complete removal; restoring it brings its ratings back.`,
    ok: 'Delete', danger: true
  })) return;

  run(() => post('api/deck/delete', {path: p}), 'Moved to trash', 'Delete failed');
});

menuAction('#m-rename', async g => {    // rename deck/subdeck handler
  const {path: p, name} = g.dataset;
  const nn = await ask({title: 'Rename', message: '"' + name + '"', input: true, value: name, ok: 'Rename'});
  if (nn === null || !nn.trim() || nn.trim() === name) return;

  run(() => post('api/rename', {path: p, name: nn.trim()}), 'Renamed', 'Rename failed');
});

menuAction('#m-reset', async g => {    // reset deck/subdeck ratings handler
  const {path: p, name, rated} = g.dataset;

  if (!+rated) {
    toast('No progress to reset in "' + name + '"', false);
    return;
  }

  if (!await ask({
    title: `Reset progress for "${name}"?`,
    message: `${rated} rated card(s) will go back to "new". This cannot be undone.`,
    ok: 'Reset', danger: true
  })) return;

  run(() => post('api/reset', {path: p}), 'Progress reset', 'Reset failed');
});

// Hide logos if static/Logo.png is missing
document.querySelectorAll('.logo').forEach(el => {
  el.addEventListener('error', e => { e.target.hidden = true; });
  if (el.complete && !el.naturalWidth) el.hidden = true;
});


// ---------- trash ----------

const KIND = {deck: 'Subdeck', folder: 'Deck', card: 'Card', image: 'Image'};   // a CSV is a "subdeck" in the UI, a folder a "deck"

function trashRow(it) {   // built with the DOM API: names and card text never go through innerHTML
  const row = document.createElement('div');
  row.className = 'trow';

  if (it.kind == 'image') {
    const img = document.createElement('img');
    img.className = 'tthumb';
    img.loading = 'lazy';
    img.alt = '';
    img.src = 'api/trash/image?id=' + encodeURIComponent(it.id);
    row.append(img);
  }

  const title = document.createElement('div');
  title.className = 'ttitle';
  title.textContent = it.title || '(unnamed)';

  const bits = [KIND[it.kind]];
  if (it.where) bits.push('from ' + it.where.split('/').join(' › '));
  if (it.kind != 'card' && it.cards != null) bits.push(it.cards + ' card(s)');
  if (it.kind == 'folder' && it.decks != null) bits.push(it.decks + ' subdeck(s)');
  bits.push(new Date(it.ts * 1000).toLocaleString());
  const sub = document.createElement('div');
  sub.className = 'mut tsub';
  sub.textContent = bits.join(' · ');

  const txt = document.createElement('div');
  txt.className = 'ttxt';
  txt.append(title, sub);

  const b = document.createElement('button');
  b.textContent = 'Restore';
  b.onclick = () => restoreItem(it, b);

  row.append(txt, b);
  return row;
}

async function renderTrash() {
  const list = $('#trash-list');
  try {
    const {items} = await api('api/trash');
    const empty = document.createElement('p');
    empty.className = 'mut';
    empty.textContent = 'The trash is empty.';
    list.replaceChildren(...(items.length ? items.map(trashRow) : [empty]));
  } catch(e) {
    list.replaceChildren();
    if (e.status !== 401) toast('Cannot load the trash: ' + e.message);
  }
}

function openTrash() {
  $('#trash-list').textContent = 'Loading…';
  $('#trash').hidden = false;
  renderTrash();
}

function closeTrash() {
  $('#trash').hidden = true;
  $('#trash-list').replaceChildren();
}

async function restoreItem(it, btn) {
  btn.disabled = true;
  try {
    if (!await flush()) throw new Error('sync the pending ratings first');
    const r = await post('api/trash/restore', {id: it.id});
    toast('Restored' + (it.kind == 'image' ? '' : ': ' + r.path.split('/').join(' › ')), false);
    renderTrash();
    if (it.kind != 'image') home();   // the tree behind the dialog changed
  } catch(e) {
    toast('Restore failed: ' + e.message);
    btn.disabled = false;
  }
}

$('#trashbtn').onclick = openTrash;
$('#trash-close').onclick = closeTrash;
$('#trash').onmousedown = e => { if (e.target === $('#trash')) closeTrash(); };
document.addEventListener('keydown', e => {
  if (e.key == 'Escape' && !$('#trash').hidden && $('#dlg').hidden) closeTrash();
});


// ---------- routing ----------

// "#" = home, "#<deck id>" = study that deck or folder.
let lastHash = '';   // hash of the last completed navigation, restored when a discard is refused

async function route() {
  if (!authenticated) return;   // still on the login screen
  if (!$('#edit').hidden) {     // Back / hash change with the editor open: same confirmation as Cancel
    const now = currentMd();
    if ((now[0] !== base[0] || now[1] !== base[1]) &&
        !await ask({title: 'Discard changes?', message: 'The card has unsaved changes.', ok: 'Discard', danger: true})) {
      history.replaceState(null, '', lastHash || location.pathname + location.search);   // restore the URL, no hashchange fires
      return;
    }
    if (!authenticated) return;
  }
  closeMenu();
  closeEdit();   // a stale editor must not reopen over another deck
  closeTrash();
  let p = '';
  try {
    p = dec(location.hash.slice(1));   // a malformed hash must not kill the app
  } catch(e) {
    toast('Invalid deck link');
    location.hash = '';
    return;
  }
  lastHash = location.hash;
  p ? study(p) : home();
}

addEventListener('hashchange', route);
syncUI();
boot();
