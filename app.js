// =============================================================================
// Amlak One — Driver Reservation System :: APP LOGIC (vanilla JS)
// =============================================================================
const SB = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let me = null;          // auth user
let profile = null;     // public.profiles row
let myDriverId = null;  // drivers.id if I am a driver
let realtimeChan = null;
let pendingPhone = '';  // E.164 phone awaiting OTP verification
let mgrFilter = 'all';  // manager status filter
let mgrDate = '';       // manager day filter (YYYY-MM-DD or '')
let drvFilter = 'pending';
let drvDate = '';       // driver day filter

const $ = (id) => document.getElementById(id);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
const esc = (s) => (s == null ? '' : String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

// ---------- date helpers ----------
const fmtDateTime = (iso) => iso ? new Date(iso).toLocaleString('en-GB', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' }) : '—';
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
// local YYYY-MM-DD (not UTC) so grouping matches the user's day
const dayKey = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const todayKey = () => dayKey(new Date());
const toISO = (localValue) => localValue ? new Date(localValue).toISOString() : null;

function dayLabel(dkey) {
  const t = todayKey();
  const tmr = dayKey(new Date(Date.now() + 86400000));
  if (dkey === t) return '📅 Today';
  if (dkey === tmr) return '📅 Tomorrow';
  return '📅 ' + new Date(dkey + 'T00:00').toLocaleDateString('en-GB', { weekday:'short', day:'2-digit', month:'short', year:'numeric' });
}
function groupByDay(rows) {
  const map = {};
  rows.forEach(r => { const k = dayKey(r.pickup_at); (map[k] = map[k] || []).push(r); });
  return Object.keys(map).sort().map(k => ({ key:k, label:dayLabel(k), items:map[k] }));
}

// ---------- UAE phone helpers (accept 05x…, 9715x…, +9715x…, 009715x…) ----------
function normPhoneDigits(input) {
  let d = (input || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);                       // 00971… -> 971…
  if (d.startsWith('0')) d = '971' + d.slice(1);                // 05x…   -> 9715x…
  else if (!d.startsWith('971') && d.length === 9 && d.startsWith('5')) d = '971' + d; // 5x…
  return d;
}
const toE164 = (input) => { const d = normPhoneDigits(input); return d ? '+' + d : ''; };
const validUaePhone = (input) => /^971\d{9}$/.test(normPhoneDigits(input)); // 971 + 9 digits

const statusBadge = (s) => `<span class="badge s-${s}">${s.replace('_',' ')}</span>`;

// ---------- map helpers (Leaflet + OpenStreetMap, no API key) ----------
const ABU_DHABI = [24.4539, 54.3773];
const STATUS_COLORS = { pending:'#e0a106', accepted:'#23b26b', rejected:'#e25555', completed:'#3b82f6', cancelled:'#8a97a8', no_show:'#e0a106' };
const _leafletMaps = {};

// Try to pull "lat,lng" out of a pasted Google/Apple maps URL.
// Priority: the real place pin (!3d!4d) > query params > viewport (@) > bare pair.
function parseLatLng(url) {
  if (!url) return null;
  const place = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);            // actual place
  if (place) return { lat: +place[1], lng: +place[2] };
  const qp = url.match(/[?&](?:q|query|ll|destination|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (qp) return { lat: +qp[1], lng: +qp[2] };
  const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);                  // viewport (fallback)
  if (at) return { lat: +at[1], lng: +at[2] };
  const bare = url.match(/(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/);
  if (bare) return { lat: +bare[1], lng: +bare[2] };
  return null;                                                         // e.g. shortened maps.app.goo.gl
}

// Render read-only markers for a set of reservations into a div. Returns count plotted.
function buildVisitMap(divId, rows) {
  if (_leafletMaps[divId]) { _leafletMaps[divId].remove(); delete _leafletMaps[divId]; }
  const map = L.map(divId).setView(ABU_DHABI, 10);
  _leafletMaps[divId] = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const pts = [];
  rows.filter(r => r.lat != null && r.lng != null).forEach(r => {
    const mk = L.circleMarker([r.lat, r.lng], {
      radius: 9, color: '#fff', weight: 2,
      fillColor: STATUS_COLORS[r.status] || '#23b26b', fillOpacity: 0.9
    }).addTo(map);
    mk.bindPopup(
      `<b>${esc(r.client_name)}</b><br>${esc(r.purpose.replace('_',' '))} · ${esc(r.status)}<br>`
      + `🕑 ${fmtDateTime(r.pickup_at)}<br>`
      + (r.driver?.full_name ? `🚗 ${esc(r.driver.full_name)}<br>` : '')
      + (r.location_text ? `📍 ${esc(r.location_text)}<br>` : '')
      + (r.location_url ? `<a href="${esc(r.location_url)}" target="_blank">Open in Maps</a>` : '')
    );
    pts.push([r.lat, r.lng]);
  });
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
  setTimeout(() => map.invalidateSize(), 60);
  return pts.length;
}

// =============================================================================
// BOOT
// =============================================================================
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  if (!CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.includes('YOUR_PROJECT_REF') ||
      CONFIG.SUPABASE_ANON_KEY.includes('YOUR_ANON')) {
    $('loginView').classList.add('hidden');
    $('configWarn').classList.remove('hidden');
    return;
  }
  wireLogin();
  const { data: { session } } = await SB.auth.getSession();
  if (session) await onSignedIn(session.user);

  SB.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user && !me) onSignedIn(session.user);
    if (event === 'SIGNED_OUT') location.reload();
  });
}

