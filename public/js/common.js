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

  // ---- header strip: colour bars as a waveform monitor draws them ------------
  // Mirrored vertical bars. Each scan line is a horizontal sync pulse followed
  // by the seven colour bars (white, yellow, cyan, green, magenta, red, blue),
  // each drawn in its own colour at its luminance level. Every few lines comes
  // the vertical sync interval: a run of tiny equalising / serrated pulses.
  // A brighter window sweeps across, like a scan.
  function mountWave(host) {
    if (!host) return;
    const NS = 'http://www.w3.org/2000/svg';
    const BAR = 3, GAP = 3, STEP = BAR + GAP;
    // [colour, luminance] for 75% colour bars, tuned to read on a dark header
    const BARS = [
      ['#d9dde3', 1.0], ['#e6d44c', 0.89], ['#4fd3db', 0.77], ['#52cf6f', 0.7],
      ['#cd5fd6', 0.59], ['#e45656', 0.48], ['#5470e6', 0.41],
    ];
    const HSYNC = '#6b7383', VSYNC = 'var(--accent)';
    const LINES_PER_FIELD = 4;
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

    function levels(count) {
      seed = 11;
      const out = [];          // [colour, height 0..1]
      let line = 0;
      while (out.length < count) {
        if (line > 0 && line % LINES_PER_FIELD === 0) {
          // vertical interval: equalising pulses, then serrated vsync, then equalising
          for (let i = 0; i < 12; i++) out.push([VSYNC, i % 2 ? 0.1 : (i > 3 && i < 8 ? 0.2 : 0.14)]);
        }
        out.push([HSYNC, 0.16], [HSYNC, 0.1], [HSYNC, 0.16]);   // horizontal sync + porch
        for (const [colour, luma] of BARS) {
          for (let i = 0; i < 3; i++) out.push([colour, (0.2 + luma * 0.74) * (0.96 + rnd() * 0.06)]);
        }
        line++;
      }
      return out.slice(0, count);
    }

    function draw() {
      const w = Math.floor(host.clientWidth), h = Math.floor(host.clientHeight);
      if (w < 40 || h < 8) { host.replaceChildren(); return; }
      const lv = levels(Math.floor((w + GAP) / STEP));
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('aria-hidden', 'true');
      const gid = `mwg${Math.random().toString(36).slice(2, 8)}`;
      svg.innerHTML = `<defs>
          <linearGradient id="${gid}s" x1="0" x2="1">
            <stop offset="0" stop-color="#fff" stop-opacity="0"/>
            <stop offset="0.35" stop-color="#fff" stop-opacity="1"/>
            <stop offset="0.65" stop-color="#fff" stop-opacity="1"/>
            <stop offset="1" stop-color="#fff" stop-opacity="0"/>
          </linearGradient>
          <mask id="${gid}m"><rect class="wave-sweep" x="0" y="0" width="${Math.round(w * 0.45)}" height="${h}" fill="url(#${gid}s)"/></mask>
        </defs>`;

      // one path per colour keeps the SVG small
      const paths = new Map();
      lv.forEach(([colour, v], i) => {
        const bh = Math.max(BAR, Math.round(v * (h - 2)));
        const x = i * STEP, y = (h - bh) / 2, r = BAR / 2;
        paths.set(colour, (paths.get(colour) || '') +
          `M${x},${y + r}a${r},${r} 0 0 1 ${BAR},0v${bh - BAR}a${r},${r} 0 0 1 -${BAR},0z`);
      });
      const group = (cls) => {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', cls);
        for (const [colour, d] of paths) {
          const p = document.createElementNS(NS, 'path');
          p.setAttribute('d', d);
          p.setAttribute('style', `fill:${colour}`);
          g.append(p);
        }
        return g;
      };
      const lit = group('wave-lit');
      lit.setAttribute('mask', `url(#${gid}m)`);
      svg.append(group('wave-dim'), lit);
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
