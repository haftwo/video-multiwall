(async () => {
  const { api, el, toast } = MW;
  const $ = (id) => document.getElementById(id);

  let me = null;
  let channels = [];
  let users = [];

  const tag = (text, kind = '') => el('span', { class: `tag ${kind}` }, text);
  const when = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString() : 'Never');

  // ================================================================== channels
  async function loadChannels() {
    channels = (await api('/api/admin/channels')).channels;
    $('channelRows').replaceChildren(...(channels.length ? channels.map((c) =>
      el('tr', {},
        el('td', {}, c.sortOrder),
        el('td', {}, el('b', {}, c.name)),
        el('td', {}, c.category || '—'),
        el('td', { class: 'url', title: c.url }, c.url),
        el('td', {},
          c.enabled ? tag('Enabled', 'ok') : tag('Disabled', 'off'), ' ',
          c.proxy ? tag('Relayed', 'amber') : null),
        el('td', { class: 'acts' },
          el('button', { class: 'btn small', onclick: () => openChannel(c) }, 'Edit'),
          el('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!confirm(`Delete "${c.name}"? It will disappear from every wall.`)) return;
              await api(`/api/admin/channels/${c.id}`, { method: 'DELETE' });
              loadChannels();
            },
          }, 'Delete')))) : [
      el('tr', {}, el('td', { colspan: 6, class: 'note' }, 'No channels yet. Add your first HLS stream.')),
    ]));
    $('catList').replaceChildren(
      ...[...new Set(channels.map((c) => c.category).filter(Boolean))].map((c) => el('option', { value: c })));
  }

  const chDialog = $('channelDialog');
  let editingChannel = null;
  let previewHls = null;

  function stopPreview() {
    if (previewHls) { previewHls.destroy(); previewHls = null; }
    const v = $('chPreview');
    v.pause(); v.removeAttribute('src'); v.load(); v.hidden = true;
    $('chPreviewNote').hidden = true;
  }

  function openChannel(c = null) {
    editingChannel = c;
    $('channelTitle').textContent = c ? 'Edit channel' : 'Add channel';
    $('chName').value = c?.name ?? '';
    $('chUrl').value = c?.url ?? '';
    $('chCategory').value = c?.category ?? '';
    $('chSort').value = c?.sortOrder ?? (channels.length ? Math.max(...channels.map((x) => x.sortOrder)) + 1 : 0);
    $('chLogo').value = c?.logoUrl ?? '';
    $('chEnabled').checked = c ? c.enabled : true;
    $('chProxy').checked = c ? c.proxy : false;
    $('chError').textContent = '';
    stopPreview();
    chDialog.showModal();
    $('chName').focus();
  }

  // Plays the URL straight from the browser, exactly as a viewer would
  // without the relay. A failure here usually means the relay is needed.
  $('chTest').addEventListener('click', () => {
    const url = $('chUrl').value.trim();
    if (!url) return;
    stopPreview();
    const v = $('chPreview'), note = $('chPreviewNote');
    v.hidden = false; note.hidden = false;
    note.textContent = 'Testing direct playback from your browser…';
    const fail = () => {
      note.textContent = 'Direct playback failed. Check the URL; if it is correct, tick "Relay through this server", save, and try it on the wall.';
    };
    v.onplaying = () => { note.textContent = 'Plays directly. No relay needed.'; };
    if (window.Hls && Hls.isSupported()) {
      previewHls = new Hls();
      previewHls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) fail(); });
      previewHls.loadSource(url);
      previewHls.attachMedia(v);
      previewHls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; v.onerror = fail; v.play().catch(() => {});
    } else fail();
  });

  $('chCancel').addEventListener('click', () => chDialog.close());
  chDialog.addEventListener('close', stopPreview);
  $('channelForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {
      name: $('chName').value,
      url: $('chUrl').value,
      category: $('chCategory').value,
      sortOrder: parseInt($('chSort').value, 10) || 0,
      logoUrl: $('chLogo').value,
      enabled: $('chEnabled').checked,
      proxy: $('chProxy').checked,
    };
    try {
      if (editingChannel) await api(`/api/admin/channels/${editingChannel.id}`, { method: 'PUT', body });
      else await api('/api/admin/channels', { method: 'POST', body });
      chDialog.close();
      toast('Channel saved');
      loadChannels();
    } catch (e) { $('chError').textContent = e.message; }
  });
  $('addChannelBtn').addEventListener('click', () => openChannel());

  // ---- import: CSV (the exported channel-list format) or M3U
  const isHttp = (u) => /^https?:\/\//i.test(u || '');

  function parseM3U(text) {
    const out = [];
    let pending = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF')) {
        const attr = (k) => (line.match(new RegExp(`${k}="([^"]*)"`, 'i')) || [])[1] || '';
        pending = {
          name: line.slice(line.lastIndexOf(',') + 1).trim(),
          category: attr('group-title'),
          logoUrl: attr('tvg-logo'),
        };
      } else if (!line.startsWith('#')) {
        if (isHttp(line)) {
          out.push({ ...(pending || {}), name: pending?.name || line.split('/').pop() || 'Channel', url: line });
        }
        pending = null;
      }
    }
    return out;
  }

  // RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes.
  function csvRows(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((f) => f.trim()));
  }

  function parseCSV(text) {
    const rows = csvRows(text);
    if (rows.length < 2) return { error: 'The CSV needs a header row and at least one channel.' };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const col = (...names) => head.findIndex((h) => names.some((n) => h === n || h.startsWith(`${n} `)));
    const ci = {
      name: col('name', 'channel'),
      url: col('hls url', 'url', 'stream url', 'stream'),
      group: col('group', 'category'),
      status: col('status at capture', 'status'),
      playback: col('browser playback', 'relay', 'proxy'),
      logo: col('logo', 'logo url', 'tvg-logo'),
    };
    if (ci.name < 0 || ci.url < 0) return { error: 'The CSV header must include "Name" and "HLS URL" columns.' };
    const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    const items = [];
    let badRows = 0;
    for (const r of rows.slice(1)) {
      const url = get(r, ci.url);
      if (!isHttp(url)) { badRows++; continue; }
      const status = get(r, ci.status).toLowerCase();
      const playback = get(r, ci.playback).toLowerCase();
      items.push({
        name: get(r, ci.name) || url.split('/').pop(),
        url,
        category: get(r, ci.group),
        logoUrl: get(r, ci.logo),
        proxy: /relay|proxy|^(yes|true|1)$/.test(playback),
        // Rows the list marked offline come in switched off, ready to re-enable later.
        enabled: !(/offline|unreachable|frozen|dead|down/.test(status) || /offline/.test(playback)),
      });
    }
    return { items, badRows };
  }

  function parseImport(text) {
    const t = text.trimStart();
    if (!t) return { items: [] };
    if (t.startsWith('#EXTM3U') || t.startsWith('#EXTINF')) return { items: parseM3U(t), badRows: 0, format: 'M3U' };
    return { ...parseCSV(t), format: 'CSV' };
  }

  const importDialog = $('importDialog');
  let pendingImport = [];

  function previewImport() {
    const res = parseImport($('importText').value);
    $('importError').textContent = res.error || '';
    const existing = new Set(channels.map((c) => c.url));
    const all = res.items || [];
    const fresh = $('importSkipDupes').checked ? all.filter((it) => !existing.has(it.url)) : all;
    pendingImport = fresh;
    $('importSubmit').disabled = fresh.length === 0;
    $('importSubmit').textContent = fresh.length ? `Import ${fresh.length} channel${fresh.length === 1 ? '' : 's'}` : 'Import';
    if (!all.length) { $('importSummary').textContent = ''; return; }
    const relayAll = $('importProxy').checked;
    const parts = [`${res.format}: ${all.length} channel${all.length === 1 ? '' : 's'} found`];
    const dupes = all.length - fresh.length;
    if (dupes) parts.push(`${dupes} already on the list (skipped)`);
    const relayed = relayAll ? fresh.length : fresh.filter((i) => i.proxy).length;
    if (relayed) parts.push(`${relayed} relayed`);
    const off = fresh.filter((i) => i.enabled === false).length;
    if (off) parts.push(`${off} marked offline (imported disabled)`);
    if (res.badRows) parts.push(`${res.badRows} row${res.badRows === 1 ? '' : 's'} without a valid URL ignored`);
    $('importSummary').textContent = `${parts.join(' · ')}.`;
  }

  $('importBtn').addEventListener('click', () => {
    $('importForm').reset();
    $('importError').textContent = ''; $('importSummary').textContent = '';
    pendingImport = []; $('importSubmit').disabled = true; $('importSubmit').textContent = 'Import';
    importDialog.showModal();
  });
  $('importFile').addEventListener('change', async () => {
    const f = $('importFile').files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { $('importError').textContent = 'That file is larger than 2 MB.'; return; }
    $('importText').value = await f.text();
    previewImport();
  });
  ['input', 'change'].forEach((e) => $('importText').addEventListener(e, previewImport));
  $('importSkipDupes').addEventListener('change', previewImport);
  $('importProxy').addEventListener('change', previewImport);
  $('importCancel').addEventListener('click', () => importDialog.close());

  $('importForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!pendingImport.length) return;
    const btn = $('importSubmit');
    btn.disabled = true;
    const relayAll = $('importProxy').checked;
    let order = channels.length ? Math.max(...channels.map((x) => x.sortOrder)) + 1 : 0;
    let ok = 0, failed = 0;
    for (const it of pendingImport) {
      btn.textContent = `Importing ${ok + failed + 1} of ${pendingImport.length}…`;
      try {
        await api('/api/admin/channels', {
          method: 'POST',
          body: {
            name: it.name, url: it.url, category: it.category || '',
            logoUrl: isHttp(it.logoUrl) ? it.logoUrl : '',
            proxy: relayAll || !!it.proxy,
            enabled: it.enabled !== false,
            sortOrder: order++,
          },
        });
        ok++;
      } catch { failed++; }
    }
    importDialog.close();
    toast(`Imported ${ok} channel${ok === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}`);
    loadChannels();
  });

  // ===================================================================== users
  async function loadUsers() {
    const data = await api('/api/admin/users');
    users = data.users;
    $('userRows').replaceChildren(...users.map((u) => {
      const self = u.id === me.id;
      return el('tr', {},
        el('td', {}, el('b', {}, u.displayName || u.username), self ? ' (you)' : '',
          el('div', { class: 'note' }, u.username)),
        el('td', {}, u.provider === 'entra'
          ? [tag('Microsoft'), ' ', u.linked ? null : tag('Awaiting first sign-in', 'amber')]
          : tag('Password')),
        el('td', {}, u.role === 'admin' ? tag('Administrator', 'amber') : tag('Viewer')),
        el('td', {}, u.enabled ? tag('Active', 'ok') : tag('Disabled', 'off')),
        el('td', {}, when(u.lastLogin)),
        el('td', { class: 'acts' },
          el('button', { class: 'btn small', onclick: () => openUser(u) }, 'Edit'),
          self ? null : el('button', {
            class: 'btn small',
            onclick: async () => {
              try {
                await api(`/api/admin/users/${u.id}`, { method: 'PUT', body: { enabled: !u.enabled } });
                loadUsers();
              } catch (e) { toast(e.message); }
            },
          }, u.enabled ? 'Disable' : 'Enable'),
          self ? null : el('button', {
            class: 'btn small danger',
            onclick: async () => {
              if (!confirm(`Delete ${u.username}? Their saved wall is removed too.`)) return;
              try {
                await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
                loadUsers();
              } catch (e) { toast(e.message); }
            },
          }, 'Delete')));
    }));

    const s = data.sso;
    const row = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
    $('ssoInfo').replaceChildren(...[
      row('Status', s.enabled ? 'Enabled' : 'Not configured (set ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET)'),
      row('Redirect URI', s.redirectUri || `${location.origin}/auth/microsoft/callback  (set BASE_URL to pin this)`),
      row('New Microsoft users', s.autoProvision
        ? 'Created automatically as viewers on first sign-in'
        : 'Must be pre-approved here by email'),
      row('Allowed email domains', s.allowedDomains.length ? s.allowedDomains.join(', ') : 'Any account in your tenant'),
      row('Always administrators', s.adminEmails.length ? s.adminEmails.join(', ') : 'None'),
    ].flat());
  }

  const userDialog = $('userDialog');
  let editingUser = null;

  function syncUserForm() {
    const entra = (editingUser ? editingUser.provider : $('uProvider').value) === 'entra';
    $('uProviderWrap').hidden = !!editingUser;
    $('uUsernameWrap').hidden = !!editingUser || entra;
    $('uEmailWrap').hidden = !!editingUser || !entra;
    $('uPasswordWrap').hidden = entra;
    $('uPasswordLabel').textContent = editingUser
      ? 'New password (leave blank to keep the current one)'
      : 'Password (8+ characters)';
    $('uUsername').required = !editingUser && !entra;
    $('uEmail').required = !editingUser && entra;
    $('uPassword').required = !editingUser && !entra;
  }

  function openUser(u = null) {
    editingUser = u;
    $('userForm').reset();
    $('userTitle').textContent = u ? `Edit ${u.username}` : 'Add user';
    $('uDisplay').value = u?.displayName ?? '';
    $('uRole').value = u?.role ?? 'user';
    $('uRole').disabled = !!u && u.id === me.id;
    $('uError').textContent = '';
    syncUserForm();
    userDialog.showModal();
  }

  $('uProvider').addEventListener('change', syncUserForm);
  $('uCancel').addEventListener('click', () => userDialog.close());
  $('addUserBtn').addEventListener('click', () => openUser());
  $('userForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      if (editingUser) {
        const body = { displayName: $('uDisplay').value, role: $('uRole').value };
        if ($('uPassword').value) body.password = $('uPassword').value;
        await api(`/api/admin/users/${editingUser.id}`, { method: 'PUT', body });
      } else {
        await api('/api/admin/users', {
          method: 'POST',
          body: {
            provider: $('uProvider').value,
            username: $('uUsername').value,
            email: $('uEmail').value,
            displayName: $('uDisplay').value,
            password: $('uPassword').value,
            role: $('uRole').value,
          },
        });
      }
      userDialog.close();
      toast('User saved');
      loadUsers();
    } catch (e) { $('uError').textContent = e.message; }
  });

  // ====================================================================== boot
  const info = await api('/api/me');
  me = info.user;
  document.title = `Admin · ${info.appName}`;
  $('appName').textContent = info.appName;
  $('adminVersion').textContent = `· v${info.version}`;
  await Promise.all([loadChannels(), loadUsers()]);
})();