// =============================================================================
// LOGIN
// =============================================================================
const ALLOWED_EMAIL_DOMAIN = '@amlakone.ae';

function wireLogin() {
  // If opened from the Sales QR, show the sign-up banner and make name required.
  const params = new URLSearchParams(location.search);
  if (params.get('signup') === 'sales') {
    $('salesBanner').classList.remove('hidden');
    $('loginTitle').textContent = 'Reserve a Driver';
    $('loginSubtitle').textContent = 'Amlak One sales — sign up with your company email + phone.';
    $('nameReq').classList.remove('hidden');
  }

  $('segEmail').onclick = () => { $('segEmail').classList.add('active'); $('segPhone').classList.remove('active'); $('emailBox').classList.remove('hidden'); $('phoneBox').classList.add('hidden'); };
  $('segPhone').onclick = () => { $('segPhone').classList.add('active'); $('segEmail').classList.remove('active'); $('phoneBox').classList.remove('hidden'); $('emailBox').classList.add('hidden'); };

  $('btnEmailLogin').onclick = async () => {
    setMsg('');
    const email = $('loginEmail').value.trim();
    const password = $('loginPassword').value;
    if (!email || !password) return setMsg('Enter email and password.', true);
    $('btnEmailLogin').disabled = true;
    const { error } = await SB.auth.signInWithPassword({ email, password });
    $('btnEmailLogin').disabled = false;
    if (error) setMsg(error.message, true);
  };

  $('btnSendOtp').onclick = async () => {
    setMsg('');
    const rawPhone = $('loginPhone').value.trim();
    const coEmail = $('loginCoEmail').value.trim().toLowerCase();
    const full_name = $('loginName').value.trim();
    if (!validUaePhone(rawPhone)) return setMsg('Enter a UAE mobile, e.g. 0501234567 or 971501234567', true);
    if (coEmail && !coEmail.endsWith(ALLOWED_EMAIL_DOMAIN))
      return setMsg(`Company email must end with ${ALLOWED_EMAIL_DOMAIN}`, true);
    pendingPhone = toE164(rawPhone);
    $('btnSendOtp').disabled = true;
    const { error } = await SB.auth.signInWithOtp({
      phone: pendingPhone,
      options: { data: { full_name: full_name || undefined, email: coEmail || undefined } }
    });
    $('btnSendOtp').disabled = false;
    if (error) return setMsg(error.message, true);
    $('phoneStep1').classList.add('hidden');
    $('phoneStep2').classList.remove('hidden');
    setMsg('Code sent. Check your SMS.', false);
  };
  $('btnVerifyOtp').onclick = async () => {
    setMsg('');
    const token = $('loginOtp').value.trim();
    const { error } = await SB.auth.verifyOtp({ phone: pendingPhone, token, type: 'sms' });
    if (error) setMsg(error.message, true);
  };
  $('btnOtpBack').onclick = () => { $('phoneStep2').classList.add('hidden'); $('phoneStep1').classList.remove('hidden'); setMsg(''); };
}

function setMsg(text, isErr) {
  const box = $('loginMsg');
  box.innerHTML = text ? `<div class="${isErr ? 'err' : 'ok-msg'}">${esc(text)}</div>` : '';
}

// =============================================================================
// SESSION
// =============================================================================
async function onSignedIn(user) {
  me = user;
  // Reconcile role with the Drivers list (handles a phone added as driver after signup)
  try { await SB.rpc('sync_my_driver_link'); } catch (e) { /* function may not exist yet */ }
  const { data, error } = await SB.from('profiles').select('*').eq('id', user.id).single();
  if (error) { setMsg('Could not load your profile: ' + error.message, true); return; }
  profile = data;

  if (profile.role === 'driver') {
    const { data: d } = await SB.from('drivers').select('id').eq('profile_id', user.id).maybeSingle();
    myDriverId = d?.id || null;
  }

  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('whoName').textContent = profile.full_name || '';
  $('whoRole').textContent = profile.role.replace('_', ' ');
  $('btnLogout').onclick = async () => { await SB.auth.signOut(); };

  if (!profile.is_active) { renderAwaitingApproval(); return; }

  subscribeRealtime();
  routeHome();
}

function renderAwaitingApproval() {
  $('appMain').innerHTML = `
    <div class="card" style="max-width:520px;margin:40px auto;text-align:center">
      <h2>⏳ Awaiting approval</h2>
      <p class="muted">Your account <b>${esc(profile.phone || profile.full_name)}</b> isn't activated yet.
      An administrator needs to add you to the team and assign your role.</p>
      <p class="muted">Once approved, sign in again.</p>
    </div>`;
}

function isManager() { return ['sales_manager', 'operation_manager', 'admin'].includes(profile.role); }
function isSales() { return ['sales', 'sales_manager', 'operation_manager', 'admin'].includes(profile.role); }

function subscribeRealtime() {
  if (realtimeChan) return;
  realtimeChan = SB.channel('res-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => {
      if (typeof window.__refresh === 'function') window.__refresh();
    }).subscribe();
}

// =============================================================================
// ROUTER (role-based home)
// =============================================================================
function routeHome() {
  if (profile.role === 'driver') return renderDriver();
  if (isManager()) return renderManager();
  return renderSales();
}

