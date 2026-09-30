'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const IR = window.IconRender;
  const isMac = /Mac/.test(navigator.platform);
  document.body.classList.add(isMac ? 'mac' : 'win');

  /** DOM builder. Text goes in as text nodes, never as HTML. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svg = (markup) => { const t = document.createElement('template'); t.innerHTML = markup; return t.content.firstElementChild; };
  const ICON = {
    info: '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10 9v5M10 6.2v.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross: '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  };

  const state = {
    info: null, list: [], sel: null, nextId: 1, problems: [], profileData: new Map(), mode: 'choose', busy: false, updateCheck: true,
  };
  let ui = {};
  let validateSeq = 0; let validateTimer = null; let toastTimer = null;

  // ---------- helpers ----------
  const safeName = (n) => n.trim().replace(/ /g, '');
  const defaultBadge = (name) => name.replace(/[-_]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
  const defaultColor = (i) => { const p = state.info.palette; return p[1 + (i % (p.length - 1))][1]; };
  const join = (...parts) => parts.join(state.info.sep);
  const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const fileManager = () => (isMac ? 'Finder' : 'File Explorer');
  const trashName = () => (isMac ? 'Trash' : 'Recycle Bin');
  const cur = () => state.list.find((i) => i.id === state.sel) || null;
  const effectiveProfile = (i) => i.profileDir || join(state.info.dataRoot, `Claude-${safeName(i.name) || 'Instance'}`);

  function ago(ms) {
    if (!ms) return 'never';
    const d = (Date.now() - ms) / 1000;
    if (d < 90) return 'just now';
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    if (d < 86400 * 30) return `${Math.round(d / 86400)} days ago`;
    return new Date(ms).toLocaleDateString();
  }

  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }

  function makeInstance(src, isNew) {
    const inst = {
      id: state.nextId++, name: src.name, color: src.color, badge: src.badge, profileDir: src.profileDir || null,
      startup: !!src.startup, badgeTouched: !isNew, origName: isNew ? null : src.name, orig: null,
    };
    if (!isNew) inst.orig = { name: inst.name, color: inst.color, badge: inst.badge, profileDir: inst.profileDir, startup: inst.startup };
    return inst;
  }
  function isDirty(i) {
    if (!i.orig) return true;
    const o = i.orig;
    return i.name.trim() !== o.name || i.color !== o.color || i.badge !== o.badge || i.startup !== o.startup || norm(effectiveProfile(i)) !== norm(o.profileDir || '');
  }
  const dirtyList = () => state.list.filter(isDirty);

  function profileConflicts() {
    const out = []; const seen = new Map();
    for (const i of state.list) {
      const key = norm(effectiveProfile(i));
      if (seen.has(key)) out.push(`"${i.name}" and "${seen.get(key)}" use the same folder; two instances cannot share one.`);
      else seen.set(key, i.name);
    }
    return out;
  }
  const allProblems = () => [...state.problems, ...profileConflicts()];

  function scheduleValidate() {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(async () => {
      const seq = ++validateSeq;
      let problems = [];
      try { problems = await window.mc.validateNames(state.list.map((i) => i.name)); } catch (_) { /* keep UI usable */ }
      if (seq !== validateSeq) return;
      state.problems = problems; refreshLive();
    }, 120);
  }

  async function loadProfileData(dir) {
    const key = norm(dir);
    if (state.profileData.has(key)) return state.profileData.get(key);
    const info = await window.mc.profileInfo(dir).catch(() => ({ hasData: false, isMain: false }));
    state.profileData.set(key, info);
    return info;
  }

  // ---------- rendering ----------
  function renderBrand() {
    const c = $('brandMark'); c.width = 56; c.height = 56; c.style.width = '28px'; c.style.height = '28px';
    IR.paint(c, 28, '#D97757', '');
  }

  function renderChip() {
    const chip = $('claudeChip'); chip.replaceChildren();
    const c = state.info.claude;
    chip.classList.toggle('warn', !c);
    chip.append(h('span', { text: c ? `Claude ${c.version || 'Desktop'} found` : 'Claude Desktop not found' }));
    chip.title = c ? c.path : 'Install Claude Desktop first';
  }

  function subText(i) {
    if (!i.orig) return 'New · not applied yet';
    if (isDirty(i)) return 'Unapplied changes';
    const d = state.profileData.get(norm(effectiveProfile(i)));
    return d && d.hasData ? 'Continues existing data' : 'Ready';
  }

  function renderSidebar() {
    const ul = $('list'); ul.replaceChildren();
    for (const i of state.list) {
      const cv = h('canvas', { 'aria-hidden': 'true' }); IR.paint(cv, 38, i.color, i.badge);
      const btn = h('button', {
        class: 'inst', type: 'button', role: 'option', 'aria-selected': String(i.id === state.sel), 'data-id': i.id,
        onclick: () => select(i.id),
        ondblclick: () => openNow(i),
        onkeydown: (e) => {
          const idx = state.list.indexOf(i); const n = e.key === 'ArrowDown' ? idx + 1 : e.key === 'ArrowUp' ? idx - 1 : null;
          if (n != null && state.list[n]) { e.preventDefault(); select(state.list[n].id, true); }
        },
      }, cv, h('span', { class: 'inst-text' }, h('span', { class: 'inst-name', text: i.name.trim() || 'Untitled' }), h('span', { class: 'inst-sub', text: subText(i) })),
      isDirty(i) ? h('span', { class: 'dot', title: 'Unapplied changes' }) : null);
      ul.append(h('li', {}, btn));
    }
  }

  function welcome() {
    const cv = h('canvas', { 'aria-hidden': 'true' }); IR.paint(cv, 84, '#D97757', '');
    const c = state.info.claude;
    const feat = (t, d) => h('div', { class: 'feature' }, h('b', { text: t }), h('span', { text: d }));
    return h('div', { class: 'welcome' }, h('div', { class: 'pane-top' }), cv,
      h('h1', { text: 'Many Claudes,\none desktop.' }),
      h('p', { class: 'lede', text: 'Run several Claude accounts side by side. Each instance keeps its own sign-in, chats and settings, and gets a colored icon so you always open the right one.' }),
      h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: addInstance, disabled: !c }, 'Create your first instance'),
      !c ? h('p', { class: 'no-claude hint', text: 'Install Claude Desktop first, then reopen this window.' }) : null,
      h('div', { class: 'features' },
        feat('Separate sign-ins', 'Work, personal, a client. Every account stays signed in at once.'),
        feat('Its own icon', 'Pick a color and a badge letter. Find it in Spotlight or the Start menu.'),
        feat('Your Claude is safe', 'The original app and its data are never changed or shared.')));
  }

  /** Single click on an applied instance: ask whether to open it or edit it. */
  function chooser(i) {
    const cv = h('canvas', { 'aria-hidden': 'true' }); IR.paint(cv, 96, i.color, i.badge);
    return h('div', { class: 'pane' }, h('div', { class: 'pane-top' }),
      h('div', { class: 'choose' }, cv,
        h('h1', { text: i.name.trim() }),
        h('p', { class: 'lede', text: 'What would you like to do with this instance?' }),
        h('div', { class: 'choose-actions' },
          h('button', { class: 'btn btn-primary btn-lg', type: 'button', onclick: () => openNow(i) }, 'Open'),
          h('button', { class: 'btn btn-ghost btn-lg', type: 'button', onclick: () => { state.mode = 'edit'; renderMain(); } }, 'Edit')),
        h('p', { class: 'hint', text: 'Tip: double-click an instance in the list to open it right away.' })));
  }

  async function openNow(i) {
    if (!i.orig) { state.mode = 'edit'; if (state.sel !== i.id) select(i.id); return; }
    if (isDirty(i)) { toast('Apply or discard your changes before opening this instance.'); state.mode = 'edit'; if (state.sel !== i.id) select(i.id); else renderMain(); return; }
    const r = await window.mc.openInstance(i.orig.name);
    toast(r.ok ? `Opening ${i.name.trim()}…` : (r.message || 'Could not open it.'));
  }

  function renderMain() {
    const main = $('main'); main.replaceChildren(); ui = {};
    if (!state.list.length) { main.append(welcome()); return; }
    const i = cur() || state.list[0]; state.sel = i.id;
    if (state.mode === 'choose' && i.orig && !isDirty(i)) { main.append(chooser(i)); renderActionbar(); return; }

    ui.title = h('input', {
      class: 'title-input', type: 'text', value: i.name, maxlength: '60', spellcheck: 'false', 'aria-label': 'Instance name', placeholder: 'Name this instance',
      oninput: (e) => {
        i.name = e.target.value;
        if (!i.badgeTouched) { i.badge = defaultBadge(i.name).slice(0, 2); ui.badge.value = i.badge; }
        scheduleValidate(); refreshLive();
      },
    });
    ui.nameError = h('p', { class: 'field-error', role: 'alert', hidden: true });
    ui.status = h('span', { class: 'pill' });
    ui.openBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: async () => {
      const r = await window.mc.openInstance(i.orig.name); if (!r.ok) toast(r.message || 'Could not open it.');
    } }, 'Open');

    ui.preview = h('canvas', { 'aria-label': 'Icon preview', role: 'img' });
    ui.badge = h('input', {
      class: 'text-input badge-input', type: 'text', value: i.badge, maxlength: '2', spellcheck: 'false', 'aria-label': 'Badge letters',
      oninput: (e) => { i.badge = e.target.value.toUpperCase().slice(0, 2); i.badgeTouched = true; refreshLive(); },
    });
    ui.swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Icon color' });
    for (const [label, hex] of state.info.palette) {
      ui.swatches.append(h('button', { class: 'swatch', type: 'button', role: 'radio', title: label, 'aria-label': label, 'data-hex': hex, onclick: () => { i.color = hex; refreshLive(); } }));
    }
    ui.custom = h('input', { type: 'color', 'aria-label': 'Custom color', value: i.color, oninput: (e) => { i.color = e.target.value.toUpperCase(); refreshLive(); } });
    ui.swatches.append(h('span', { class: 'swatch custom', title: 'Custom color' }, ui.custom));

    ui.path = h('div', { class: 'path' }); ui.pathText = h('bdi'); ui.path.append(ui.pathText);
    ui.profilePill = h('span', { class: 'pill' });
    ui.reveal = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => window.mc.reveal(effectiveProfile(i)) }, `Show in ${fileManager()}`);

    ui.startup = h('input', { type: 'checkbox', checked: i.startup, 'aria-label': 'Open at sign-in', onchange: (e) => { i.startup = e.target.checked; refreshLive(); } });

    const card = (title, desc, ...body) => h('section', { class: 'card' }, h('h2', { class: 'card-title', text: title }), desc ? h('p', { class: 'card-desc', text: desc }) : null, ...body);

    main.append(h('div', { class: 'pane' }, h('div', { class: 'pane-top' }),
      state.info.claude ? null : h('div', { class: 'banner' }, svg(ICON.info), h('div', {}, h('b', { text: 'Claude Desktop was not found. ' }), 'Install it, then reopen this window. You can still prepare instances now.')),
      h('header', { class: 'pane-head' }, h('div', { class: 'title-wrap' }, ui.title, ui.nameError, h('div', { class: 'sub' }, ui.status)), ui.openBtn),
      card('Appearance', 'A colored icon and a badge make this instance easy to spot in Spotlight, the Dock or the taskbar.',
        h('div', { class: 'look' }, h('div', { class: 'preview' }, ui.preview),
          h('div', { class: 'look-fields' }, h('span', { class: 'label', text: 'Color' }), ui.swatches,
            h('span', { class: 'label', text: 'Badge' }), h('div', { class: 'badge-row' }, ui.badge, h('span', { class: 'hint', text: 'Up to two letters.' }))))),
      card('Data', 'Where this instance keeps its sign-in, chats and settings.',
        h('div', { class: 'row' }, ui.path), h('div', { class: 'row' }, ui.profilePill, h('span', { class: 'spacer' }), ui.reveal,
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: openProfilePicker }, 'Change…'))),
      card('Sign-in', null, h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Open at sign-in' }), h('span', { text: 'Start this instance automatically when you log in to your computer.' })),
        h('label', { class: 'switch' }, ui.startup, h('i')))),
      h('div', { class: 'danger-row' }, h('span', { class: 'hint', text: 'Removing deletes the launcher. Your data stays unless you choose otherwise.' }),
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: askRemove }, 'Remove instance…'))));
    refreshLive();
  }

  /** Update everything that depends on the current instance's fields, without rebuilding inputs. */
  function refreshLive() {
    const i = cur();
    renderSidebar(); renderActionbar();
    if (!i || !ui.title) return;
    IR.paint(ui.preview, 116, i.color, i.badge);
    for (const s of ui.swatches.querySelectorAll('.swatch[data-hex]')) {
      const on = s.dataset.hex.toLowerCase() === i.color.toLowerCase();
      s.setAttribute('aria-checked', String(on)); s.style.background = s.dataset.hex;
    }
    if (ui.custom.value.toLowerCase() !== i.color.toLowerCase()) ui.custom.value = i.color;
    const mine = allProblems().filter((p) => p.includes(`"${i.name}"`) || (!i.name.trim() && /empty/.test(p)));
    ui.nameError.hidden = !mine.length; ui.nameError.textContent = mine[0] || '';
    ui.title.classList.toggle('invalid', !!mine.length);
    if (!i.orig) { ui.status.textContent = 'Not applied yet'; ui.status.className = 'pill coral'; }
    else if (isDirty(i)) { ui.status.textContent = 'Unapplied changes'; ui.status.className = 'pill coral'; }
    else { ui.status.textContent = 'Applied'; ui.status.className = 'pill good'; }
    ui.openBtn.hidden = !i.orig || isDirty(i);
    const dir = effectiveProfile(i);
    ui.pathText.textContent = dir; ui.path.title = dir;
    loadProfileData(dir).then((d) => {
      if (cur() !== i || !ui.profilePill) return;
      ui.profilePill.textContent = d.hasData ? 'Continues existing data' : 'Starts fresh';
      ui.profilePill.className = `pill ${d.hasData ? 'good' : ''}`;
      ui.reveal.hidden = !d.hasData;
    });
  }

  function renderActionbar() {
    const bar = $('actionbar'); bar.hidden = !state.list.length; if (bar.hidden) { window.mc.setDirty(0).catch(() => {}); return; }
    const dirty = dirtyList().length; const problems = allProblems(); const msg = $('actionMsg');
    window.mc.setDirty(dirty).catch(() => {});
    msg.classList.toggle('bad', problems.length > 0);
    msg.replaceChildren();
    if (problems.length) msg.append(problems[0]);
    else if (dirty) msg.append(h('b', { text: String(dirty) }), ` unapplied change${dirty > 1 ? 's' : ''}`);
    else msg.append('Everything is up to date.');
    $('applyBtn').disabled = !dirty || problems.length > 0 || state.busy || !state.info.claude;
    $('discardBtn').disabled = !dirty || state.busy;
    $('applyBtn').title = state.info.claude ? '' : 'Install Claude Desktop first';
  }

  // ---------- actions ----------
  function select(id, focus) {
    const changed = state.sel !== id;
    state.sel = id;
    const i = cur();
    state.mode = i && i.orig && !isDirty(i) ? 'choose' : 'edit';
    if (state.mode === 'choose') {
      // keep the sidebar buttons in place so a double-click lands on the same element
      for (const b of document.querySelectorAll('.inst')) b.setAttribute('aria-selected', String(b.dataset.id === String(id)));
      renderMain();
    } else { renderMain(); renderSidebar(); }
    if (focus || !changed) document.querySelector(`.inst[data-id="${id}"]`)?.focus();
  }

  function addInstance() {
    const n = state.list.length + 1;
    let name = `Claude ${n + 1}`;
    const taken = new Set(state.list.map((i) => i.name.toLowerCase()));
    while (taken.has(name.toLowerCase())) name += '+';
    const inst = makeInstance({ name, color: defaultColor(state.list.length), badge: defaultBadge(name), startup: false }, true);
    inst.badgeTouched = false;
    state.list.push(inst); state.sel = inst.id; renderMain(); scheduleValidate();
    ui.title?.focus(); ui.title?.select();
  }

  function discard() {
    state.list = state.list.filter((i) => i.orig);
    for (const i of state.list) Object.assign(i, { name: i.orig.name, color: i.orig.color, badge: i.orig.badge, profileDir: i.orig.profileDir, startup: i.orig.startup });
    if (!state.list.some((i) => i.id === state.sel)) state.sel = state.list[0]?.id ?? null;
    renderMain(); renderSidebar(); scheduleValidate();
  }

  // profile picker
  let pickerChoice = null;
  async function openProfilePicker() {
    const i = cur(); if (!i) return;
    const folders = await window.mc.listProfiles();
    const current = effectiveProfile(i);
    const used = new Map(state.list.filter((o) => o !== i).map((o) => [norm(effectiveProfile(o)), o]));
    let fresh = join(state.info.dataRoot, `Claude-${safeName(i.name) || 'Instance'}`); let k = 2;
    while (used.has(norm(fresh)) || folders.some((f) => norm(f.path) === norm(fresh) && norm(fresh) !== norm(current))) fresh = join(state.info.dataRoot, `Claude-${safeName(i.name) || 'Instance'}-${k++}`);
    pickerChoice = current;
    const box = $('profileOptions'); box.replaceChildren();
    const add = (title, path, note, disabled) => {
      const radio = h('input', { type: 'radio', name: 'profile', value: path, checked: norm(path) === norm(pickerChoice), disabled });
      const row = h('label', { class: `opt${disabled ? ' disabled' : ''}${norm(path) === norm(pickerChoice) ? ' selected' : ''}`, 'data-path': path },
        radio, h('span', {}, h('b', { text: title }), h('em', { text: note })));
      radio.addEventListener('change', () => { pickerChoice = path; for (const o of box.querySelectorAll('.opt')) o.classList.toggle('selected', o.dataset.path === path); });
      box.append(row);
    };
    if (norm(fresh) !== norm(current)) add('Start fresh', fresh, `A new, empty folder: ${fresh.split(/[\\/]/).pop()}`, false);
    if (!folders.some((f) => norm(f.path) === norm(current))) add(current.split(/[\\/]/).pop(), current, 'Current folder (no data yet)', false);
    const mains = folders.filter((f) => f.isMain).slice(0, 1);
    for (const f of [...folders.filter((x) => !x.isMain), ...mains]) {
      const other = used.get(norm(f.path));
      const note = f.isMain ? 'Used by your main Claude app' : norm(f.path) === norm(current) ? `Current · last used ${ago(f.lastUsed)}`
        : other ? `Used by “${other.name}” · the two will swap folders` : `Last used ${ago(f.lastUsed)}${f.thirdParty ? ' · third-party inference' : ''}`;
      add(f.isMain ? 'Your main Claude' : f.name, f.path, note, f.isMain);
    }
    $('profileDlg').showModal();
  }

  async function browseProfile() {
    const dir = await window.mc.pickFolder(); if (!dir) return;
    const info = await window.mc.profileInfo(dir);
    if (info.isMain) { toast('That folder belongs to your main Claude. Two Claudes cannot share one folder.'); return; }
    if (info.problem) { toast(info.problem); return; }
    const box = $('profileOptions');
    const radio = h('input', { type: 'radio', name: 'profile', value: dir, checked: true });
    for (const o of box.querySelectorAll('.opt')) o.classList.remove('selected');
    pickerChoice = dir;
    const row = h('label', { class: 'opt selected', 'data-path': dir }, radio, h('span', {}, h('b', { text: dir.split(/[\\/]/).pop() || dir }), h('em', { text: info.hasData ? 'Chosen · has Claude data' : 'Chosen · no Claude data yet, it will start fresh' })));
    radio.addEventListener('change', () => { pickerChoice = dir; for (const o of box.querySelectorAll('.opt')) o.classList.toggle('selected', o.dataset.path === dir); });
    box.prepend(row);
  }

  function confirmProfile() {
    const i = cur(); if (!i || !pickerChoice) return;
    const before = effectiveProfile(i);
    const other = state.list.find((o) => o !== i && norm(effectiveProfile(o)) === norm(pickerChoice));
    if (other) other.profileDir = before;
    i.profileDir = pickerChoice;
    $('profileDlg').close(); refreshLive();
  }

  // remove
  let removeNames = null; let removeUninstall = false;
  function askRemove() {
    const i = cur(); if (!i) return;
    if (!i.orig) { state.list = state.list.filter((x) => x !== i); state.sel = state.list[0]?.id ?? null; renderMain(); renderSidebar(); scheduleValidate(); return; }
    removeNames = [i.orig.name]; removeUninstall = false;
    openRemoveDialog(`Remove “${i.orig.name}”?`, 'This deletes its launcher app and icon. Claude itself and your claude.ai account are not touched.');
  }
  function openRemoveDialog(title, sub) {
    $('removeTitle').textContent = title; $('removeSub').textContent = sub; $('removeData').checked = false;
    document.querySelector('.trash-name').textContent = trashName();
    $('removeDlg').showModal();
  }
  async function doRemove() {
    const dlg = $('removeDlg'); const deleteData = $('removeData').checked; dlg.close();
    state.busy = true; renderActionbar();
    let r;
    try { r = await window.mc.remove({ names: removeNames, deleteData, uninstall: removeUninstall }); } catch (e) { r = { ok: false, message: e.message }; }
    state.busy = false;
    toast(r.ok ? r.message.split('\n')[0] : r.message.split('\n')[0]);
    await reload();
  }

  // apply
  async function apply(opts = {}) {
    const all = opts.all === true;
    const targets = all ? state.list : dirtyList();
    if (!targets.length) return;
    state.busy = true; renderActionbar();
    const dlg = $('applyDlg'); const logBox = $('logBox'); logBox.textContent = '';
    setApplyState('busy', all ? 'Rebuilding launchers…' : 'Applying changes…', 'This only takes a moment. Claude itself is not modified.');
    $('applyResults').replaceChildren(); $('logWrap').open = false; $('applyClose').disabled = true;
    if (!dlg.open) dlg.showModal();
    const off = window.mc.onLog((line) => { logBox.textContent += `${line}\n`; logBox.scrollTop = logBox.scrollHeight; });
    let result;
    try {
      result = await window.mc.apply({
        updateCheck: state.updateCheck, forcePatch: all,
        instances: targets.map((i) => ({
          name: i.name.trim(), origName: i.origName || undefined, color: i.color, badge: i.badge, startup: i.startup,
          profileDir: effectiveProfile(i), iconPng: IR.toPngBase64(i.color, i.badge),
        })),
      });
    } catch (e) { result = { ok: false, message: e.message }; }
    off(); state.busy = false;
    if (result.ok) {
      setApplyState('good', 'All set', `${targets.length} instance${targets.length > 1 ? 's are' : ' is'} ready. Open ${targets.length > 1 ? 'them' : 'it'} from ${isMac ? 'Spotlight or ~/Applications' : 'the Start menu or your desktop'}.`);
      const res = $('applyResults');
      for (const i of targets) {
        const cv = h('canvas', { 'aria-hidden': 'true' }); IR.paint(cv, 40, i.color, i.badge);
        res.append(h('div', { class: 'result' }, cv, h('div', { class: 'row-text' }, h('b', { text: `Claude ${i.name.trim()}` }), h('span', { text: 'Sign in with a different account on first launch.' })),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => window.mc.openInstance(i.name.trim()).then((r) => { if (!r.ok) toast(r.message); }) }, 'Open')));
      }
    } else {
      setApplyState('bad', 'Something went wrong', '');
      $('applySub').replaceChildren(h('span', { class: 'err-text', text: result.message || 'Unknown error.' }));
      $('logWrap').open = true;
    }
    $('applyClose').disabled = false; $('applyClose').focus();
    if (result.ok) await reload(cur()?.name.trim());
    else if (result.partial && result.partial.length) await reload(cur()?.name.trim()); // some instances were built: show the truth
    else renderActionbar(); // nothing was built: keep the drafts so nothing is lost
  }

  function setApplyState(kind, title, sub) {
    const icon = $('applyIcon'); icon.className = `apply-icon ${kind === 'good' || kind === 'bad' ? kind : ''}`; icon.replaceChildren();
    icon.append(kind === 'busy' ? h('div', { class: 'spinner' }) : svg(kind === 'good' ? ICON.check : ICON.cross));
    $('applyTitle').textContent = title; $('applySub').textContent = sub;
  }

  // settings
  function openSettings() {
    const body = $('settingsBody'); body.replaceChildren();
    const c = state.info.claude;
    const sec = (t, ...kids) => h('div', { class: 'set-section' }, h('h3', { text: t }), ...kids);
    body.append(
      sec('About', h('p', { text: `MuClaude ${state.info.appVersion}. ${c ? `Using Claude ${c.version || 'Desktop'} at ${c.path}.` : 'Claude Desktop was not found.'}` }),
        h('p', { text: isMac
          ? 'Each instance is a small launcher app that opens Claude on its own data folder. Claude itself is never modified, and this app makes no network connections.'
          : 'Instances run from a modified copy of Claude Desktop, built for you and self-tested first. Your original install is never changed. Anthropic does not support modified copies, so updates to Claude may need a rebuild.' })));
    if (state.info.platform === 'win32') {
      const cb = h('input', { type: 'checkbox', checked: state.updateCheck, onchange: (e) => { state.updateCheck = e.target.checked; } });
      body.append(sec('Updates', h('div', { class: 'row' }, h('div', { class: 'row-text' }, h('b', { text: 'Remind me after Claude updates' }), h('span', { text: 'Asks at sign-in whether to rebuild your instances. Saved with your next Apply.' })), h('label', { class: 'switch' }, cb, h('i')))));
    }
    body.append(
      sec('Repair', h('p', { text: 'Rebuild every launcher and icon. Your data is never touched.' }),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: !state.list.some((i) => i.orig) || !c || allProblems().length > 0, onclick: () => { $('settingsDlg').close(); apply({ all: true }); } }, 'Rebuild all launchers')),
      sec('Uninstall', h('p', { text: isMac ? 'Remove every instance and launcher. Your original Claude stays as it is.' : 'Remove every instance, the patched Claude copy and the update reminder. Your original Claude stays as it is.' }),
        h('button', { class: 'btn btn-quiet btn-sm', type: 'button', disabled: !state.list.some((i) => i.orig), onclick: () => {
          $('settingsDlg').close(); removeNames = state.list.filter((i) => i.orig).map((i) => i.orig.name); removeUninstall = true;
          openRemoveDialog('Remove everything?', `This removes ${removeNames.length} instance${removeNames.length > 1 ? 's' : ''}${isMac ? '' : ', the patched Claude copy'} and all launchers.`);
        } }, 'Remove all instances…')));
    $('settingsDlg').showModal();
  }

  // ---------- boot ----------
  async function reload(keepName) {
    state.info = await window.mc.init();
    state.updateCheck = state.info.updateCheck;
    state.profileData.clear();
    state.list = state.info.instances.map((s) => makeInstance(s, false));
    state.sel = state.list.find((i) => i.name === keepName)?.id ?? state.list[0]?.id ?? null;
    renderChip(); renderMain(); renderSidebar(); scheduleValidate();
    for (const i of state.list) loadProfileData(effectiveProfile(i)).then(renderSidebar);
  }

  function wire() {
    $('addBtn').addEventListener('click', addInstance);
    $('applyBtn').addEventListener('click', () => apply());
    $('discardBtn').addEventListener('click', discard);
    $('settingsBtn').addEventListener('click', openSettings);
    $('settingsClose').addEventListener('click', () => $('settingsDlg').close());
    $('browseBtn').addEventListener('click', browseProfile);
    $('profileCancel').addEventListener('click', () => $('profileDlg').close());
    $('profileOk').addEventListener('click', confirmProfile);
    $('removeCancel').addEventListener('click', () => $('removeDlg').close());
    $('removeOk').addEventListener('click', doRemove);
    $('applyClose').addEventListener('click', () => $('applyDlg').close());
    $('applyDlg').addEventListener('cancel', (e) => { if (state.busy) e.preventDefault(); }); // no Esc mid-apply
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); if (!document.querySelector('dialog[open]')) addInstance(); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('applyBtn').disabled && !document.querySelector('dialog[open]')) apply();
    });
    // keep the light/dark canvases in step with the OS theme
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderMain(); renderSidebar(); });
  }

  wire(); renderBrandSafe();
  function renderBrandSafe() { try { renderBrand(); } catch (_) { /* cosmetic */ } }
  reload().catch((e) => { $('main').replaceChildren(h('div', { class: 'welcome' }, h('h1', { text: 'Could not start' }), h('p', { class: 'lede err-text', text: e.message }))); });
})();
