(async () => {
  const { api, el, toast, initials } = MW;
  const $ = (id) => document.getElementById(id);

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    volume: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
    muted: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>'),
    swap: svg('<path d="M3 7h14"/><path d="m13 3 4 4-4 4"/><path d="M21 17H7"/><path d="m11 13-4 4 4 4"/>'),
    full: svg('<path d="M8 3H3v5"/><path d="M16 3h5v5"/><path d="M8 21H3v-5"/><path d="M16 21h5v-5"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    gridAdd: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7"/><path d="M14 17.5h7"/>'),
    gridRemove: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7"/>'),
    share: svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4"/><path d="m15.4 6.5-6.8 4"/>'),
  };

  const wall = $('wall');
  const empty = $('empty');
  const panels = [];      // in display order
  let channels = [];
  let byId = new Map();
  let selected = null;
  let maxPanels = 16;
  let me = null;

  // ---------------------------------------------------------------- persistence
  let saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api('/api/layout', {
        method: 'PUT',
        body: { panels: panels.map((p) => ({ channelId: p.channelId, muted: p.muted, volume: p.volume })) },
      }).catch(() => {});
    }, 400);
  }

  // --------------------------------------------------------------------- layout
  // Pick the column count that gives the largest 16:9 picture per panel.
  function layoutGrid() {
    const n = panels.length;
    if (!n) return;
    const W = wall.clientWidth, H = wall.clientHeight;
    let best = 1, bestWidth = 0;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min(W / cols, (H / rows) * (16 / 9));
      if (w > bestWidth + 0.5) { bestWidth = w; best = cols; }
    }
    wall.style.gridTemplateColumns = `repeat(${best}, minmax(0, 1fr))`;
    wall.style.gridTemplateRows = `repeat(${Math.ceil(n / best)}, minmax(0, 1fr))`;
  }

  function render() {
    const n = panels.length;
    wall.hidden = n === 0;
    empty.hidden = n !== 0;
    panels.forEach((p, i) => {
      p.node.style.order = i;      // reorder without moving DOM nodes (keeps video playing)
      p.numEl.textContent = i + 1;
      p.node.classList.toggle('selected', p === selected);
    });
    $('count').textContent = n ? `${n} / ${maxPanels} panels` : '';
    layoutGrid();
    updateSide();
  }

  function select(p) {
    selected = p || null;
    panels.forEach((x) => x.node.classList.toggle('selected', x === selected));
    updateSide();
  }

  // ----------------------------------------------------------------- side panel
  // The volume controls act on the panel you are listening to: the first
  // unmuted one, otherwise the selected one, otherwise panel 1.
  const audioTarget = () => panels.find((p) => !p.muted) || selected || panels[0] || null;

  function updateSide() {
    const t = audioTarget();
    const live = t && !t.muted;
    const mute = $('sideMute'), vol = $('sideVol');
    mute.innerHTML = live ? ICON.volume : ICON.muted;
    mute.classList.toggle('on', !!live);
    mute.disabled = !t;
    mute.title = !t ? 'No panels' : live ? `Mute panel ${panels.indexOf(t) + 1}` : `Unmute panel ${panels.indexOf(t) + 1}`;
    mute.setAttribute('aria-label', mute.title);
    vol.disabled = !t;
    vol.value = t ? Math.round(t.volume * 100) : 0;
    $('sideTarget').textContent = t ? `Panel ${panels.indexOf(t) + 1}` : '';

    $('gridAdd').disabled = panels.length >= maxPanels;
    $('gridRemove').disabled = panels.length === 0;
    $('shareBtn').disabled = panels.length === 0;

    const audio = $('sideAudio');
    if (!panels.length) {
      audio.replaceChildren(el('span', { class: 'none' }, 'No panels'));
      return;
    }
    audio.replaceChildren(...panels.map((p, i) => el('button', {
      class: `${p.muted ? '' : 'on'}${p === selected ? ' sel' : ''}`,
      title: `${p.muted ? 'Listen to' : 'Mute'} panel ${i + 1}${byId.get(p.channelId) ? `: ${byId.get(p.channelId).name}` : ''}`,
      'aria-pressed': String(!p.muted),
      onclick: () => {
        select(p);
        const onlyThis = !p.muted && panels.every((x) => x === p || x.muted);
        if (onlyThis) setMuted(p, true);
        else solo(p);
      },
    }, i + 1)));
  }

  function setSideCollapsed(collapsed) {
    $('side').classList.toggle('collapsed', collapsed);
    const t = $('sideToggle');
    t.textContent = collapsed ? '›' : '‹';
    t.title = collapsed ? 'Show controls (B)' : 'Hide controls (B)';
    t.setAttribute('aria-label', collapsed ? 'Show controls' : 'Hide controls');
    t.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('mw.sideCollapsed', collapsed ? '1' : '0'); } catch { /* storage off */ }
    layoutGrid();
  }

  // ---------------------------------------------------------------------- audio
  function syncAudio(p) {
    p.video.muted = p.muted;
    p.video.volume = p.volume;
    p.muteBtn.innerHTML = p.muted ? ICON.muted : ICON.volume;
    p.muteBtn.classList.toggle('on', !p.muted);
    p.node.classList.toggle('audible', !p.muted);
    p.muteBtn.setAttribute('aria-label', p.muted ? 'Unmute' : 'Mute');
    p.muteBtn.title = p.muted ? 'Unmute (M)' : 'Mute (M)';
    p.volEl.value = Math.round(p.volume * 100);
    updateSide();
  }

  function setMuted(p, muted) {
    p.muted = muted;
    if (!muted && p.volume === 0) p.volume = 0.5;
    syncAudio(p);
    if (!muted) p.video.play().catch(() => {});
    save();
  }

  function solo(p) {
    panels.forEach((x) => { if (x !== p && !x.muted) { x.muted = true; syncAudio(x); } });
    setMuted(p, false);
  }

  // -------------------------------------------------------------------- streams
  const status = (p, text) => { p.statusEl.textContent = text; };
  const setLive = (p, on) => {
    p.liveEl.classList.toggle('on', on);
    p.liveEl.textContent = on ? 'LIVE' : 'OFF AIR';
  };

  function detach(p) {
    clearTimeout(p.retryTimer);
    if (p.hls) { p.hls.destroy(); p.hls = null; }
    if (p.video.hasAttribute('src')) { p.video.removeAttribute('src'); p.video.load(); }
  }

  function tryPlay(p) {
    p.video.play().catch((err) => {
      // Browsers block autoplay with sound until the user interacts with the
      // page. Fall back to muted so the picture still starts.
      if (err.name === 'NotAllowedError' && !p.video.muted) {
        p.muted = true;
        syncAudio(p);
        p.video.play().catch(() => {});
      }
    });
  }

  function scheduleRetry(p) {
    if (p.hls) { p.hls.destroy(); p.hls = null; }
    p.retries += 1;
    const delay = Math.min(15000, 1500 * 2 ** (p.retries - 1));
    setLive(p, false);
    status(p, `No signal · retrying in ${Math.round(delay / 1000)}s`);
    clearTimeout(p.retryTimer);
    p.retryTimer = setTimeout(() => attach(p), delay);
  }

  function attach(p) {
    detach(p);
    const ch = byId.get(p.channelId);
    p.nameEl.textContent = ch ? ch.name : 'No channel';
    setLive(p, false);
    if (!ch) {
      status(p, p.channelId == null ? 'Choose a channel' : 'This channel is no longer available');
      return;
    }
    status(p, 'Connecting…');
    const v = p.video;

    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        capLevelToPlayerSize: true,   // small panel = lower rendition = less bandwidth and CPU
        maxBufferLength: 12,
        maxMaxBufferLength: 24,
        backBufferLength: 10,
      });
      p.hls = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay(p));
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal || p.hls !== hls) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !p.mediaRecovered) {
          p.mediaRecovered = true;
          hls.recoverMediaError();
          return;
        }
        scheduleRetry(p);
      });
      hls.loadSource(ch.playUrl);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = ch.playUrl;               // Safari / iOS play HLS natively
      v.addEventListener('loadedmetadata', () => tryPlay(p), { once: true });
    } else {
      status(p, 'This browser cannot play HLS streams');
    }
  }

  // --------------------------------------------------------------------- panels
  let dragSrc = null;

  function buildPanel(p) {
    p.video = el('video', { playsInline: true, autoplay: true });
    p.video.addEventListener('playing', () => {
      status(p, ''); setLive(p, true); p.retries = 0; p.mediaRecovered = false;
    });
    p.video.addEventListener('error', () => { if (!p.hls && p.video.src) scheduleRetry(p); });

    p.numEl = el('span', { class: 'p-num' });
    p.nameEl = el('span', { class: 'p-name' });
    p.liveEl = el('span', { class: 'p-live' });
    p.statusEl = el('div', { class: 'p-status', role: 'status' });

    const top = el('div', {
      class: 'p-top', draggable: true, title: 'Drag to rearrange',
      ondragstart: (ev) => {
        dragSrc = p;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', 'panel');
      },
      ondragend: () => { dragSrc = null; panels.forEach((x) => x.node.classList.remove('drop')); },
    }, p.numEl, p.nameEl, p.liveEl);

    p.muteBtn = el('button', { class: 'icon-btn', onclick: () => setMuted(p, !p.muted) });
    p.volEl = el('input', {
      type: 'range', class: 'p-vol', min: 0, max: 100, step: 1, 'aria-label': 'Volume',
      oninput: () => {
        p.volume = p.volEl.value / 100;
        p.muted = p.volume === 0;
        syncAudio(p);
        if (!p.muted) p.video.play().catch(() => {});
        save();
      },
    });

    const ctl = el('div', { class: 'p-ctl' },
      p.muteBtn, p.volEl, el('span', { class: 'gap' }),
      el('button', { class: 'icon-btn', title: 'Change channel', 'aria-label': 'Change channel', html: ICON.swap, onclick: () => openPicker(p) }),
      el('button', { class: 'icon-btn', title: 'Fullscreen (F)', 'aria-label': 'Fullscreen', html: ICON.full, onclick: () => toggleFullscreen(p) }),
      el('button', { class: 'icon-btn close', title: 'Remove panel', 'aria-label': 'Remove panel', html: ICON.close, onclick: (ev) => { ev.stopPropagation(); removePanel(p); } }),
    );

    p.node = el('section', {
      class: 'panel',
      onclick: () => select(p),
      ondblclick: (ev) => { if (!ev.target.closest('.p-ctl')) toggleFullscreen(p); },
      ondragover: (ev) => {
        if (dragSrc && dragSrc !== p) { ev.preventDefault(); p.node.classList.add('drop'); }
      },
      ondragleave: () => p.node.classList.remove('drop'),
      ondrop: (ev) => {
        ev.preventDefault();
        p.node.classList.remove('drop');
        if (!dragSrc || dragSrc === p) return;
        const a = panels.indexOf(dragSrc), b = panels.indexOf(p);
        [panels[a], panels[b]] = [panels[b], panels[a]];
        render();
        save();
      },
    }, p.video, p.statusEl, top, ctl);
  }

  function addPanel(data, { persist = true } = {}) {
    if (panels.length >= maxPanels) { toast(`The wall is full (${maxPanels} panels)`); return null; }
    const p = {
      channelId: data.channelId ?? null,
      muted: data.muted !== false,
      volume: typeof data.volume === 'number' ? data.volume : 1,
      retries: 0, mediaRecovered: false, hls: null, retryTimer: null,
    };
    buildPanel(p);
    panels.push(p);
    wall.append(p.node);
    syncAudio(p);
    render();
    attach(p);
    if (persist) save();
    return p;
  }

  function removePanel(p) {
    detach(p);
    if (document.fullscreenElement === p.node) document.exitFullscreen();
    p.node.remove();
    panels.splice(panels.indexOf(p), 1);
    if (selected === p) selected = null;
    render();
    save();
  }

  function toggleFullscreen(p) {
    if (document.fullscreenElement === p.node) document.exitFullscreen();
    else p.node.requestFullscreen?.().catch(() => {});
  }

  // ------------------------------------------------------------- channel picker
  const picker = $('picker');
  let pickTarget = null;
  let pickCategory = '';

  function drawPicker() {
    const q = $('pickerSearch').value.trim().toLowerCase();
    const onWall = new Set(panels.map((p) => p.channelId));
    const list = channels.filter((c) =>
      (!pickCategory || c.category === pickCategory) &&
      (!q || c.name.toLowerCase().includes(q) || c.category.toLowerCase().includes(q)));

    $('pickerGrid').replaceChildren(...list.map((c) => {
      const logo = el('span', { class: 'ch-logo' });
      if (c.logoUrl) {
        const img = el('img', { src: c.logoUrl, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' });
        img.addEventListener('error', () => logo.replaceChildren(initials(c.name)));
        logo.append(img);
      } else logo.append(initials(c.name));
      return el('button', { class: `ch${onWall.has(c.id) ? ' onwall' : ''}`, onclick: () => choose(c) },
        logo,
        el('span', { class: 'ch-text' }, el('b', {}, c.name), el('small', {}, c.category || 'Uncategorised')));
    }));
    $('pickerEmpty').hidden = list.length > 0;
  }

  function openPicker(target = null) {
    if (!target && panels.length >= maxPanels) { toast(`The wall is full (${maxPanels} panels)`); return; }
    if (!channels.length) { toast('No channels have been set up yet'); return; }
    if (document.fullscreenElement && document.fullscreenElement !== document.documentElement) {
      document.exitFullscreen();
    }
    pickTarget = target;
    pickCategory = '';
    $('pickerTitle').textContent = target ? 'Change channel' : 'Add a channel';
    $('pickerSearch').value = '';

    const cats = [...new Set(channels.map((c) => c.category).filter(Boolean))].sort();
    const chips = $('pickerChips');
    const mk = (label, value) => el('button', {
      class: `chip${value === pickCategory ? ' on' : ''}`,
      onclick: () => {
        pickCategory = value;
        [...chips.children].forEach((b) => b.classList.toggle('on', b.dataset.v === value));
        drawPicker();
      },
      'data-v': value,
    }, label);
    chips.replaceChildren(...(cats.length > 1 ? [mk('All', ''), ...cats.map((c) => mk(c, c))] : []));

    drawPicker();
    picker.showModal();
    $('pickerSearch').focus();
  }

  function choose(c) {
    picker.close();
    if (pickTarget && panels.includes(pickTarget)) {
      pickTarget.channelId = c.id;
      pickTarget.retries = 0;
      attach(pickTarget);
      select(pickTarget);
      save();
    } else {
      // The first panel gets sound; later ones join muted so they do not talk over it.
      const p = addPanel({ channelId: c.id, muted: panels.length > 0, volume: 1 });
      if (p) select(p);
    }
  }

  $('pickerSearch').addEventListener('input', drawPicker);
  $('pickerClose').addEventListener('click', () => picker.close());
  picker.addEventListener('click', (ev) => { if (ev.target === picker) picker.close(); });

  // ----------------------------------------------------------- side panel wiring
  $('emptyAdd').addEventListener('click', () => openPicker());
  $('gridAdd').innerHTML = ICON.gridAdd;
  $('gridRemove').innerHTML = ICON.gridRemove;
  $('shareBtn').innerHTML = ICON.share;
  $('gridAdd').addEventListener('click', () => openPicker());
  $('gridRemove').addEventListener('click', () => { if (panels.length) removePanel(panels[panels.length - 1]); });

  $('sideMute').addEventListener('click', () => {
    const t = audioTarget();
    if (t) setMuted(t, !t.muted);
  });
  $('sideVol').addEventListener('input', () => {
    const t = audioTarget();
    if (!t) return;
    t.volume = $('sideVol').value / 100;
    t.muted = t.volume === 0;
    syncAudio(t);
    if (!t.muted) t.video.play().catch(() => {});
    save();
  });

  $('sideToggle').addEventListener('click', () => setSideCollapsed(!$('side').classList.contains('collapsed')));
  let startCollapsed = matchMedia('(max-width: 640px)').matches;
  try {
    const v = localStorage.getItem('mw.sideCollapsed');
    if (v !== null) startCollapsed = v === '1';
  } catch { /* storage off */ }
  setSideCollapsed(startCollapsed);

  // Options menu (placed with fixed positioning so the narrow panel cannot clip it)
  const optionsBtn = $('optionsBtn'), optionsMenu = $('optionsMenu');
  const closeOptions = () => { optionsMenu.hidden = true; optionsBtn.setAttribute('aria-expanded', 'false'); };
  optionsBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!optionsMenu.hidden) return closeOptions();
    const r = optionsBtn.getBoundingClientRect();
    optionsMenu.style.left = `${Math.round(r.left)}px`;
    optionsMenu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
    optionsMenu.hidden = false;
    optionsBtn.setAttribute('aria-expanded', 'true');
  });
  optionsMenu.addEventListener('click', closeOptions);
  document.addEventListener('click', closeOptions);

  $('muteAllBtn').addEventListener('click', () => {
    panels.forEach((p) => { p.muted = true; syncAudio(p); });
    save();
  });
  $('keysBtn').addEventListener('click', () => $('keysDialog').showModal());
  $('keysClose').addEventListener('click', () => $('keysDialog').close());

  const toggleWallFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $('wallFsBtn').addEventListener('click', toggleWallFs);
  document.addEventListener('fullscreenchange', () => {
    $('wallFsBtn').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen wall';
    layoutGrid();
  });

  // Share: the link carries the channel IDs in order, plus which panel has sound.
  function shareLink() {
    const url = new URL('/', location.origin);
    url.searchParams.set('wall', panels.map((p) => p.channelId ?? 0).join('.'));
    const heard = panels.findIndex((p) => !p.muted);
    if (heard >= 0) url.searchParams.set('audio', String(heard + 1));
    return url.href;
  }
  $('shareBtn').addEventListener('click', () => {
    $('shareUrl').value = shareLink();
    $('shareCopy').textContent = 'Copy link';
    $('shareDialog').showModal();
    $('shareUrl').select();
  });
  $('shareClose').addEventListener('click', () => $('shareDialog').close());
  $('shareCopy').addEventListener('click', async () => {
    const input = $('shareUrl');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      // The clipboard API needs https; on a plain-http LAN address fall back.
      input.select();
      document.execCommand('copy');
    }
    $('shareCopy').textContent = 'Copied';
  });

  // In fullscreen the bar and cursor hide until the pointer moves.
  let idleTimer;
  const wake = () => {
    document.body.classList.add('active');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.remove('active'), 2500);
  };
  document.addEventListener('mousemove', wake);
  document.addEventListener('keydown', wake);

  const userBtn = $('userBtn'), userMenu = $('userMenu');
  userBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    userMenu.hidden = !userMenu.hidden;
    userBtn.setAttribute('aria-expanded', String(!userMenu.hidden));
  });
  document.addEventListener('click', () => { userMenu.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); });

  $('logoutBtn').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login';
  });
  $('clearBtn').addEventListener('click', () => {
    if (panels.length && confirm('Remove all panels from your wall?')) [...panels].forEach(removePanel);
  });

  const pwDialog = $('pwDialog');
  $('pwBtn').addEventListener('click', () => {
    $('pwForm').reset(); $('pwError').textContent = ''; pwDialog.showModal();
  });
  $('pwCancel').addEventListener('click', () => pwDialog.close());
  $('pwForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: $('pwCurrent').value, next: $('pwNext').value } });
      pwDialog.close();
      toast('Password changed');
    } catch (e) { $('pwError').textContent = e.message; }
  });

  // ------------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (document.querySelector('dialog[open]')) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName) && ev.target.type !== 'range') return;
    const k = ev.key.toLowerCase();
    if (/^[1-9]$/.test(k)) { const p = panels[Number(k) - 1]; if (p) select(p); return; }
    if (k === 'a') { ev.preventDefault(); openPicker(); return; }
    if (k === 'w') { toggleWallFs(); return; }
    if (k === 'b') { setSideCollapsed(!$('side').classList.contains('collapsed')); return; }
    if (!selected) return;
    if (k === 'm') setMuted(selected, !selected.muted);
    else if (k === 's') solo(selected);
    else if (k === 'f') toggleFullscreen(selected);
  });

  new ResizeObserver(layoutGrid).observe(wall);

  // ----------------------------------------------------------------------- boot
  try {
    const info = await api('/api/me');
    me = info.user;
    maxPanels = info.maxPanels;
    document.title = info.appName;
    $('appName').textContent = info.appName;
    $('emptyTitle').textContent = info.appName;
    $('sideVersion').textContent = `v${info.version}`;
    $('menuVersion').textContent = `${info.appName} v${info.version}`;
    userBtn.textContent = `${me.displayName} ▾`;
    $('adminLink').hidden = me.role !== 'admin';
    $('pwBtn').hidden = me.provider !== 'local';

    channels = (await api('/api/channels')).channels;
    byId = new Map(channels.map((c) => [c.id, c]));

    if (!channels.length) {
      $('emptyText').textContent = me.role === 'admin'
        ? 'No channels yet. Open the admin console from the menu (top right) to add your HLS streams.'
        : 'No channels have been set up yet. Ask your administrator to add some.';
      $('emptyAdd').hidden = true;
    }

    const saved = await api('/api/layout');

    // A shared link (?wall=12.7.31&audio=2) replaces the wall. The login page
    // keeps the link in sessionStorage if the visitor had to sign in first.
    let shared = new URLSearchParams(location.search);
    if (!shared.has('wall')) {
      try { shared = new URLSearchParams(sessionStorage.getItem('mw.sharedWall') || ''); } catch { /* storage off */ }
    }
    try { sessionStorage.removeItem('mw.sharedWall'); } catch { /* storage off */ }
    const sharedIds = (shared.get('wall') || '').split('.').filter(Boolean).map(Number);
    if (location.search) history.replaceState(null, '', '/');

    if (sharedIds.length) {
      const known = sharedIds.filter((id) => byId.has(id));
      const heard = parseInt(shared.get('audio') || '0', 10);
      if (known.length < sharedIds.length) {
        toast(`${sharedIds.length - known.length} shared channel(s) are not available on this server`);
      }
      sharedIds.forEach((id, i) => {
        if (byId.has(id) && panels.length < maxPanels) {
          addPanel({ channelId: id, muted: i !== heard - 1, volume: 1 }, { persist: false });
        }
      });
      save();
    } else {
      (saved.panels || []).forEach((p) => addPanel(p, { persist: false }));
    }
    render();
  } catch (e) {
    console.error(e);
  }
})();
