/*! CSAI chat widget. Install: <script src="https://YOUR-APP/widget.js" data-key="PUBLIC_KEY" async></script>
 *  Optional: data-lang="ko|en", data-user-name, data-user-email + data-user-hash (HMAC-SHA256(identity secret, email), computed on YOUR server).
 *  Security: UI lives in a Shadow DOM; every piece of server/visitor text is written with textContent (no HTML is ever parsed); no cookies are used (bearer token in sessionStorage). */
(function () {
  'use strict';
  if (window.__csaiWidget) return; window.__csaiWidget = true;
  var el = document.currentScript || document.querySelector('script[data-key][src*="widget.js"]');
  if (!el) return;
  var VERSION = '1.1.0', API = 1;                                                       // API = wire-contract major this build understands
  var KEY = el.getAttribute('data-key') || '';
  if (!/^[a-f0-9]{32}$/.test(KEY)) { console.warn('[csai] invalid data-key'); return; }
  var BASE = new URL(el.src).origin;
  var T = { ko: { open: '채팅 열기', close: '닫기', end: '상담 종료', send: '보내기', ph: '메시지를 입력하세요', label: '메시지', connecting: '연결 중…', live: '연결됨', offline: '오프라인 — 연결되면 자동으로 다시 시도합니다', retry: '다시 시도', sending: '전송 중…', failed: '전송 실패', ended: '상담이 종료되었거나 세션이 만료되었습니다. 메시지를 보내면 새 대화가 시작됩니다.', busy: '잠시 후 다시 시도해 주세요.', unavailable: '지금은 채팅을 사용할 수 없습니다.', unread: '새 메시지', you: '나', agent: '상담원', closeAria: '채팅 창 닫기' },
            en: { open: 'Open chat', close: 'Close', end: 'End chat', send: 'Send', ph: 'Type a message', label: 'Message', connecting: 'Connecting…', live: 'Connected', offline: 'Offline — retrying automatically', retry: 'Retry', sending: 'Sending…', failed: 'Failed to send', ended: 'This chat ended or the session expired. Send a message to start a new one.', busy: 'Please try again shortly.', unavailable: 'Chat is not available right now.', unread: 'New message', you: 'You', agent: 'Agent', closeAria: 'Close chat window' } };
  var L = T[(el.getAttribute('data-lang') || document.documentElement.lang || 'ko').slice(0, 2)] || T.ko;
  var S = (function () { try { return window.sessionStorage; } catch (e) { return null; } })(), P = (function () { try { return window.localStorage; } catch (e) { return null; } })();
  var get = function (s, k) { try { return s && s.getItem(k); } catch (e) { return null; } }, set = function (s, k, v) { try { if (s) { if (v == null) s.removeItem(k); else s.setItem(k, v); } } catch (e) { /* storage blocked: runs in memory */ } };
  var rid = function (n) { var a = new Uint8Array(n); (window.crypto || window.msCrypto).getRandomValues(a); return Array.prototype.map.call(a, function (b) { return (b % 36).toString(36); }).join(''); };

  var visitor = get(P, 'csai_v_' + KEY); if (!visitor || !/^[A-Za-z0-9_-]{8,64}$/.test(visitor)) { visitor = 'v' + rid(23); set(P, 'csai_v_' + KEY, visitor); }
  var st = { token: get(S, 'csai_t_' + KEY), cursor: get(S, 'csai_c_' + KEY) || '', conn: 'connecting', open: false, unread: 0, ended: false, cfg: { title: 'Chat', greeting: '', color: '#6E8BFF' }, fails: 0, abort: null, timer: null, pollTimer: null, session: null };
  var rows = new Map(), pending = new Map();

  // ---------- UI (Shadow DOM) ----------
  var host = document.createElement('div'); host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483000';
  var root = host.attachShadow({ mode: 'open' });
  var css = document.createElement('style');
  css.textContent = ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans KR",sans-serif}' +
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.fab{width:56px;height:56px;border-radius:50%;border:0;background:var(--c);color:var(--fg,#0a0a0b);font-size:24px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35);position:relative}' +
    '.fab:focus-visible,button:focus-visible,textarea:focus-visible,.log:focus-visible{outline:3px solid #fff;outline-offset:2px;box-shadow:0 0 0 5px #1a1a1d}@supports not selector(:focus-visible){.fab:focus,button:focus,textarea:focus,.log:focus{outline:3px solid #fff;outline-offset:2px}}' +
    '.dot{position:absolute;top:2px;right:2px;min-width:18px;height:18px;border-radius:9px;background:#f87171;color:#0a0a0b;font-size:11px;line-height:18px;text-align:center;padding:0 4px;font-weight:700}' +
    '.panel{position:absolute;right:0;bottom:68px;width:min(380px,calc(100vw - 32px));height:calc(100vh - 100px);height:min(560px,calc(100dvh - 100px));max-height:560px;background:#121214;color:#f4f4f5;border:1px solid #2a2a2f;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.5)}' +
    '.panel[hidden]{display:none}header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1a1a1d;border-bottom:1px solid #2a2a2f}header h2{margin:0;font-size:15px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    'header button{background:transparent;border:1px solid #74747e;color:#f4f4f5;border-radius:6px;min-height:36px;min-width:36px;padding:0 10px;font-size:13px;cursor:pointer;white-space:nowrap}' +
    '.stat{font-size:12px;padding:4px 12px;color:#a1a1aa;background:#121214;border-bottom:1px solid #2a2a2f}.stat.bad{color:#fbbf24}' +
    '.log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;overscroll-behavior:contain}.m{max-width:85%;padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}' +
    '.m.v{align-self:flex-end;background:var(--c);color:var(--fg,#0a0a0b)}.m.a{align-self:flex-start;background:#1a1a1d;border:1px solid #2a2a2f}.m.s{align-self:center;background:transparent;color:#a1a1aa;font-size:12px;text-align:center;max-width:95%}' +
    '.m small{display:block;font-size:11px;opacity:.85;margin-top:2px}.m.f small{color:#5b0a18;font-weight:700}.m.f{border:2px solid #b91c1c}.m button{background:none;border:0;text-decoration:underline;color:inherit;cursor:pointer;font-size:11px;padding:0}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #2a2a2f;background:#1a1a1d}textarea{flex:1;resize:none;min-height:44px;max-height:120px;border-radius:8px;border:1px solid #74747e;background:#0a0a0b;color:#f4f4f5;padding:10px;font-size:16px}' +
    'form button{min-width:64px;min-height:44px;border-radius:8px;border:0;background:var(--c);color:var(--fg,#0a0a0b);font-weight:600;font-size:14px;cursor:pointer}form button:disabled,textarea:disabled{opacity:.55;cursor:not-allowed}' +
    '@media (max-width:480px){.panel{position:fixed;top:8px;right:8px;bottom:8px;left:8px;width:auto;height:auto;max-height:none}.panel:not([hidden]) ~ .fab{display:none}}@media (prefers-reduced-motion:no-preference){.panel{animation:p .15s ease-out}@keyframes p{from{opacity:0;transform:translateY(8px)}}}';
  var fab = h('button', 'fab'), dot = h('span', 'dot'); fab.type = 'button'; fab.textContent = '💬'; fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-label', L.open); dot.hidden = true; dot.setAttribute('aria-hidden', 'true'); fab.appendChild(dot);
  var panel = h('div', 'panel'); panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', L.open); panel.id = 'csai-panel'; fab.setAttribute('aria-controls', 'csai-panel');
  var head = document.createElement('header'), title = document.createElement('h2'), endBtn = h('button'), closeBtn = h('button');
  endBtn.type = closeBtn.type = 'button'; endBtn.textContent = L.end; closeBtn.textContent = '✕'; closeBtn.setAttribute('aria-label', L.closeAria); head.append(title, endBtn, closeBtn);
  var stat = h('div', 'stat'); stat.setAttribute('role', 'status'); stat.setAttribute('aria-live', 'polite');
  var log = h('div', 'log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-relevant', 'additions'); log.tabIndex = 0; log.setAttribute('aria-label', L.label);
  var form = document.createElement('form'), ta = document.createElement('textarea'), send = h('button'); ta.rows = 1; ta.maxLength = 4000; ta.placeholder = L.ph; ta.setAttribute('aria-label', L.label); send.type = 'submit'; send.textContent = L.send; form.append(ta, send);
  panel.append(head, stat, log, form); root.append(css, panel, fab); 
  function h(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function fgFor(c) { var n = parseInt(c.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255, lin = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }, L1 = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); return (L1 + 0.05) / 0.05 >= 1.05 / (L1 + 0.05) ? '#0a0a0b' : '#ffffff'; }   // whichever of black/white has the better WCAG contrast on the accent colour
  function color(c) { c = /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#6E8BFF'; host.style.setProperty('--c', c); host.style.setProperty('--fg', fgFor(c)); }
  function line(cls, text, extra) { var m = h('div', 'm ' + cls), who = cls === 'v' ? L.you : cls === 'a' ? L.agent : ''; if (who) { var sr = h('span', 'sr'); sr.textContent = who + ': '; m.appendChild(sr); } m.appendChild(document.createTextNode(text)); m._text = text; if (extra) m.appendChild(extra); log.appendChild(m); log.scrollTop = log.scrollHeight; return m; }
  function setStat() { stat.className = 'stat' + (st.conn === 'offline' ? ' bad' : ''); stat.textContent = st.ended ? '' : st.conn === 'live' ? L.live : st.conn === 'offline' ? L.offline : L.connecting; }
  function setBadge() { dot.hidden = !st.unread; dot.textContent = st.unread > 9 ? '9+' : String(st.unread); fab.setAttribute('aria-label', st.unread ? L.open + ' (' + L.unread + ' ' + st.unread + ')' : L.open); }
  function lock(v) { ta.disabled = send.disabled = false; void v; }

  // ---------- network ----------
  function api(path, opt) {
    opt = opt || {}; var hd = { 'content-type': 'application/json', 'x-csai-widget-version': VERSION }; if (opt.auth && st.token) hd.authorization = 'Bearer ' + st.token;
    return fetch(BASE + '/api/v1/chat' + path, { method: opt.method || 'GET', headers: hd, body: opt.body ? JSON.stringify(opt.body) : undefined, credentials: 'omit', mode: 'cors', cache: 'no-store', signal: opt.signal });
  }
  function expired() {
    st.token = null; st.cursor = ''; set(S, 'csai_t_' + KEY, null); set(S, 'csai_c_' + KEY, null); stopStream(); stopPoll();
    if (!st.ended) { st.ended = true; line('s', L.ended); } st.conn = 'live'; setStat();
  }
  function ensureSession() {
    if (st.token) return Promise.resolve();
    if (st.session) return st.session;
    var body = { public_key: KEY, visitor_id: visitor }, n = el.getAttribute('data-user-name'), e = el.getAttribute('data-user-email'), hs = el.getAttribute('data-user-hash');
    if (n) body.name = n.slice(0, 120); if (e && hs) { body.email = e; body.email_hash = hs; }
    st.session = api('/sessions', { method: 'POST', body: body }).then(function (r) { if (!r.ok) throw new Error('s' + r.status); return r.json(); }).then(function (j) {
      st.token = j.data.token; st.cursor = ''; st.ended = false; set(S, 'csai_t_' + KEY, st.token); set(S, 'csai_c_' + KEY, ''); st.session = null; st.fails = 0;
    }, function (err) { st.session = null; throw err; });
    return st.session;
  }
  function addMessage(m) {
    if (!m || typeof m.id !== 'string' || rows.has(m.id)) return;
    if (m.created_at && (!st.cursor || m.created_at > st.cursor)) { st.cursor = m.created_at; set(S, 'csai_c_' + KEY, st.cursor); }
    var mine = m.direction === 'inbound', node = rows.get('p:' + m.id);
    var b = line(mine ? 'v' : 'a', String(m.body == null ? '' : m.body)); rows.set(m.id, b);
    if (!mine && !st.open) { st.unread++; setBadge(); }
    if (mine) { var p = Array.from(pending.values()).find(function (x) { return x.id === m.id; }); if (p) { p.el.remove(); pending.delete(p.cid); } } void node;
  }
  function stopStream() { if (st.abort) { st.abort.abort(); st.abort = null; } clearTimeout(st.timer); }
  function stopPoll() { clearInterval(st.pollTimer); st.pollTimer = null; }
  function parseSSE(buf, onEvent) {
    var parts = buf.split('\n\n'); var rest = parts.pop();
    parts.forEach(function (blk) { var ev = { type: 'message', data: '', id: '' }; blk.split('\n').forEach(function (l) { if (l[0] === ':') return; var i = l.indexOf(':'); if (i < 0) return; var f = l.slice(0, i), v = l.slice(i + 1).replace(/^ /, ''); if (f === 'event') ev.type = v; else if (f === 'data') ev.data += v; else if (f === 'id') ev.id = v; }); if (ev.data || ev.type === 'closed') onEvent(ev); });
    return rest;
  }
  function openStream() {
    if (!st.token || !st.open || st.abort) return; stopPoll();
    var ac = new AbortController(); st.abort = ac; st.conn = 'connecting'; setStat();
    var got = false, dog = setTimeout(function () { if (!got) { st.fails++; ac.abort(); } }, 8000);   // no byte within 8 s = a proxy is buffering the stream: give up on it
    var q = st.cursor ? '?after=' + encodeURIComponent(st.cursor) : '';
    api('/stream' + q, { auth: true, signal: ac.signal }).then(function (r) {
      if (r.status === 401) { expired(); return null; }
      if (!r.ok || !r.body) throw new Error('stream ' + r.status);
      var rd = r.body.getReader(), dec = new TextDecoder(), buf = '';
      return (function pump() { return rd.read().then(function (x) {
        if (x.done) return;
        if (!got) { got = true; clearTimeout(dog); st.conn = 'live'; st.fails = 0; stopPoll(); setStat(); }       // first bytes arrived: streaming works
        buf = parseSSE(buf + dec.decode(x.value, { stream: true }).replace(/\r\n/g, '\n'), function (ev) { if (ev.type === 'closed') { expired(); ac.abort(); } else { try { addMessage(JSON.parse(ev.data)); } catch (e) { /* ignore malformed event */ } } });
        return pump(); }); })();
    }).then(function () { clearTimeout(dog); reconnect(ac); }, function (err) { clearTimeout(dog); if (ac.signal.aborted && got) return; if (!got && !ac.signal.aborted) st.fails++; st.conn = st.fails >= 3 ? 'live' : 'offline'; setStat(); reconnect(ac); });
  }
  function reconnect(ac) {
    if (st.abort === ac) st.abort = null;
    if (!st.token || !st.open) return;
    if (ac.signal.aborted && !st.token) return;
    var wait = st.fails ? Math.min(30000, 1000 * Math.pow(2, st.fails - 1)) : 300;           // a normal 55 s rollover reconnects at once
    if (st.fails >= 3) { startPoll(); st.conn = 'live'; setStat(); wait = 120000; }          // streaming unusable (proxy/blocked): poll, and re-try the stream every 2 min
    st.timer = setTimeout(openStream, wait);
  }
  function startPoll() {
    if (st.pollTimer || !st.token) return;
    var tick = function () {
      if (!st.token) return stopPoll();
      api('/messages' + (st.cursor ? '?after=' + encodeURIComponent(st.cursor) : ''), { auth: true }).then(function (r) { if (r.status === 401) { expired(); return null; } if (!r.ok) throw new Error('poll'); return r.json(); })
        .then(function (j) { if (!j) return; st.conn = 'live'; setStat(); j.data.forEach(addMessage); }, function () { st.conn = 'offline'; setStat(); });
    };
    tick(); st.pollTimer = setInterval(tick, st.open ? 4000 : 20000);
  }
  function resume() {                                                                          // open: stream; closed: slow poll for the unread badge
    if (!st.token) return;
    stopStream(); stopPoll(); st.fails = 0;
    if (st.open) { startPollOnce(); openStream(); } else startPoll();
  }
  function startPollOnce() { api('/messages' + (st.cursor ? '?after=' + encodeURIComponent(st.cursor) : ''), { auth: true }).then(function (r) { if (r.status === 401) { expired(); return null; } return r.ok ? r.json() : null; }).then(function (j) { if (j) j.data.forEach(addMessage); }, function () {}); }

  function submit(text, cid, node) {
    var p = pending.get(cid) || { cid: cid, el: node };
    pending.set(cid, p);
    return ensureSession().then(function () { return api('/messages', { method: 'POST', auth: true, body: { body: text, client_id: cid } }); }).then(function (r) {
      if (r.status === 401) { expired(); return ensureSession().then(function () { resume(); return submit(text, cid, node); }); }
      if (r.status === 429) { fail(p, L.busy); return; }
      if (!r.ok) throw new Error('send ' + r.status);
      return r.json().then(function (j) {
        p.id = j.data.id; var small = p.el.querySelector('small'); if (small) small.remove();
        if (rows.has(p.id)) { p.el.remove(); } else { rows.set(p.id, p.el); }                  // the stream may have shown it first: keep exactly one bubble
        pending.delete(cid); if (!st.open || !st.abort) resume();
      });
    }).catch(function () { fail(p, L.failed); });
  }
  function fail(p, msg) {
    p.el.classList.add('f'); var s = p.el.querySelector('small') || document.createElement('small'); s.textContent = msg + ' '; var b = h('button'); b.type = 'button'; b.textContent = L.retry;
    b.onclick = function () { s.textContent = L.sending; var t = p.el._text; p.el.classList.remove('f'); submit(t, p.cid, p.el); }; s.appendChild(b); if (!s.parentNode) p.el.appendChild(s);
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault(); var t = ta.value.replace(/\s+$/, ''); if (!t.trim()) return; ta.value = ''; autosize();
    var cid = 'c' + rid(20), node = line('v', t, (function () { var s = document.createElement('small'); s.textContent = L.sending; return s; })());
    submit(t, cid, node);
  });
  ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true })); } });
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  ta.addEventListener('input', autosize);
  function openPanel() { st.open = true; st.unread = 0; setBadge(); panel.hidden = false; fab.setAttribute('aria-expanded', 'true'); setStat(); resume(); setTimeout(function () { ta.focus(); }, 0); }
  function closePanel() { st.open = false; panel.hidden = true; fab.setAttribute('aria-expanded', 'false'); stopStream(); if (st.token) { stopPoll(); startPoll(); } fab.focus(); }
  fab.addEventListener('click', function () { st.open ? closePanel() : openPanel(); });
  closeBtn.addEventListener('click', closePanel);
  panel.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closePanel(); } });
  endBtn.addEventListener('click', function () { if (!st.token) return; api('/end', { method: 'POST', auth: true }).catch(function () {}); st.ended = false; expired(); });
  window.addEventListener('online', function () { st.fails = 0; if (st.open) resume(); });
  window.addEventListener('offline', function () { st.conn = 'offline'; setStat(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && st.open && !st.abort) resume(); });
  window.addEventListener('pagehide', function () { stopStream(); stopPoll(); });
  window.CSAIChat = { open: openPanel, close: closePanel, version: VERSION };

  // ---------- boot ----------
  api('/config?public_key=' + KEY).then(function (r) { if (!r.ok) throw new Error('config'); return r.json(); }).then(function (j) {
    if (j.data.api > API) { console.warn('[csai] this widget build (v' + VERSION + ') is older than the server API; refusing to start. Reload to fetch the latest /widget.js.'); return; }
    st.cfg = j.data; title.textContent = st.cfg.title || 'Chat'; color(st.cfg.color); panel.setAttribute('aria-label', st.cfg.title || L.open);
    if (st.cfg.greeting) line('s', st.cfg.greeting);
    document.body.appendChild(host); setStat();
    if (st.token) { st.cursor = ''; startPollOnce(); startPoll(); }                              // restore after a reload: pull the whole history once (rows are de-duplicated by id)
  }).catch(function () { /* widget not available on this origin/state: render nothing */ });
})();
