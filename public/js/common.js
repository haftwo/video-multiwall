// Shared helpers for every page.
window.MW = (() => {
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: {
        'X-Requested-With': 'multiwall',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      location.href = '/login';
      throw new Error('Signed out');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // el('div', { class: 'x', onclick: fn }, child, 'text', ...)
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v; // only ever used with constant icon markup
      else if (k in node && k !== 'list') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  let toastTimer;
  function toast(msg) {
    document.querySelector('.toast')?.remove();
    const t = el('div', { class: 'toast', role: 'status' }, msg);
    // Append inside an open dialog if there is one, so it is not hidden behind it.
    (document.querySelector('dialog[open]') || document.body).append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2600);
  }

  const initials = (name) =>
    name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

  // ---- header strip: a video waveform drawn as mirrored vertical bars -------
  // Each group of bars is one scan line as a waveform monitor shows it: a sync
  // pulse, then either the colour-bar luminance staircase or a stretch of
  // "picture". A brighter window sweeps across, like a scan.
  function mountWave(host) {
    if (!host) return;
    const NS = 'http://www.w3.org/2000/svg';
    const BAR = 3, GAP = 3, STEP = BAR + GAP;
    const STAIRS = [1, 0.89, 0.77, 0.7, 0.59, 0.48, 0.41];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    function levels(count) {
      seed = 7;
      const out = [];
      let line = 0;
      while (out.length < count) {
        out.push(['porch', 0.16], ['sync', 0.1], ['sync', 0.1], ['porch', 0.16]);    // sync tip + back porch
        if (line % 3 !== 2) {
          // picture line: a smooth, organic envelope (two slow waves plus a little noise)
          const p1 = rnd() * 6.28, p2 = rnd() * 6.28, amp = 0.55 + rnd() * 0.35;
          for (let i = 0; i < 30; i++) {
            const v = 0.46 + amp * (0.32 * Math.sin(i * 0.33 + p1) + 0.16 * Math.sin(i * 0.95 + p2)) + (rnd() - 0.5) * 0.06;
            out.push(['pic', Math.min(0.96, Math.max(0.12, v))]);
          }
        } else {
          // colour bars: the seven-step luminance staircase, with a touch of noise
          for (const lvl of STAIRS) for (let i = 0; i < 3; i++) out.push(['pic', (0.18 + lvl * 0.7) * (0.96 + rnd() * 0.08)]);
        }
        line++;
      }
      return out.slice(0, count);
    }

    function draw() {
      const w = Math.floor(host.clientWidth), h = Math.floor(host.clientHeight);
      if (w < 40 || h < 8) { host.replaceChildren(); return; }
      const n = Math.floor((w + GAP) / STEP);
      const lv = levels(n);
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('aria-hidden', 'true');
      const gid = `mwg${Math.random().toString(36).slice(2, 8)}`;
      svg.innerHTML = `<defs>
          <linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stop-color="#7c7cf0"/><stop offset="1" stop-color="#2cc6b8"/>
          </linearGradient>
          <linearGradient id="${gid}s" x1="0" x2="1">
            <stop offset="0" stop-color="#fff" stop-opacity="0"/>
            <stop offset="0.35" stop-color="#fff" stop-opacity="1"/>
            <stop offset="0.65" stop-color="#fff" stop-opacity="1"/>
            <stop offset="1" stop-color="#fff" stop-opacity="0"/>
          </linearGradient>
          <mask id="${gid}m"><rect class="wave-sweep" x="0" y="0" width="${Math.round(w * 0.45)}" height="${h}" fill="url(#${gid}s)"/></mask>
        </defs>`;
      const bars = (cls) => {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', cls);
        let d = '';
        lv.forEach(([kind, v], i) => {
          const bh = Math.max(BAR, Math.round(v * (h - 2)));
          const x = i * STEP, y = (h - bh) / 2, r = BAR / 2;
          // rounded vertical bar as a path (one element for the whole group)
          d += `M${x},${y + r}a${r},${r} 0 0 1 ${BAR},0v${bh - BAR}a${r},${r} 0 0 1 -${BAR},0z`;
        });
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', `url(#${gid})`);
        g.append(path);
        return g;
      };
      const dim = bars('wave-dim');
      const lit = bars('wave-lit');
      lit.setAttribute('mask', `url(#${gid}m)`);
      // sync pulses picked out in the accent colour, like the blanking interval on a monitor
      const sync = document.createElementNS(NS, 'g');
      sync.setAttribute('class', 'wave-sync');
      lv.forEach(([kind], i) => {
        if (kind !== 'sync') return;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', i * STEP); r.setAttribute('y', (h - BAR * 2) / 2);
        r.setAttribute('width', BAR); r.setAttribute('height', BAR * 2); r.setAttribute('rx', BAR / 2);
        sync.append(r);
      });
      svg.append(dim, lit, sync);
      host.style.setProperty('--wave-w', `${w}px`);
      host.replaceChildren(svg);
    }

    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(draw, 60); }).observe(host);
    draw();
  }

  document.addEventListener('DOMContentLoaded', () => mountWave(document.querySelector('.bar-wave')));
  if (document.readyState !== 'loading') mountWave(document.querySelector('.bar-wave'));

  return { api, el, toast, initials };
})();
