// app.js
// Copyright (C) 2026 Francesco Scolz
// License: AGPL-3.0 (see LICENSE)

// Recto: frontend. Vanilla JS, no build step, no dependencies.
// Two views: home (deck tree) and study (one deck or folder), switched by the URL hash.


const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g,    // escaper
  c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Deck ids are slash-separated paths: encode each segment, keep the slashes.
const enc = p => p.split('/').map(encodeURIComponent).join('/');
const dec = p => p.split('/').map(decodeURIComponent).join('/');

// Card text -> HTML. HTML decks are trusted (the server sanitises on read and on write; CSP blocks scripts).
function renderContent(s, html) {
  s = String(s).replace(/\r\n?/g, '\n');
  return (html ? s : esc(s)).replace(/\n/g, '<br>');
}

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
  all = []; queue = []; deckIds = []; i = 0; flip = false; hist = [];
  $('#tree').replaceChildren();
  $('#card').replaceChildren();

  $('#login').hidden = false;
  $('#home').hidden = true;
  $('#study').hidden = true;

  const edit = $('#edit');
  if (edit) edit.hidden = true;

  const dlg = $('#dlg');
  if (dlg) dlg.hidden = true;

  const menu = $('#menu');
  if (menu) menu.hidden = true;

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

    showApp();
    route();

  } catch(err) {
    $('#login-msg').textContent = 'Network error';
    $('#login-btn').disabled = false;
  }
}

$('#login-form').onsubmit = tryAuth;

$('#logout').onclick = async () => {
  try{
    await fetch('api/logout', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      credentials: 'same-origin',
      body: '{}'
    });
  }catch(e) {}
  showLogin(false);
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
  nav++;   // abandon any study() request still in flight
  $('#study').hidden = true;
  $('#home').hidden = false;
  document.title = 'Recto';
  loading(true);

  try {
    const t = await api('api/tree');
    $('#tree').innerHTML = t.children.map(node).join('') ||
      '<p class="mut">No decks yet: use + above, or put folders and CSV files in the data folder.</p>';
  } catch(e) {
    $('#tree').innerHTML = '<p class="b">Error: ' + esc(e.message) + '</p>';
  } finally {
    loading(false);
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
    const res = await api('api/cards?path=' + encodeURIComponent(p));
    if (tok !== nav) return;
    all = res.cards;
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

  const tags = [...new Set(all.flatMap(c => c.t))].sort();
  $('#ftag').innerHTML = '<option value="">All tags</option>' +
    tags.map(t => `<option>${esc(t)}</option>`).join('');

  $('#frating').value = 'all';
  build();
}

function build() { // rebuild the queue from the filters and restart from the first card.
  const fs = $('#fsub').value, fr = $('#frating').value, ft = $('#ftag').value;

  queue = all.filter(c =>
    (!fs || c.deck == fs) &&
    (fr == 'all' || (fr == 'new' ? !c.r : c.r == fr)) &&
    (!ft || c.t.includes(ft))
  );

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

  $('#pos').textContent = `${queue.length} / ${all.length} selected`;
  if (!c) {
    const msg = queue.length ? 'End of queue — press Shuffle to start over'
              : all.length ? 'No cards match these filters'
              : 'No cards';
    $('#card').innerHTML = `<div class="content mut">${msg}</div>`;
    return;
  }

  const dot = {good: '🟢', ok: '🟡', bad: '🔴'}[c.r] || '';
  const tags = c.t.length
    ? `<small class="meta">[${c.t.map(esc).join(' · ')}] ${dot}</small>`
    : '';

  // Parse the card inside its own element: an unclosed <b>/<sup> must not leak into the tags line.
  const box = document.createElement('div');
  box.className = 'content';
  box.innerHTML = renderContent(flip ? c.b : c.f, c.html);
  $('#card').replaceChildren(box);
  $('#card').insertAdjacentHTML('beforeend', tags);
}

// The local card is updated first and rolled back if the server refuses; the screen is redrawn once the request has finished.
let rating = false;   // a double press must not rate the same card twice and skip the next one

