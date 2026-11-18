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

  // ---- header strip: a waveform-monitor trace of colour bars ----------------
  // One scrolling trace, in IRE units (sync tip -40, blanking 0, white 100):
  // front porch, horizontal sync dipping below blanking, colour burst on the
  // back porch, then the seven 75% colour bars, each drawn as its chroma band
  // in the bar's colour around its luminance. Every fourth line comes the
  // vertical sync interval: equalising pulses, serrated broad pulses,
  // equalising pulses.
  function mountWave(host) {
    if (!host) return;
    const NS = 'http://www.w3.org/2000/svg';
    // [colour, luma IRE, chroma peak-to-peak IRE] for 75% composite colour bars
    const BARS = [
      ['#d9dde3', 77, 0], ['#e6d44c', 69, 62], ['#4fd3db', 56, 88], ['#52cf6f', 48, 82],
      ['#cd5fd6', 36, 82], ['#e45656', 28, 88], ['#5470e6', 15, 62],
    ];
    const BAR_W = 13, LINES_PER_FIELD = 4;

    // Build one period of the signal as trace points plus chroma bands.
    function period() {
      const pts = [];            // [x, ire]
      const bands = [];          // [x, width, top ire, bottom ire, colour]
      let x = 0;
      const seg = (len, ire) => { pts.push([x, ire]); x += len; pts.push([x, ire]); };
      const line = () => {
        seg(3, 0);                                            // front porch
        seg(7, -40);                                          // horizontal sync
        seg(2, 0);                                            // breezeway
        for (let i = 0; i < 8; i++) { pts.push([x, i % 2 ? -20 : 20]); x += 1; }  // colour burst
        seg(2, 0);                                            // rest of back porch
        for (const [colour, luma, pp] of BARS) {
          if (pp) bands.push([x, BAR_W, luma + pp / 2, luma - pp / 2, colour]);
          seg(BAR_W, luma);
        }
      };
      for (let l = 0; l < LINES_PER_FIELD; l++) line();
      // vertical interval
      seg(3, 0);
      for (let i = 0; i < 6; i++) { seg(2, -40); seg(4, 0); }   // pre-equalising pulses
      for (let i = 0; i < 6; i++) { seg(5, -40); seg(1, 0); }   // serrated vertical sync
      for (let i = 0; i < 6; i++) { seg(2, -40); seg(4, 0); }   // post-equalising pulses
      seg(3, 0);
      return { pts, bands, width: x };
    }

    function draw() {
      const w = Math.floor(host.clientWidth), h = Math.floor(host.clientHeight);
      if (w < 40 || h < 8) { host.replaceChildren(); return; }
      const P = period();
      const y = (ire) => (h - 2) - ((ire + 45) / 150) * (h - 4);   // -45..105 IRE fills the height
      const copies = Math.ceil(w / P.width) + 1;

      let trace = '', bands = '';
      const byColour = new Map();
      for (let c = 0; c < copies; c++) {
        const off = c * P.width;
        P.pts.forEach(([px, ire], i) => { trace += `${i || c ? 'L' : 'M'}${(px + off).toFixed(1)},${y(ire).toFixed(1)}`; });
        for (const [bx, bw, top, bot, colour] of P.bands) {
          byColour.set(colour, (byColour.get(colour) || '') +
            `M${bx + off},${y(top).toFixed(1)}h${bw}V${y(bot).toFixed(1)}h-${bw}z`);
        }
      }
      for (const [colour, d] of byColour) bands += `<path d="${d}" style="fill:${colour}"/>`;

      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.setAttribute('width', w); svg.setAttribute('height', h);
      svg.setAttribute('aria-hidden', 'true');
      svg.innerHTML = `
        <g class="wave-grat">
          <line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>
          <line x1="0" x2="${w}" y1="${y(100).toFixed(1)}" y2="${y(100).toFixed(1)}"/>
        </g>
        <g class="wave-scroll">
          <g class="wave-bands">${bands}</g>
          <path class="wave-trace" d="${trace}"/>
        </g>`;
      host.style.setProperty('--wave-period', `${P.width}px`);
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