// =============================================================================
// SALES VIEW
// =============================================================================
async function renderSales() {
  const main = $('appMain');
  main.innerHTML = `
    ${deeplinkBanner()}
    <div class="card">
      <h2>New reservation</h2>
      <div class="grid cols-2">
        <div><label>Client name *</label><input id="f_client" placeholder="Mr. Hassan Al Marri"/></div>
        <div><label>Client phone</label><input id="f_clientphone" placeholder="0501234567 or 971501234567"/></div>
        <div>
          <label>Purpose *</label>
          <select id="f_purpose">
            <option value="viewing">Viewing</option>
            <option value="meeting">Meeting</option>
            <option value="site_visit">Site visit</option>
            <option value="pickup">Pickup</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div><label>Driver *</label><select id="f_driver"><option>Loading…</option></select></div>
        <div><label>Pickup date & time *</label><input id="f_pickup" type="datetime-local"/></div>
        <div><label>Return date & time</label><input id="f_return" type="datetime-local"/></div>
        <div><label>Location</label><input id="f_loc" placeholder="Saadiyat Island, Villa 12"/></div>
        <div><label>Map link</label><input id="f_locurl" placeholder="https://maps.google.com/?q=..."/></div>
      </div>
      <div style="height:12px"></div>
      <label>📍 Pin the exact spot — click the map (the pin you place is what's saved) <span id="pinHint" class="meta"></span></label>
      <div id="pickMap" style="height:260px;border-radius:10px;overflow:hidden;border:1px solid var(--line)"></div>
      <input type="hidden" id="f_lat"/><input type="hidden" id="f_lng"/>
      <div style="height:10px"></div>
      <label>Notes</label><textarea id="f_notes" placeholder="Anything the driver should know"></textarea>
      <div style="height:14px"></div>
      <button id="btnCreate" class="btn">Create reservation</button>
      <span id="createMsg" class="meta" style="margin-left:12px"></span>
    </div>

    <div class="card">
      <h2>My reservations</h2>
      <div id="salesList" class="table-wrap">Loading…</div>
    </div>`;

  await fillDriverSelect($('f_driver'));
  $('btnCreate').onclick = createReservation;

  // Location pin picker
  setTimeout(() => {
    if (_leafletMaps['pickMap']) { _leafletMaps['pickMap'].remove(); delete _leafletMaps['pickMap']; }
    const pm = L.map('pickMap').setView(ABU_DHABI, 10);
    _leafletMaps['pickMap'] = pm;
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:19, attribution:'© OpenStreetMap' }).addTo(pm);
    let marker = null;
    const setPin = (lat, lng, zoom) => {
      $('f_lat').value = lat; $('f_lng').value = lng;
      if (marker) marker.setLatLng([lat, lng]); else marker = L.marker([lat, lng]).addTo(pm);
      if (zoom) pm.setView([lat, lng], zoom);
    };
    const hintOk = (t) => { $('pinHint').textContent = t; $('pinHint').style.color = 'var(--ok)'; };
    const hintWarn = (t) => { $('pinHint').textContent = t; $('pinHint').style.color = 'var(--warn)'; };
    pm.on('click', e => { setPin(+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)); hintOk('✓ pinned'); });
    $('f_locurl').addEventListener('change', async () => {
      const v = $('f_locurl').value.trim();
      if (!v) return;
      let c = parseLatLng(v);
      if (!c && /^https?:\/\//.test(v)) {                 // shortened link → resolve on the server
        hintWarn('… resolving link');
        try {
          const { data } = await SB.functions.invoke('resolve-geo', { body: { url: v } });
          if (data && typeof data.lat === 'number') c = { lat: data.lat, lng: data.lng };
        } catch (_) { /* fall through */ }
      }
      if (c) { setPin(c.lat, c.lng, 15); hintOk('✓ pinned from link'); }
      else hintWarn('⚠ couldn’t read this link — click the exact spot on the map');
    });
    pm.invalidateSize();
  }, 60);

  window.__refresh = loadSalesList;
  loadSalesList();
}

async function fillDriverSelect(sel) {
  const { data, error } = await SB.from('drivers')
    .select('id, is_available, full_name, profile:profiles(full_name)').order('full_name');
  if (error) { sel.innerHTML = `<option>Error: ${esc(error.message)}</option>`; return; }
  sel.innerHTML = '<option value="">Select a driver…</option>' +
    (data || []).map(d => { const nm = d.full_name || d.profile?.full_name || 'Driver';
      return `<option value="${d.id}">${esc(nm)}${d.is_available ? '' : ' (off shift)'}</option>`; }).join('');
}

async function createReservation() {
  const msg = $('createMsg');
  const payload = {
    created_by: me.id,
    driver_id: $('f_driver').value || null,
    client_name: $('f_client').value.trim(),
    client_phone: $('f_clientphone').value.trim() || null,
    purpose: $('f_purpose').value,
    location_text: $('f_loc').value.trim() || null,
    location_url: $('f_locurl').value.trim() || null,
    pickup_at: toISO($('f_pickup').value),
    return_at: toISO($('f_return').value),
    notes: $('f_notes').value.trim() || null,
    lat: $('f_lat').value ? Number($('f_lat').value) : null,
    lng: $('f_lng').value ? Number($('f_lng').value) : null,
  };
  if (!payload.client_name || !payload.driver_id || !payload.pickup_at) {
    msg.textContent = 'Client, driver and pickup time are required.'; msg.style.color = 'var(--danger)'; return;
  }
  $('btnCreate').disabled = true; msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…';
  const { error } = await SB.from('reservations').insert(payload);
  $('btnCreate').disabled = false;
  if (error) { msg.style.color = 'var(--danger)'; msg.textContent = error.message; return; }
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Reservation created (driver notified once SMS is live).';
  ['f_client','f_clientphone','f_loc','f_locurl','f_notes','f_pickup','f_return'].forEach(id => $(id).value = '');
  loadSalesList();
}

