(async () => {
  const $ = (id) => document.getElementById(id);
  const error = $('error');

  const query = new URLSearchParams(location.search);
  if (query.has('wall')) {
    // Remember a shared-wall link through either sign-in route (password or Microsoft).
    const keep = new URLSearchParams({ wall: query.get('wall'), audio: query.get('audio') || '' });
    try { sessionStorage.setItem('mw.sharedWall', keep.toString()); } catch { /* storage off */ }
    history.replaceState(null, '', '/login');
  }
  const fromQuery = query.get('error');
  if (fromQuery) {
    error.textContent = fromQuery;
    history.replaceState(null, '', '/login');
  }

  try {
    const cfg = await MW.api('/api/auth/config');
    document.title = `Sign in · ${cfg.appName}`;
    $('appName').textContent = cfg.appName;
    $('msBtn').hidden = !cfg.microsoft;
    $('form').hidden = !cfg.localLogin;
    $('divider').hidden = !(cfg.microsoft && cfg.localLogin);
    if (cfg.localLogin) $('username').focus();
  } catch (e) {
    error.textContent = 'Could not reach the server.';
  }

  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    error.textContent = '';
    $('submit').disabled = true;
    try {
      await MW.api('/api/auth/login', {
        method: 'POST',
        body: { username: $('username').value, password: $('password').value },
      });
      location.href = '/';
    } catch (e) {
      error.textContent = e.message;
      $('submit').disabled = false;
      $('password').select();
    }
  });
})();