async function rate(r) {    // handle card rating
  const c = queue[i];
  if (!c || rating) return;

  rating = true;
  const at = i;   // position when rated: the user may skip/go back while the request is in flight
  const prev = c.r;
  c.r = r;

  try {
    await post('api/rate', {deck: c.deck, id: c.id, r});
  } catch(e) {
    c.r = prev;
    toast('Save failed: ' + e.message);
    return;
  } finally{
    rating = false;
  }

  if (i === at) {   // already moved on (skip/previous) during the request: do not advance twice
    hist.push(i);
    i++;
  }

  flip = false;
  show();
}


// ---------- controls ----------

$('#card').onclick = () => {    // flip card on click
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

// Fisher-Yates shuffle of the current queue
$('#shuf').onclick = () => {
  for(let k = queue.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [queue[k], queue[j]] = [queue[j], queue[k]];
  }

  i = 0;
  flip = false;
  hist = [];
  show();
};

['#fsub', '#frating', '#ftag'].forEach(s => $(s).onchange = build);

$('#homebtn').onclick = () => { location.hash = ''; };


// ---------- keyboard ----------

document.addEventListener('keydown', e => {
  // Ignore shortcuts outside the study view, while the editor is open, or on focused controls
  if ($('#study').hidden || !$('#edit').hidden || !$('#dlg').hidden || /^(SELECT|BUTTON)$/.test(e.target.tagName)) return;
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


// ---------- card editor (WYSIWYG) ----------

// Browser tag -> allowed tag. The server applies the same whitelist again.
const OKT = {B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', UL: 'ul', OL: 'ol', LI: 'li', SUB: 'sub', SUP: 'sup'};

function clean(n) {    // edit contenteditable DOM -> HTML containing only allowed tags
  let o = '';
  n.childNodes.forEach((c, k) => {
    if (c.nodeType == 3) { o += esc(c.nodeValue.replace(/\n/g, ' ')); return; }
    if (c.nodeType != 1) return;

    const t = c.tagName;
    if (t == 'BR') { o += '<br>'; return; }

    const inner = clean(c);
    if (t == 'DIV' || t == 'P') {    // browsers wrap lines in <div>/<p>: turn into <br>
      if (k && !o.endsWith('<br>')) o += '<br>';
      o += inner;
      return;
    }

    const tag = OKT[t];
    o += tag ? `<${tag}>${inner}</${tag}>` : inner;    // unknown tags: keep text, drop markup

  });
  return o;
}

const cleanEd = el => clean(el).replace(/(<br>)+$/, '');

let editing = null;   // card being edited (null in add mode)
let mode = 'edit';    // 'edit' | 'add'
let lastEd = null;    // last focused editor field, target of toolbar commands

function openEdit() {    // self-explicative
  const c = queue[i];
  if (!c) return;

  mode = 'edit';
  editing = c;
  $('#etitle').textContent = 'Edit card';
  $('#edeck').hidden = true;
  $('#etags').hidden = true;
  $('#ef').innerHTML = renderContent(c.f, c.html);
  $('#eb').innerHTML = renderContent(c.b, c.html);

  $('#emsg').textContent = '';

  $('#edit').hidden = false;
  $('#ef').focus();
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
  $('#ef').innerHTML = '';
  $('#eb').innerHTML = '';
  $('#emsg').textContent = '';

  // Preselect the subdeck being filtered, else the deck of the current card
  $('#edeck').innerHTML = list.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join('');
  $('#edeck').value = $('#fsub').value || (queue[i] && queue[i].deck) || list[0];
  $('#edeck').hidden = list.length < 2;
  $('#etags').value = '';
  $('#etags').hidden = false;

  $('#edit').hidden = false;
  $('#ef').focus();
}

function closeEdit() {    // self-explicative
  $('#edit').hidden = true;
  editing = null;
}

async function reload(key) {    // Re-fetch cards after a change and try to stay on the card identified by key ("deck|id") if still present.
  all = (await api('api/cards?path=' + encodeURIComponent(path))).cards;
  build();
  const k = queue.findIndex(c => c.deck + '|' + c.id == key);
  if (k >= 0) { i = k; show(); }
}

let saving = false;   // a double click / double Ctrl+Enter must not add the card twice

async function saveEdit(convert) {    // save an edited card
  if (saving) return;
  const add = mode == 'add';
  const c = editing;
  if (!add && !c) return;

  if (!$('#ef').textContent.trim() || !$('#eb').textContent.trim()) {
    $('#emsg').textContent = 'Front and back cannot be empty';
    return;
  }

  const deck = add ? ($('#edeck').value || path) : c.deck;
  const f = cleanEd($('#ef')), b = cleanEd($('#eb'));

  saving = true;
  $('#esave').disabled = true;
  let r, err = null;
  try {
    r = await (add
      ? post('api/card/add', {deck, f, b, tags: $('#etags').value, convert: !!convert})
      : post('api/card', {deck, id: c.id, f, b, convert: !!convert}));
  } catch(e) {
    err = e;
  }
  saving = false;
  $('#esave').disabled = false;

  if (err) {
    if (err.status == 409) {   // plain-text deck: formatting needs HTML, ask before converting
      if (await ask({
        title: 'Convert deck to HTML?',
        message: 'This deck is plain text. To use formatting it must be converted to HTML: ' +
                 'the other cards stay the same, ratings are kept and the original is ' +
                 'saved as .csv.bak.',
        ok: 'Convert'
      })) {
        return saveEdit(true);
      }
    } else {
      $('#emsg').textContent = 'Save failed: ' + err.message;
    }
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

  toast(r.converted ? 'Saved (deck converted to HTML)' : (add ? 'Card added' : 'Saved'), false);
}

// Toolbar buttons use execCommand (deprecated but universally supported, and the
// simplest way to get a dependency-free WYSIWYG field).
document.querySelectorAll('[data-cmd]').forEach(b => {
  b.onmousedown = e => e.preventDefault();   // keep the text selection
  b.onclick = () => { lastEd && lastEd.focus(); document.execCommand(b.dataset.cmd); };
});

['#ef', '#eb'].forEach(s => {
  $(s).onfocus = () => lastEd = $(s);
  $(s).onpaste = e => {    // always paste as plain text
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  };
});

// button mappings
$('#editbtn').onclick = openEdit;
$('#addbtn').onclick = openAdd;
$('#esave').onclick = () => saveEdit(false);
$('#ecancel').onclick = closeEdit;
$('#etags').onkeydown = e => {
  if (e.key == 'Enter') { e.preventDefault(); saveEdit(false); }
};
$('#delbtn').onclick = async () => {
  const c = queue[i];
  if (!c) return;

  const preview = c.f.replace(/<[^>]*>/g, ' ').trim().slice(0, 60);

  if (!await ask({
    title: 'Delete this card?',
    message: '"' + preview + '"\n\nThis cannot be undone ' +
             '(the .csv.bak copy holds the file as it was before its first edit, and is removed after 7 days).',
    ok: 'Delete', danger: true
  })) return;

  try {
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
  if ($('#edit').hidden) return;
  if (e.key == 'Escape') closeEdit();
  else if (e.key == 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveEdit(false); }
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
      const body = {
        parent: importParent,
        name: f.name.replace(/\.[^.]+$/, ''),
        content: await f.text()
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
    message: `${what}\n\nIt is moved to data/.trash/ for 7 days before complete removal, and its ratings are cleared.`,
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


// ---------- routing ----------

// "#" = home, "#<deck id>" = study that deck or folder.
function route() {
  if (!authenticated) return;   // still on the login screen
  closeMenu();
  closeEdit();   // a stale editor must not reopen over another deck
  let p = '';
  try {
    p = dec(location.hash.slice(1));   // a malformed hash must not kill the app
  } catch(e) {
    toast('Invalid deck link');
    location.hash = '';
    return;
  }
  p ? study(p) : home();
}

addEventListener('hashchange', route);
boot();