async function loadSalesList() {
  const box = $('salesList'); if (!box) return;
  const { data, error } = await SB.from('reservations')
    .select('*, driver:drivers(full_name, profile:profiles(full_name))')
    .order('pickup_at', { ascending: true });
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  box.innerHTML = reservationTable(data, { showDriver: true });
}

// =============================================================================
// DRIVER VIEW
// =============================================================================
async function renderDriver() {
  const main = $('appMain');
  main.innerHTML = `
    ${deeplinkBanner()}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">My trips</h2>
        <div class="row-actions">
          <button id="btnDrvMap" class="btn secondary sm">🗺️ Map</button>
          <button id="btnMyQr" class="btn secondary sm">Schedule QR</button>
        </div>
      </div>
      <div class="tabs" id="driverTabs">
        <div class="tab ${drvFilter==='pending'?'active':''}" data-f="pending">Pending</div>
        <div class="tab ${drvFilter==='upcoming'?'active':''}" data-f="upcoming">Accepted</div>
        <div class="tab ${drvFilter==='all'?'active':''}" data-f="all">All</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:4px 0 12px">
        <label style="margin:0">Jump to day:</label>
        <input type="date" id="dDate" value="${drvDate}" style="max-width:190px"/>
        <button id="dDateClear" class="btn ghost sm">All days</button>
      </div>
      <div id="drvMap" class="hidden" style="height:360px;border-radius:10px;overflow:hidden;border:1px solid var(--line);margin-bottom:12px"></div>
      <div id="driverList">Loading…</div>
    </div>`;
  $('btnMyQr').onclick = () => showQr(`${location.origin}${location.pathname}?driver=${myDriverId}`, 'My schedule');
  $('btnDrvMap').onclick = async () => {
    const el = $('drvMap');
    if (el.classList.contains('hidden')) {
      el.classList.remove('hidden');
      let q = SB.from('reservations').select('*, driver:drivers(full_name)').eq('driver_id', myDriverId).not('lat', 'is', null);
      const { data } = await q;
      let rows = data || [];
      if (drvDate) rows = rows.filter(r => dayKey(r.pickup_at) === drvDate);
      buildVisitMap('drvMap', rows);
    } else {
      el.classList.add('hidden');
    }
  };
  main.querySelectorAll('#driverTabs .tab').forEach(t => t.onclick = () => {
    main.querySelectorAll('#driverTabs .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); drvFilter = t.dataset.f; loadDriverList();
  });
  $('dDate').onchange = (e) => { drvDate = e.target.value; loadDriverList(); };
  $('dDateClear').onclick = () => { drvDate = ''; $('dDate').value = ''; loadDriverList(); };
  window.__refresh = () => loadDriverList();
  loadDriverList();
}

function driverCard(r) {
  return `<div class="card" style="margin:0 0 12px;background:var(--surface-2)">
    <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-weight:700">${esc(r.client_name)} · ${statusBadge(r.status)}</div>
        <div class="meta">${esc(r.purpose.replace('_',' '))} · ${esc(r.reference_code)}</div>
        <div class="res-loc">📍 ${esc(r.location_text || '—')} ${r.location_url ? `· <a href="${esc(r.location_url)}" target="_blank">map</a>` : ''}</div>
        <div class="meta">🕑 ${fmtDateTime(r.pickup_at)} → ${fmtDateTime(r.return_at)}</div>
        ${r.client_phone ? `<div class="meta">📞 <a href="tel:${esc(r.client_phone)}">${esc(r.client_phone)}</a></div>` : ''}
        ${r.notes ? `<div class="meta">📝 From sales: ${esc(r.notes)}</div>` : ''}
        ${r.reject_reason ? `<div class="meta">Reason: ${esc(r.reject_reason)}</div>` : ''}
      </div>
      <div class="row-actions" style="align-items:flex-start">
        ${r.status === 'pending' ? `<button class="btn ok sm" data-accept="${r.id}">Accept</button><button class="btn danger sm" data-reject="${r.id}">Reject</button>` : ''}
        ${r.status === 'accepted' ? `<button class="btn secondary sm" data-complete="${r.id}">Mark done</button>` : ''}
      </div>
    </div>
    <div style="margin-top:10px">
      <label>My note for this trip</label>
      <textarea id="dn_${r.id}" placeholder="e.g. client running late, gate code 1234, met at lobby…">${esc(r.driver_note || '')}</textarea>
      <div style="height:6px"></div>
      <button class="btn secondary sm" data-savenote="${r.id}">Save note</button>
      <span id="dnmsg_${r.id}" class="meta" style="margin-left:8px"></span>
    </div>
  </div>`;
}

async function saveDriverNote(id) {
  const val = $(`dn_${id}`).value.trim();
  const msg = $(`dnmsg_${id}`);
  msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…';
  const { error } = await SB.from('reservations').update({ driver_note: val || null }).eq('id', id);
  if (error) { msg.style.color = 'var(--danger)'; msg.textContent = error.message; return; }
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Saved';
}

async function loadDriverList() {
  const box = $('driverList'); if (!box) return;
  if (!myDriverId) { box.innerHTML = `<p class="err">Your account isn't linked to a driver record yet. Ask a manager.</p>`; return; }
  let q = SB.from('reservations').select('*').eq('driver_id', myDriverId).order('pickup_at', { ascending: true });
  if (drvFilter === 'pending') q = q.eq('status', 'pending');
  if (drvFilter === 'upcoming') q = q.eq('status', 'accepted');
  const { data, error } = await q;
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  let rows = data || [];
  if (drvDate) rows = rows.filter(r => dayKey(r.pickup_at) === drvDate);
  if (!rows.length) { box.innerHTML = `<p class="muted">Nothing here.</p>`; return; }

  box.innerHTML = groupByDay(rows).map(g =>
    `<h3>${g.label} <span class="muted" style="font-weight:400">· ${g.items.length}</span></h3>
     ${g.items.map(driverCard).join('')}`
  ).join('');

  box.querySelectorAll('[data-accept]').forEach(b => b.onclick = () => driverAct(b.dataset.accept, 'accept'));
  box.querySelectorAll('[data-reject]').forEach(b => b.onclick = () => driverAct(b.dataset.reject, 'reject'));
  box.querySelectorAll('[data-complete]').forEach(b => b.onclick = () => driverAct(b.dataset.complete, 'complete'));
  box.querySelectorAll('[data-savenote]').forEach(b => b.onclick = () => saveDriverNote(b.dataset.savenote));
}

async function driverAct(id, action) {
  let patch;
  if (action === 'accept') patch = { status: 'accepted', accepted_at: new Date().toISOString() };
  if (action === 'complete') patch = { status: 'completed', completed_at: new Date().toISOString() };
  if (action === 'reject') {
    const reason = prompt('Reason for rejecting (optional):') ?? '';
    patch = { status: 'rejected', rejected_at: new Date().toISOString(), reject_reason: reason || null };
  }
  const { error } = await SB.from('reservations').update(patch).eq('id', id);
  if (error) {
    if (error.message.includes('no_driver_double_booking'))
      alert('⛔ You already have an accepted trip overlapping this time slot.');
    else alert(error.message);
  }
  routeHome();
}

// =============================================================================
// MANAGER NAV
// =============================================================================
function managerNav(active) {
  return `<div class="tabs" style="margin-bottom:16px">
    <div class="tab ${active==='dashboard'?'active':''}" data-nav="dashboard">📊 Dashboard</div>
    <div class="tab ${active==='map'?'active':''}" data-nav="map">🗺️ Map</div>
    <div class="tab ${active==='manage'?'active':''}" data-nav="manage">👥 Drivers &amp; Team</div>
  </div>`;
}
function wireNav() {
  document.querySelectorAll('[data-nav]').forEach(t => t.onclick = () => {
    if (t.dataset.nav === 'dashboard') renderManager();
    else if (t.dataset.nav === 'map') renderMap();
    else renderManagement();
  });
}

async function renderMap() {
  const main = $('appMain');
  main.innerHTML = `
    ${managerNav('map')}
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">🗺️ Visit map</h2>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="margin:0">Day:</label>
          <input type="date" id="mapDate" value="${mgrDate}" style="max-width:180px"/>
          <button id="mapClear" class="btn ghost sm">All days</button>
        </div>
      </div>
      <div id="visitMap" style="height:520px;border-radius:10px;overflow:hidden;border:1px solid var(--line);margin-top:12px"></div>
      <p class="muted" id="mapMsg" style="margin-top:8px">Loading…</p>
      <div class="meta" style="margin-top:4px">
        🟡 pending · 🟢 accepted · 🔴 rejected · 🔵 completed
      </div>
    </div>`;
  wireNav();
  $('mapDate').onchange = (e) => { mgrDate = e.target.value; loadMap(); };
  $('mapClear').onclick = () => { mgrDate = ''; $('mapDate').value = ''; loadMap(); };
  loadMap();
}

async function loadMap() {
  const { data, error } = await SB.from('reservations')
    .select('*, driver:drivers(full_name)')
    .not('lat', 'is', null);
  if (error) { $('mapMsg').textContent = error.message; return; }
  let rows = data || [];
  if (mgrDate) rows = rows.filter(r => dayKey(r.pickup_at) === mgrDate);
  const n = buildVisitMap('visitMap', rows);
  $('mapMsg').textContent = n
    ? `${n} pinned visit(s) shown.`
    : 'No visits have a pinned location for this view. Sales can drop a pin when creating a reservation.';
}

// =============================================================================
// MANAGER VIEW
// =============================================================================
async function renderManager() {
  const main = $('appMain');
  main.innerHTML = `
    ${managerNav('dashboard')}
    ${deeplinkBanner()}
    <div class="card">
      <h2>Overview</h2>
      <div id="tiles" class="tiles">Loading…</div>
    </div>
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">Reservations</h2>
        <div class="tabs" id="mFilter" style="margin:0">
          <div class="tab ${mgrFilter==='all'?'active':''}" data-f="all">All</div>
          <div class="tab ${mgrFilter==='pending'?'active':''}" data-f="pending">Pending</div>
          <div class="tab ${mgrFilter==='accepted'?'active':''}" data-f="accepted">Accepted</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0">
        <label style="margin:0">Jump to day:</label>
        <input type="date" id="mDate" value="${mgrDate}" style="max-width:190px"/>
        <button id="mDateClear" class="btn ghost sm">All days</button>
      </div>
      <div id="mgrList">Loading…</div>
    </div>
    <div class="card">
      <h2>Driver performance</h2>
      <div id="mgrStats" class="table-wrap">Loading…</div>
    </div>`;

  main.querySelectorAll('#mFilter .tab').forEach(t => t.onclick = () => {
    main.querySelectorAll('#mFilter .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); mgrFilter = t.dataset.f; loadMgrList();
  });
  $('mDate').onchange = (e) => { mgrDate = e.target.value; loadMgrList(); };
  $('mDateClear').onclick = () => { mgrDate = ''; $('mDate').value = ''; loadMgrList(); };
  window.__refresh = () => { loadTiles(); loadMgrList(); loadStats(); };
  loadTiles(); loadMgrList(); loadStats();
  wireNav();
}

// =============================================================================
// MANAGEMENT VIEW (managers/admin) — create drivers, team, manage users
// =============================================================================
async function renderManagement() {
  const main = $('appMain');
  main.innerHTML = `
    ${managerNav('manage')}

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <h2 style="margin:0">📱 Sales reservation QR</h2>
        <button id="btnSalesQr" class="btn secondary sm">Show QR poster link</button>
      </div>
      <p class="muted">Print this QR. Any Amlak One agent scans it, signs up with their
      <b>@amlakone.ae</b> email + phone OTP, and can immediately reserve a driver — no approval needed.</p>
    </div>

    <div class="card">
      <h2>👨‍✈️ Drivers</h2>
      <p class="muted">Add a driver by name + phone. They sign in with that phone (OTP) and land on the driver app.</p>
      <div class="grid cols-3">
        <div><label>Full name *</label><input id="d_name" placeholder="Driver Rahman"/></div>
        <div><label>Phone (OTP) *</label><input id="d_phone" placeholder="0501234567 or 971501234567"/></div>
        <div><label>License no.</label><input id="d_lic" placeholder="DL-123456"/></div>
      </div>
      <div style="height:12px"></div>
      <button id="btnAddDriver" class="btn">Add driver</button>
      <span id="driverMsg" class="meta" style="margin-left:12px"></span>
      <div id="driversList" class="table-wrap" style="margin-top:16px">Loading…</div>
    </div>

    <div class="card">
      <h2>👔 Team (managers &amp; staff)</h2>
      <p class="muted">Pre-assign a role to someone by phone. When they sign in (OTP), they get this role.
      Sales agents don't need to be added here — they self-register via the QR.</p>
      <div class="grid cols-3">
        <div><label>Full name *</label><input id="t_name" placeholder="Omar"/></div>
        <div><label>Phone (OTP) *</label><input id="t_phone" placeholder="0501234567 or 971501234567"/></div>
        <div><label>Role *</label><select id="t_role">
          <option value="operation_manager">Operation Manager</option>
          <option value="sales_manager">Sales Manager</option>
          <option value="sales">Sales</option>
          <option value="admin">Admin</option>
        </select></div>
      </div>
      <div style="height:12px"></div>
      <button id="btnAddTeam" class="btn">Add team member</button>
      <span id="teamMsg" class="meta" style="margin-left:12px"></span>
      <div id="teamList" class="table-wrap" style="margin-top:16px">Loading…</div>
    </div>

    <div class="card">
      <h2>✅ Active users</h2>
      <p class="muted">Everyone who has signed in. Change a role or deactivate access here.</p>
      <div id="usersList" class="table-wrap">Loading…</div>
    </div>`;

  wireNav();
  $('btnSalesQr').onclick = () => showQr(`${location.origin}${location.pathname}?signup=sales`, 'Sales reservation QR');
  $('btnAddDriver').onclick = addDriver;
  $('btnAddTeam').onclick = addTeam;
  loadDrivers(); loadTeam(); loadUsers();
}

async function addDriver() {
  const msg = $('driverMsg');
  const full_name = $('d_name').value.trim();
  const rawPhone = $('d_phone').value.trim();
  if (!full_name || !validUaePhone(rawPhone)) { msg.style.color = 'var(--danger)'; msg.textContent = 'Name + UAE mobile required (e.g. 0501234567).'; return; }
  const phone = toE164(rawPhone);
  msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…';
  const digits = normPhoneDigits(rawPhone);
  const { data: ins, error } = await SB.from('drivers')
    .insert({ full_name, phone, license_no: $('d_lic').value.trim() || null, is_available: true })
    .select('id').single();
  if (error) { msg.style.color = 'var(--danger)'; msg.textContent = error.message; return; }
  // If this phone already signed in (e.g. as sales), convert them to a driver now.
  const { data: prof } = await SB.from('profiles').select('id').in('phone', [phone, digits]).maybeSingle();
  if (prof) {
    await SB.from('drivers').update({ profile_id: prof.id }).eq('id', ins.id);
    await SB.from('profiles').update({ role: 'driver', is_active: true }).eq('id', prof.id);
  }
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Driver added.';
  ['d_name','d_phone','d_lic'].forEach(id => $(id).value = '');
  loadDrivers();
}

async function loadDrivers() {
  const box = $('driversList'); if (!box) return;
  const { data, error } = await SB.from('drivers').select('id, full_name, phone, license_no, is_available, profile_id').order('full_name');
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  if (!data.length) { box.innerHTML = `<p class="muted">No drivers yet.</p>`; return; }
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Phone</th><th>License</th><th>Status</th><th></th></tr></thead><tbody>${
    data.map(d => `<tr>
      <td>${esc(d.full_name || '—')}</td><td>${esc(d.phone || '—')}</td><td>${esc(d.license_no || '—')}</td>
      <td>${d.profile_id ? '<span class="badge s-accepted">signed in</span>' : '<span class="badge s-pending">not yet</span>'} ${d.is_available ? '' : '· off'}</td>
      <td><button class="btn ghost sm" data-deldriver="${d.id}">Remove</button></td></tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-deldriver]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove this driver?')) return;
    await SB.from('drivers').delete().eq('id', b.dataset.deldriver); loadDrivers();
  });
}

async function addTeam() {
  const msg = $('teamMsg');
  const full_name = $('t_name').value.trim();
  const rawPhone = $('t_phone').value.trim();
  const role = $('t_role').value;
  if (!full_name || !validUaePhone(rawPhone)) { msg.style.color = 'var(--danger)'; msg.textContent = 'Name + UAE mobile required (e.g. 0501234567).'; return; }
  const phone = toE164(rawPhone);
  msg.style.color = 'var(--muted)'; msg.textContent = 'Saving…';
  // upsert into registry
  const { error } = await SB.from('staff_registry').upsert({ phone, full_name, role, is_active: true }, { onConflict: 'phone' });
  if (error) { msg.style.color = 'var(--danger)'; msg.textContent = error.message; return; }
  // if they already signed in, apply the role to their profile now.
  // profiles.phone is stored by Supabase as digits only (no '+'), so match both forms.
  const digits = normPhoneDigits(rawPhone);
  await SB.from('profiles').update({ role, full_name, is_active: true }).in('phone', [phone, digits]);
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Team member saved.';
  ['t_name','t_phone'].forEach(id => $(id).value = '');
  loadTeam(); loadUsers();
}

async function loadTeam() {
  const box = $('teamList'); if (!box) return;
  const { data, error } = await SB.from('staff_registry').select('*').order('full_name');
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  if (!data.length) { box.innerHTML = `<p class="muted">No team members added.</p>`; return; }
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Phone</th><th>Role</th><th></th></tr></thead><tbody>${
    data.map(t => `<tr><td>${esc(t.full_name)}</td><td>${esc(t.phone)}</td>
      <td>${esc(t.role.replace('_',' '))}</td>
      <td><button class="btn ghost sm" data-delteam="${t.id}">Remove</button></td></tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-delteam]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove from team list? (Does not delete an already-active login.)')) return;
    await SB.from('staff_registry').delete().eq('id', b.dataset.delteam); loadTeam();
  });
}

async function loadUsers() {
  const box = $('usersList'); if (!box) return;
  const { data, error } = await SB.from('profiles').select('id, full_name, phone, email, role, is_active').order('full_name');
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  const roles = ['sales','driver','sales_manager','operation_manager','admin'];
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Contact</th><th>Role</th><th>Active</th></tr></thead><tbody>${
    data.map(u => `<tr>
      <td>${esc(u.full_name || '—')}</td>
      <td class="meta">${esc(u.phone || u.email || '—')}</td>
      <td><select data-role="${u.id}">${roles.map(r => `<option value="${r}" ${r===u.role?'selected':''}>${r.replace('_',' ')}</option>`).join('')}</select></td>
      <td><button class="btn ${u.is_active?'ok':'ghost'} sm" data-active="${u.id}" data-val="${u.is_active}">${u.is_active?'Active':'Inactive'}</button></td>
    </tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-role]').forEach(s => s.onchange = async () => {
    await SB.from('profiles').update({ role: s.value }).eq('id', s.dataset.role); loadUsers();
  });
  box.querySelectorAll('[data-active]').forEach(b => b.onclick = async () => {
    await SB.from('profiles').update({ is_active: b.dataset.val !== 'true' }).eq('id', b.dataset.active); loadUsers();
  });
}

async function loadTiles() {
  const { data } = await SB.from('reservations').select('status, pickup_at');
  const c = { pending:0, accepted:0, rejected:0, today:0 };
  const today = todayKey();
  (data || []).forEach(r => {
    if (c[r.status] != null) c[r.status]++;
    if (dayKey(r.pickup_at) === today) c.today++;
  });
  $('tiles').innerHTML = `
    <div class="tile"><div class="n">${c.today}</div><div class="l">Today</div></div>
    <div class="tile"><div class="n" style="color:var(--warn)">${c.pending}</div><div class="l">Pending</div></div>
    <div class="tile"><div class="n" style="color:var(--ok)">${c.accepted}</div><div class="l">Accepted</div></div>
    <div class="tile"><div class="n" style="color:var(--danger)">${c.rejected}</div><div class="l">Rejected</div></div>`;
}

async function loadMgrList() {
  const box = $('mgrList'); if (!box) return;
  let q = SB.from('reservations')
    .select('*, driver:drivers(full_name, profile:profiles(full_name)), creator:profiles!reservations_created_by_fkey(full_name)')
    .order('pickup_at', { ascending: true });
  if (mgrFilter === 'pending') q = q.eq('status', 'pending');
  if (mgrFilter === 'accepted') q = q.eq('status', 'accepted');
  const { data, error } = await q;
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  let rows = data || [];
  if (mgrDate) rows = rows.filter(r => dayKey(r.pickup_at) === mgrDate);
  if (!rows.length) { box.innerHTML = '<p class="muted">No reservations for this view.</p>'; return; }
  box.innerHTML = groupByDay(rows).map(g =>
    `<h3>${g.label} <span class="muted" style="font-weight:400">· ${g.items.length}</span></h3>
     <div class="table-wrap">${reservationTable(g.items, { showDriver:true, showCreator:true, manager:true })}</div>`
  ).join('');
  box.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this reservation?')) return;
    await SB.from('reservations').update({ status: 'cancelled' }).eq('id', b.dataset.cancel);
    routeHome();
  });
  box.querySelectorAll('[data-maccept]').forEach(b => b.onclick = () => driverAct(b.dataset.maccept, 'accept'));
  box.querySelectorAll('[data-mreject]').forEach(b => b.onclick = () => driverAct(b.dataset.mreject, 'reject'));
  box.querySelectorAll('[data-mcomplete]').forEach(b => b.onclick = () => driverAct(b.dataset.mcomplete, 'complete'));
  box.querySelectorAll('[data-qr]').forEach(b => b.onclick = () => showQr(`${location.origin}${location.pathname}?ref=${b.dataset.qr}`, b.dataset.qr));
}

async function loadStats() {
  const box = $('mgrStats'); if (!box) return;
  const { data, error } = await SB.from('v_driver_stats').select('*').order('total_reservations', { ascending: false });
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  box.innerHTML = `<table><thead><tr>
      <th>Driver</th><th>Total</th><th>Accepted</th><th>Rejected</th><th>Completed</th><th>No-show</th><th>Accept %</th>
    </tr></thead><tbody>${
      (data || []).map(d => `<tr>
        <td>${esc(d.full_name)}</td><td>${d.total_reservations}</td><td>${d.accepted}</td>
        <td>${d.rejected}</td><td>${d.completed}</td><td>${d.no_show}</td>
        <td>${d.acceptance_rate_pct ?? '—'}%</td></tr>`).join('')
    }</tbody></table>`;
}

// =============================================================================
// SHARED: reservation table
// =============================================================================
function reservationTable(rows, opts = {}) {
  if (!rows || !rows.length) return `<p class="muted">No reservations.</p>`;
  return `<table><thead><tr>
      <th>Ref</th><th>Client</th><th>Purpose</th>
      ${opts.showDriver ? '<th>Driver</th>' : ''}
      ${opts.showCreator ? '<th>By</th>' : ''}
      <th>Pickup</th><th>Status</th>${opts.manager ? '<th></th>' : ''}
    </tr></thead><tbody>${
    rows.map(r => `<tr>
      <td>${esc(r.reference_code)}</td>
      <td>${esc(r.client_name)}<div class="res-loc">${esc(r.location_text || '')}</div>${r.driver_note ? `<div class="meta">🚖 ${esc(r.driver_note)}</div>` : ''}</td>
      <td>${esc(r.purpose.replace('_',' '))}</td>
      ${opts.showDriver ? `<td>${esc(r.driver?.full_name || r.driver?.profile?.full_name || '—')}</td>` : ''}
      ${opts.showCreator ? `<td>${esc(r.creator?.full_name || '—')}</td>` : ''}
      <td>${fmtDateTime(r.pickup_at)}</td>
      <td>${statusBadge(r.status)}</td>
      ${opts.manager ? `<td class="row-actions">
        ${r.status === 'pending' ? `<button class="btn ok sm" data-maccept="${r.id}">Accept</button><button class="btn danger sm" data-mreject="${r.id}">Reject</button>` : ''}
        ${r.status === 'accepted' ? `<button class="btn secondary sm" data-mcomplete="${r.id}">Done</button>` : ''}
        <button class="btn ghost sm" data-qr="${esc(r.reference_code)}">QR</button>
        ${['pending','accepted'].includes(r.status) ? `<button class="btn ghost sm" data-cancel="${r.id}">Cancel</button>` : ''}
      </td>` : ''}
    </tr>`).join('')
  }</tbody></table>`;
}

// =============================================================================
// QR + deep link
// =============================================================================
function showQr(url, label) {
  const bg = el(`<div class="modal-bg"><div class="modal">
    <h2 style="margin-top:0">${esc(label || 'QR code')}</h2>
    <div id="qrcode"></div>
    <p class="meta" style="word-break:break-all">${esc(url)}</p>
    <button class="btn secondary" id="qrClose" style="width:100%">Close</button>
  </div></div>`);
  $('modalMount').innerHTML = ''; $('modalMount').appendChild(bg);
  new QRCode($('qrcode'), { text: url, width: 200, height: 200 });
  bg.querySelector('#qrClose').onclick = () => $('modalMount').innerHTML = '';
  bg.onclick = (e) => { if (e.target === bg) $('modalMount').innerHTML = ''; };
}

function deeplinkBanner() {
  const p = new URLSearchParams(location.search);
  const ref = p.get('ref');
  if (ref) return `<div class="deeplink-banner">🔗 Opened from QR — reservation <b>${esc(ref)}</b>. It's highlighted in your list below.</div>`;
  return '';
}
