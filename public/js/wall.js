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
    $('addBtn').disabled = n >= maxPanels;
    layoutGrid();
  }

  function select(p) {
    selected = p || null;
    panels.forEach((x) => x.node.classList.toggle('selected', x === selected));
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

  // -------------------------------------------------------------------- top bar
  $('addBtn').addEventListener('click', () => openPicker());
  $('emptyAdd').addEventListener('click', () => openPicker());
  $('muteAllBtn').addEventListener('click', () => {
    panels.forEach((p) => { p.muted = true; syncAudio(p); });
    save();
  });

  const toggleWallFs = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  };
  $('wallFsBtn').addEventListener('click', toggleWallFs);
  document.addEventListener('fullscreenchange', () => {
    $('wallFsBtn').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    layoutGrid();
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
    (saved.panels || []).forEach((p) => addPanel(p, { persist: false }));
    render();
  } catch (e) {
    console.error(e);
  }
})();
