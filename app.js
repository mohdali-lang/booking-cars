// =============================================================================
// Amlak One — Driver Reservation System :: APP LOGIC (vanilla JS)
// =============================================================================
const SB = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

let me = null;          // auth user
let profile = null;     // public.profiles row
let myDriverId = null;  // drivers.id if I am a driver
let realtimeChan = null;
let mgrFilter = 'all';  // manager status filter
let mgrDate = '';       // manager day filter (YYYY-MM-DD or '')
let drvFilter = 'pending';
let drvDate = '';       // driver day filter
let isApprover = false; // can approve/reject meeting room requests (George / admin)
let roomsCache = [];    // meeting_rooms rows
let rbFilter = 'pending', rbRoom = '', rbDate = '', rbTab = 'requests', calDate = '';

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

// "10 Jul, 17:20 → 19:20". No return time entered -> estimated end (default trip length) shown with "~".
function tripWindow(r) {
  if (!r.pickup_at) return '—';
  const est = !r.return_at;
  const end = new Date(est ? new Date(r.pickup_at).getTime() + (CONFIG.DEFAULT_TRIP_HOURS || 2) * 3600000 : r.return_at);
  const endTxt = dayKey(end) === dayKey(r.pickup_at) ? fmtTime(end) : fmtDateTime(end);
  return `${fmtDateTime(r.pickup_at)} → ${est ? '~' : ''}${endTxt}`;
}

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
      + `🕑 ${tripWindow(r)}<br>`
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
  let registering = false;

  const showStaff = () => {
    $('segStaff').classList.add('active'); $('segDriver').classList.remove('active');
    $('staffBox').classList.remove('hidden'); $('driverBox').classList.add('hidden'); setMsg('');
  };
  const showDriver = () => {
    $('segDriver').classList.add('active'); $('segStaff').classList.remove('active');
    $('driverBox').classList.remove('hidden'); $('staffBox').classList.add('hidden'); setMsg('');
  };
  const setRegisterMode = (on) => {
    registering = on;
    $('regNameWrap').classList.toggle('hidden', !on);
    $('pwHint').classList.toggle('hidden', !on);
    $('loginPassword').autocomplete = on ? 'new-password' : 'current-password';
    $('btnEmailLogin').textContent = on ? 'Create account' : 'Sign in';
    $('btnToggleReg').textContent = on ? 'Already registered? Sign in' : 'First time? Create your account';
    $('loginTitle').textContent = on ? 'Create your account' : 'Reservations';
    setMsg('');
  };

  $('segStaff').onclick = showStaff;
  $('segDriver').onclick = showDriver;
  $('btnToggleReg').onclick = () => setRegisterMode(!registering);

  // Opened from the Sales QR (?signup=sales): go straight to "create account"
  if (new URLSearchParams(location.search).get('signup') === 'sales') {
    $('salesBanner').classList.remove('hidden');
    setRegisterMode(true);
  }

  // ---- Staff: email + password ----
  const submitStaff = async () => {
    setMsg('');
    const email = $('loginEmail').value.trim().toLowerCase();
    const password = $('loginPassword').value;
    if (!email || !password) return setMsg('Enter your email and password.', true);
    if (!email.endsWith(ALLOWED_EMAIL_DOMAIN)) return setMsg(`Use your company email (ending ${ALLOWED_EMAIL_DOMAIN}).`, true);
    $('btnEmailLogin').disabled = true;
    try {
      if (registering) {
        const full_name = $('regName').value.trim();
        if (!full_name) return setMsg('Enter your full name.', true);
        if (password.length < 8) return setMsg('Password must be at least 8 characters.', true);
        const { data, error } = await SB.auth.signUp({ email, password, options: { data: { full_name } } });
        if (error) { console.error('signUp error:', error); return setMsg(fmtAuthError(error), true); }
        if (!data.session) {
          // Supabase is still asking for e-mail confirmation (setting not switched off yet)
          return setMsg('Account created, but email confirmation is still turned on. Ask the admin to turn it off, then sign in.', true);
        }
        // session present -> onAuthStateChange signs the user in
      } else {
        const { error } = await SB.auth.signInWithPassword({ email, password });
        if (error) { console.error('signInWithPassword error:', error); setMsg(fmtAuthError(error), true); }
      }
    } finally { $('btnEmailLogin').disabled = false; }
  };
  $('btnEmailLogin').onclick = submitStaff;
  ['loginEmail', 'loginPassword', 'regName'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') submitStaff(); }));

  // ---- Driver: phone + password ----
  const submitDriver = async () => {
    setMsg('');
    const raw = $('drvPhone').value.trim();
    const password = $('drvPassword').value;
    if (!validUaePhone(raw)) return setMsg('Enter your UAE mobile, e.g. 0501234567.', true);
    if (!password) return setMsg('Enter your password.', true);
    $('btnDriverLogin').disabled = true;
    const { error } = await SB.auth.signInWithPassword({ phone: toE164(raw), password });
    $('btnDriverLogin').disabled = false;
    if (error) { console.error('driver signIn error:', error); setMsg(fmtAuthError(error), true); }
  };
  $('btnDriverLogin').onclick = submitDriver;
  ['drvPhone', 'drvPassword'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') submitDriver(); }));
}

function setMsg(text, isErr) {
  const box = $('loginMsg');
  box.innerHTML = text ? `<div class="${isErr ? 'err' : 'ok-msg'}">${esc(text)}</div>` : '';
}

// Turn a Supabase/JS error into readable text (avoids showing "{}")
function fmtAuthError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  const t = error.message || error.error_description || error.msg || error.error || error.hint || '';
  if (t) return error.status ? `${t} (${error.status})` : t;
  try { const s = JSON.stringify(error); if (s && s !== '{}') return s; } catch (_) {}
  return 'Could not send the code. Please check the number and try again.';
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

  await ensureNotifyPhone();

  try { const { data: ap } = await SB.rpc('is_room_approver'); isApprover = !!ap; } catch (e) { isApprover = false; }

  // Home button (everyone except drivers) returns to the "Car / Meeting room" choice
  if (profile.role !== 'driver') {
    $('btnHome').classList.remove('hidden');
    $('btnHome').onclick = () => landing();
  }

  subscribeRealtime();
  landing();
}

// Staff who sign in with email have no phone on file -> ask once for the mobile that receives SMS alerts.
async function ensureNotifyPhone() {
  if (profile.role === 'driver') return;
  if (!('notify_phone' in profile)) return;        // database patch_15 not applied yet
  if (profile.notify_phone || profile.phone) return;
  await new Promise((resolve) => {
    const bg = el(`<div class="modal-bg"><div class="modal">
      <h2 style="margin-top:0">📱 Your mobile number</h2>
      <p class="meta" style="margin:0 0 10px">We send SMS alerts here (driver accepted / rejected, room approved, reminders).</p>
      <input id="npPhone" type="tel" placeholder="0501234567" autocomplete="tel"/>
      <div id="npMsg" class="meta" style="margin:8px 0;color:var(--danger)"></div>
      <button class="btn" id="npSave" style="width:100%">Save</button>
      <div style="height:8px"></div>
      <button class="btn ghost sm" id="npSkip" style="width:100%">Skip for now</button>
    </div></div>`);
    $('modalMount').innerHTML = ''; $('modalMount').appendChild(bg);
    const done = () => { $('modalMount').innerHTML = ''; resolve(); };
    bg.querySelector('#npSkip').onclick = done;
    bg.querySelector('#npSave').onclick = async () => {
      const raw = bg.querySelector('#npPhone').value.trim();
      if (!validUaePhone(raw)) { bg.querySelector('#npMsg').textContent = 'Enter a valid UAE mobile, e.g. 0501234567.'; return; }
      const phone = toE164(raw);
      const { error } = await SB.from('profiles').update({ notify_phone: phone }).eq('id', me.id);
      if (error) { bg.querySelector('#npMsg').textContent = error.message; return; }
      profile.notify_phone = phone; done();
    };
  });
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
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_bookings' }, () => {
      if (typeof window.__refresh === 'function') window.__refresh();
    }).subscribe();
}

// =============================================================================
// ROUTER (role-based home)
// =============================================================================
function routeHome() {            // the CAR booking home (unchanged behaviour)
  if (profile.role === 'driver') return renderDriver();
  if (isManager()) return renderManager();
  return renderSales();
}

// First screen after login: drivers go straight to their trips; everyone else
// chooses Book a Car or Book a Meeting Room.
async function landing() {
  window.__refresh = null;
  if (profile.role === 'driver') return renderDriver();
  const canManageRooms = isManager() || isApprover;
  $('appMain').innerHTML = `
    <div style="max-width:760px;margin:30px auto 0">
      <h2 style="text-align:center;margin:0 0 4px">What would you like to do?</h2>
      <p class="muted" style="text-align:center;margin:0 0 20px">Hi ${esc((profile.full_name || '').split(' ')[0] || 'there')} 👋</p>
      <div class="grid cols-2">
        <div class="card choice" id="chCar"><div class="big">🚗</div><h2>Book a Car</h2>
          <p class="muted">Reserve a driver for a client viewing or meeting.</p></div>
        <div class="card choice" id="chRoom"><div class="big">🏢</div><h2>Book a Meeting Room</h2>
          <p class="muted">9th floor (4 rooms) · 12th floor (1 room)</p></div>
      </div>
      ${canManageRooms ? `<div class="card choice" id="chRoomAdmin" style="margin-top:0">
          <h2 style="margin:0">📋 Meeting room ${isApprover ? 'requests &amp; approvals' : 'tracking'} <span id="chPending"></span></h2>
          <p class="muted" style="margin:6px 0 0">${isApprover ? 'Approve or reject requests, see the room calendar and usage.' : 'View all room bookings, the room calendar and usage.'}</p></div>` : ''}
    </div>`;
  $('chCar').onclick = () => routeHome();
  $('chRoom').onclick = () => renderRoomBooking();
  if (canManageRooms) {
    $('chRoomAdmin').onclick = () => renderRoomAdmin();
    try {
      const { count } = await SB.from('room_bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending');
      if (count && $('chPending')) $('chPending').innerHTML = `<span class="badge s-pending">${count} pending</span>`;
    } catch (e) { /* patch_12 not run yet */ }
  }
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
    agent_name: profile.full_name || null,
  };
  if (!payload.client_name || !payload.driver_id || !payload.pickup_at) {
    msg.textContent = 'Client, driver and pickup time are required.'; msg.style.color = 'var(--danger)'; return;
  }

  // Upfront conflict check (warn, but allow)
  msg.style.color = 'var(--muted)'; msg.textContent = 'Checking driver availability…';
  const endISO = payload.return_at
    || new Date(new Date(payload.pickup_at).getTime() + (CONFIG.DEFAULT_TRIP_HOURS || 2) * 3600000).toISOString();
  const { data: busy } = await SB.rpc('driver_busy', { p_driver: payload.driver_id, p_start: payload.pickup_at, p_end: endISO });
  if (busy && busy.length) {
    const b = busy[0];
    const ok = confirm(`⚠ This driver already has an ACCEPTED trip from ${fmtDateTime(b.pickup_at)} to ${fmtDateTime(b.return_at)} (Ref ${b.reference_code}).\n\nThey can only do one. Book anyway?`);
    if (!ok) { msg.style.color = 'var(--muted)'; msg.textContent = 'Cancelled — pick another driver or time.'; return; }
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
        <div class="meta">👤 Requested by ${esc(r.agent_name || 'Sales')}</div>
        <div class="res-loc">📍 ${esc(r.location_text || '—')} ${r.location_url ? `· <a href="${esc(r.location_url)}" target="_blank">map</a>` : ''}</div>
        <div class="meta">🕑 ${tripWindow(r)}</div>
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
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Driver added. Creating login…';
  ['d_name','d_phone','d_lic'].forEach(id => $(id).value = '');
  loadDrivers();
  await setDriverPassword(ins.id, full_name);
  msg.textContent = '✓ Driver added.';
}

// Create / reset a driver's phone + password login (server-side) and show the password ONCE.
async function setDriverPassword(driverId, name) {
  const { data, error } = await SB.functions.invoke('admin-driver-account', { body: { driver_id: driverId } });
  let problem = data?.error || '';
  if (error) {
    try { problem = (await error.context.json()).error || error.message; } catch (_) { problem = error.message; }
  }
  if (problem || !data?.password) { alert('Could not create the login: ' + (problem || 'unknown error')); return; }
  const bg = el(`<div class="modal-bg"><div class="modal">
    <h2 style="margin-top:0">🔑 Login for ${esc(name || 'driver')}</h2>
    <p class="meta" style="margin:0 0 8px">Give these to the driver. The password is shown <b>only now</b>.</p>
    <div class="tile" style="text-align:left;margin-bottom:12px">
      <div class="l">Phone</div><div style="font-weight:700">${esc(data.phone)}</div>
      <div class="l" style="margin-top:8px">Password</div>
      <div id="pwShown" style="font-weight:800;font-size:22px;letter-spacing:1px">${esc(data.password)}</div>
    </div>
    <div class="row-actions" style="justify-content:center">
      <button class="btn secondary" id="pwCopy">Copy</button>
      <button class="btn" id="pwClose">Done</button>
    </div></div></div>`);
  $('modalMount').innerHTML = ''; $('modalMount').appendChild(bg);
  bg.querySelector('#pwCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(`Phone: ${data.phone}\nPassword: ${data.password}`); bg.querySelector('#pwCopy').textContent = 'Copied ✓'; }
    catch (_) { bg.querySelector('#pwCopy').textContent = 'Select & copy manually'; }
  };
  bg.querySelector('#pwClose').onclick = () => { $('modalMount').innerHTML = ''; };
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
      <td class="row-actions"><button class="btn secondary sm" data-drvpw="${d.id}" data-name="${esc(d.full_name || '')}">Set password</button>
        <button class="btn ghost sm" data-deldriver="${d.id}">Remove</button></td></tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-drvpw]').forEach(b => b.onclick = () => {
    if (confirm('Create a NEW password for this driver? Their old password will stop working.')) setDriverPassword(b.dataset.drvpw, b.dataset.name);
  });
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
  const isAdmin = profile.role === 'admin';
  // who is currently a room approver (admins see this and can change it)
  let apprIds = new Set(), apprPhones = new Set();
  try {
    const { data: ap } = await SB.from('room_approvers').select('profile_id, phone');
    (ap || []).forEach(a => { if (a.profile_id) apprIds.add(a.profile_id); apprPhones.add((a.phone || '').replace(/\D/g, '')); });
  } catch (_) { /* patch_12/14 not run yet */ }
  const isAppr = (u) => apprIds.has(u.id) || (u.phone && apprPhones.has(u.phone.replace(/\D/g, '')));
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Contact</th><th>Role</th><th>Active</th>${isAdmin ? '<th>Room approver</th>' : ''}</tr></thead><tbody>${
    data.map(u => `<tr>
      <td>${esc(u.full_name || '—')}</td>
      <td class="meta">${esc(u.phone || u.email || '—')}</td>
      <td><select data-role="${u.id}">${roles.map(r => `<option value="${r}" ${r===u.role?'selected':''}>${r.replace('_',' ')}</option>`).join('')}</select></td>
      <td><button class="btn ${u.is_active?'ok':'ghost'} sm" data-active="${u.id}" data-val="${u.is_active}">${u.is_active?'Active':'Inactive'}</button></td>
      ${isAdmin ? `<td>${u.role === 'admin' ? '<span class="meta">always (admin)</span>'
        : `<button class="btn ${isAppr(u)?'ok':'ghost'} sm" data-appr="${u.id}" data-on="${isAppr(u)}" data-phone="${esc(u.phone || '')}">${isAppr(u)?'Approver ✓':'Make approver'}</button>`}</td>` : ''}
    </tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-appr]').forEach(b => b.onclick = async () => {
    const turnOn = b.dataset.on !== 'true';
    let phone = b.dataset.phone;
    if (turnOn && !phone) {
      phone = prompt('Mobile number for this approver (for SMS alerts), e.g. 0501234567:') || '';
      if (!validUaePhone(phone)) return alert('Enter a valid UAE mobile number.');
      phone = toE164(phone);
    }
    const { error } = await SB.rpc('set_room_approver', { p_profile: b.dataset.appr, p_phone: phone || null, p_on: turnOn });
    if (error) alert(error.message);
    loadUsers();
  });
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
      <th>Pickup → Return</th><th>Status</th>${opts.manager ? '<th></th>' : ''}
    </tr></thead><tbody>${
    rows.map(r => `<tr>
      <td>${esc(r.reference_code)}</td>
      <td>${esc(r.client_name)}<div class="res-loc">${esc(r.location_text || '')}</div>${r.driver_note ? `<div class="meta">🚖 ${esc(r.driver_note)}</div>` : ''}</td>
      <td>${esc(r.purpose.replace('_',' '))}</td>
      ${opts.showDriver ? `<td>${esc(r.driver?.full_name || r.driver?.profile?.full_name || '—')}</td>` : ''}
      ${opts.showCreator ? `<td>${esc(r.creator?.full_name || '—')}</td>` : ''}
      <td>${tripWindow(r)}</td>
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

// =============================================================================
// MEETING ROOMS
// =============================================================================
const ROOM_PURPOSES = ['Client meeting', 'Internal meeting', 'Interview', 'Training', 'Other'];
const fmtRange = (s, e) => `${fmtDate(s)} · ${fmtTime(s)}–${fmtTime(e)}`;
// Calendar popup under a text field (month arrows, past days greyed, Today / Tomorrow)
function initDatePicker(input, pop, onPick) {
  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  let view = new Date(); view.setDate(1);
  const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const keyOf = (d) => dayKey(d);
  const pick = (d) => { input.value = fmt(d); pop.classList.add('hidden'); onPick && onPick(); };
  function draw() {
    const y = view.getFullYear(), m = view.getMonth();
    const first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const sel = typedDate(input.value), today = todayKey();
    const cells = [];
    for (let i = first - 1; i >= 0; i--) cells.push(`<div class="dp-d dp-out">${prevDays - i}</div>`);
    for (let d = 1; d <= days; d++) {
      const k = keyOf(new Date(y, m, d)), past = k < today;
      cells.push(`<div class="dp-d ${past ? 'dp-past' : 'dp-ok'} ${k === today ? 'dp-today' : ''} ${k === sel ? 'dp-sel' : ''}" ${past ? '' : `data-d="${d}"`}>${d}</div>`);
    }
    for (let n = 1; cells.length % 7; n++) cells.push(`<div class="dp-d dp-out">${n}</div>`);
    pop.innerHTML = `
      <div class="dp-head"><b>${view.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</b>
        <span><button type="button" class="dp-nav" data-nav="-1">‹</button><button type="button" class="dp-nav" data-nav="1">›</button></span></div>
      <div class="dp-grid">${DOW.map(x => `<div class="dp-dow">${x}</div>`).join('')}${cells.join('')}</div>
      <div class="dp-foot"><button type="button" class="dp-btn" data-q="0">Today</button><button type="button" class="dp-btn" data-q="1">Tomorrow</button></div>`;
    pop.querySelectorAll('[data-nav]').forEach(b => b.onclick = (e) => { e.stopPropagation(); view = new Date(y, m + Number(b.dataset.nav), 1); draw(); });
    pop.querySelectorAll('[data-d]').forEach(c => c.onclick = () => pick(new Date(y, m, Number(c.dataset.d))));
    pop.querySelectorAll('[data-q]').forEach(b => b.onclick = () => pick(new Date(Date.now() + Number(b.dataset.q) * 86400000)));
  }
  input.onclick = (e) => {
    e.stopPropagation();
    const s = typedDate(input.value);
    view = s ? new Date(s + 'T12:00') : new Date(); view.setDate(1);
    draw(); pop.classList.toggle('hidden');
  };
  pop.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', () => pop.classList.add('hidden'));
}

// "15/10/2026" -> "2026-10-15"; returns '' if it is not a real date
function typedDate(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((v || '').trim());
  if (!m) return '';
  const [, d, mo, y] = m, dt = new Date(+y, +mo - 1, +d);
  if (dt.getFullYear() !== +y || dt.getMonth() !== +mo - 1 || dt.getDate() !== +d) return '';
  return `${y}-${mo}-${d}`;
}
const hh = (h) => String(h).padStart(2, '0');
const hourOptions = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) =>
  `<option value="${hh(from + i)}:00">${hh(from + i)}:00</option>`).join('');
const roomName = (id) => (roomsCache.find(r => r.id === id) || {}).name || '—';

async function loadRooms() {
  const { data, error } = await SB.from('meeting_rooms').select('*').eq('is_active', true).order('sort_order');
  if (error) throw error;
  roomsCache = data || [];
  return roomsCache;
}

// ---------- Requester: book a room ----------
async function renderRoomBooking() {
  const main = $('appMain');
  main.innerHTML = `<div class="card">Loading…</div>`;
  try { await loadRooms(); }
  catch (e) { main.innerHTML = `<div class="card"><p class="err">Meeting rooms are not set up yet (${esc(e.message)}). Ask the admin to run patch_12.</p></div>`; return; }

  main.innerHTML = `
    <div class="card">
      <h2>🏢 Book a meeting room</h2>
      <div class="grid cols-2">
        <div><label>Room *</label><select id="rb_room">
          <option value="">Select a room…</option>
          ${[9, 12].map(f => `<optgroup label="${f}th floor">${roomsCache.filter(r => r.floor === f)
            .map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</optgroup>`).join('')}
        </select></div>
        <div style="position:relative"><label>Date *</label><input id="rb_date" type="text" readonly placeholder="Select date" autocomplete="off" style="cursor:pointer"/><div id="dpPop" class="dp hidden"></div></div>
        <div><label>From *</label><select id="rb_from"><option value="">Select…</option>${hourOptions(7, 21)}</select></div>
        <div><label>To * <span class="meta">(2 hours by default)</span></label><select id="rb_to"><option value="">Select…</option></select></div>
        <div><label>Purpose *</label><select id="rb_purpose">
          ${ROOM_PURPOSES.map(p => `<option>${p}</option>`).join('')}</select></div>
        <div><label>Team leader name *</label><input id="rb_leader" placeholder="Team leader full name"/></div>
      </div>
      <div style="height:10px"></div>
      <label>Notes</label><textarea id="rb_notes" placeholder="Attendees, equipment needed…"></textarea>
      <div id="rb_avail" class="meta" style="margin:10px 0"></div>
      <button id="rb_submit" class="btn">Request room</button>
      <span id="rb_msg" class="meta" style="margin-left:12px"></span>
      <p class="muted" style="margin-top:10px">Your request goes to George for approval. You will get an SMS when it is approved or rejected.</p>
    </div>
    <div class="card">
      <h2>My room requests</h2>
      <div id="rb_mine" class="table-wrap">Loading…</div>
    </div>`;

  // Picking a start time fills "To" with start + 2 hours (can be changed, hourly steps)
  $('rb_from').onchange = () => {
    const h = $('rb_from').value === '' ? null : Number($('rb_from').value.slice(0, 2));
    $('rb_to').innerHTML = '<option value="">Select…</option>' + (h == null ? '' : hourOptions(h + 1, 22));
    if (h != null) $('rb_to').value = hh(Math.min(h + 2, 22)) + ':00';
  };
  initDatePicker($('rb_date'), $('dpPop'), showRoomAvailability);
  $('rb_room').onchange = showRoomAvailability;
  $('rb_submit').onclick = submitRoomBooking;
  window.__refresh = () => { loadMyRoomBookings(); showRoomAvailability(); };
  loadMyRoomBookings();
}

async function showRoomAvailability() {
  const box = $('rb_avail'); if (!box) return;
  const room = $('rb_room').value, date = typedDate($('rb_date').value);
  if (!room || !date) { box.textContent = ''; return; }
  const from = new Date(date + 'T00:00'), to = new Date(date + 'T23:59:59');
  const { data } = await SB.rpc('room_busy', { p_from: from.toISOString(), p_to: to.toISOString() });
  const mine = (data || []).filter(b => b.room_id === room).sort((a, b) => a.start_at.localeCompare(b.start_at));
  box.innerHTML = mine.length
    ? `⛔ Already booked that day: ${mine.map(b => `<b>${fmtTime(b.start_at)}–${fmtTime(b.end_at)}</b>`).join(', ')}`
    : '✅ No approved bookings for this room on that day.';
}

async function submitRoomBooking() {
  const msg = $('rb_msg');
  const err = (t) => { msg.style.color = 'var(--danger)'; msg.textContent = t; };
  const room_id = $('rb_room').value, date = typedDate($('rb_date').value);
  const from = $('rb_from').value, to = $('rb_to').value;
  const team_leader = $('rb_leader').value.trim();
  if (!room_id || !date || !from || !to || !team_leader) return err('Room, date, time and team leader are required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayKey()) return err('Type a valid date as DD/MM/YYYY (today or later).');
  const start = new Date(`${date}T${from}`), end = new Date(`${date}T${to}`);
  if (end <= start) return err('End time must be after the start time.');
  if (start < new Date(Date.now() - 5 * 60000)) return err('Start time is in the past.');

  msg.style.color = 'var(--muted)'; msg.textContent = 'Checking availability…';
  const { data: busy } = await SB.rpc('room_busy', { p_from: start.toISOString(), p_to: end.toISOString() });
  if ((busy || []).some(b => b.room_id === room_id)) { showRoomAvailability(); return err('⛔ This room is already booked for that time. Pick another time or room.'); }

  $('rb_submit').disabled = true; msg.textContent = 'Sending…';
  const { error } = await SB.from('room_bookings').insert({
    room_id, booked_by: me.id, requester_name: profile.full_name || null, team_leader,
    purpose: $('rb_purpose').value, notes: $('rb_notes').value.trim() || null,
    start_at: start.toISOString(), end_at: end.toISOString()
  });
  $('rb_submit').disabled = false;
  if (error) return err(error.message);
  msg.style.color = 'var(--ok)'; msg.textContent = '✓ Request sent to George for approval.';
  ['rb_leader', 'rb_notes', 'rb_from'].forEach(id => $(id).value = '');
  $('rb_to').innerHTML = '<option value="">Select…</option>';
  loadMyRoomBookings();
}

async function loadMyRoomBookings() {
  const box = $('rb_mine'); if (!box) return;
  const { data, error } = await SB.from('room_bookings').select('*').eq('booked_by', me.id).order('start_at', { ascending: false });
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  if (!data.length) { box.innerHTML = '<p class="muted">No requests yet.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Ref</th><th>Room</th><th>When</th><th>Team leader</th><th>Status</th><th></th></tr></thead><tbody>${
    data.map(b => `<tr>
      <td>${esc(b.reference_code)}</td><td>${esc(roomName(b.room_id))}</td>
      <td>${fmtRange(b.start_at, b.end_at)}<div class="meta">${esc(b.purpose)}</div></td>
      <td>${esc(b.team_leader)}</td>
      <td>${statusBadge(b.status)}${b.reject_reason ? `<div class="meta">Reason: ${esc(b.reject_reason)}</div>` : ''}</td>
      <td>${['pending', 'approved'].includes(b.status) && new Date(b.start_at) > new Date()
        ? `<button class="btn ghost sm" data-rbcancel="${b.id}">Cancel</button>` : ''}</td></tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-rbcancel]').forEach(btn => btn.onclick = async () => {
    if (!confirm('Cancel this room request?')) return;
    const { error } = await SB.from('room_bookings').update({ status: 'cancelled' }).eq('id', btn.dataset.rbcancel);
    if (error) alert(error.message);
    loadMyRoomBookings();
  });
}

// ---------- Back end: George / admins / managers ----------
async function renderRoomAdmin() {
  const main = $('appMain');
  try { await loadRooms(); }
  catch (e) { main.innerHTML = `<div class="card"><p class="err">Meeting rooms are not set up yet (${esc(e.message)}).</p></div>`; return; }
  const tab = (k, l) => `<div class="tab ${rbTab === k ? 'active' : ''}" data-rbtab="${k}">${l}</div>`;
  main.innerHTML = `
    <div class="tabs" style="margin-bottom:16px">${tab('requests', '📋 Requests')}${tab('calendar', '🗓️ Room calendar')}${tab('stats', '📊 Usage')}</div>
    <div id="rbBody"></div>`;
  main.querySelectorAll('[data-rbtab]').forEach(t => t.onclick = () => { rbTab = t.dataset.rbtab; renderRoomAdmin(); });
  if (rbTab === 'calendar') return renderRoomCalendar();
  if (rbTab === 'stats') return renderRoomStats();
  renderRoomRequests();
}

async function renderRoomRequests() {
  $('rbBody').innerHTML = `
    <div class="card">
      <div id="rbTiles" class="tiles" style="margin-bottom:14px"></div>
      <div class="tabs" id="rbFilter">${['pending', 'approved', 'rejected', 'cancelled', 'all']
        .map(s => `<div class="tab ${rbFilter === s ? 'active' : ''}" data-f="${s}">${s[0].toUpperCase() + s.slice(1)}</div>`).join('')}</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <select id="rbRoomSel" style="max-width:200px"><option value="">All rooms</option>
          ${roomsCache.map(r => `<option value="${r.id}" ${rbRoom === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        <input type="date" id="rbDateSel" value="${rbDate}" style="max-width:180px"/>
        <button id="rbClear" class="btn ghost sm">Clear</button>
      </div>
      <div id="rbList" class="table-wrap">Loading…</div>
    </div>`;
  document.querySelectorAll('#rbFilter .tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('#rbFilter .tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); rbFilter = t.dataset.f; loadRoomRequests();
  });
  $('rbRoomSel').onchange = (e) => { rbRoom = e.target.value; loadRoomRequests(); };
  $('rbDateSel').onchange = (e) => { rbDate = e.target.value; loadRoomRequests(); };
  $('rbClear').onclick = () => { rbRoom = ''; rbDate = ''; $('rbRoomSel').value = ''; $('rbDateSel').value = ''; loadRoomRequests(); };
  window.__refresh = loadRoomRequests;
  loadRoomRequests();
}

async function loadRoomRequests() {
  const box = $('rbList'); if (!box) return;
  const { data, error } = await SB.from('room_bookings').select('*').order('start_at', { ascending: true });
  if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  const all = data || [];
  const c = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
  all.forEach(b => { if (c[b.status] != null) c[b.status]++; });
  if ($('rbTiles')) $('rbTiles').innerHTML = `
    <div class="tile"><div class="n" style="color:var(--warn)">${c.pending}</div><div class="l">Pending</div></div>
    <div class="tile"><div class="n" style="color:var(--ok)">${c.approved}</div><div class="l">Approved</div></div>
    <div class="tile"><div class="n" style="color:var(--danger)">${c.rejected}</div><div class="l">Rejected</div></div>
    <div class="tile"><div class="n">${c.cancelled}</div><div class="l">Cancelled</div></div>`;
  let rows = all;
  if (rbFilter !== 'all') rows = rows.filter(b => b.status === rbFilter);
  if (rbRoom) rows = rows.filter(b => b.room_id === rbRoom);
  if (rbDate) rows = rows.filter(b => dayKey(b.start_at) === rbDate);
  if (!rows.length) { box.innerHTML = '<p class="muted">No requests for this view.</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Ref</th><th>Room</th><th>When</th><th>Team leader</th><th>Requested by</th><th>Purpose</th><th>Status</th><th></th></tr></thead><tbody>${
    rows.map(b => `<tr>
      <td>${esc(b.reference_code)}</td><td>${esc(roomName(b.room_id))}</td>
      <td>${fmtRange(b.start_at, b.end_at)}</td>
      <td>${esc(b.team_leader)}</td><td>${esc(b.requester_name || '—')}</td>
      <td>${esc(b.purpose)}${b.notes ? `<div class="meta">📝 ${esc(b.notes)}</div>` : ''}</td>
      <td>${statusBadge(b.status)}${b.reject_reason ? `<div class="meta">Reason: ${esc(b.reject_reason)}</div>` : ''}</td>
      <td class="row-actions">${isApprover ? `
        ${b.status === 'pending' ? `<button class="btn ok sm" data-rbok="${b.id}">Approve</button><button class="btn danger sm" data-rbno="${b.id}">Reject</button>` : ''}
        ${['pending', 'approved'].includes(b.status) ? `<button class="btn ghost sm" data-rbx="${b.id}">Cancel</button>` : ''}` : ''}</td>
    </tr>`).join('')
  }</tbody></table>`;
  box.querySelectorAll('[data-rbok]').forEach(b => b.onclick = async () => {
    const { error } = await SB.from('room_bookings').update({ status: 'approved' }).eq('id', b.dataset.rbok);
    if (error) alert(error.message.includes('no_room_double_booking') ? '⛔ Another approved booking already uses this room at that time.' : error.message);
    loadRoomRequests();
  });
  box.querySelectorAll('[data-rbno]').forEach(b => b.onclick = async () => {
    const reason = (prompt('Reason for rejecting (required):') || '').trim();
    if (!reason) return alert('A reason is required to reject.');
    const { error } = await SB.from('room_bookings').update({ status: 'rejected', reject_reason: reason }).eq('id', b.dataset.rbno);
    if (error) alert(error.message);
    loadRoomRequests();
  });
  box.querySelectorAll('[data-rbx]').forEach(b => b.onclick = async () => {
    if (!confirm('Cancel this booking?')) return;
    const { error } = await SB.from('room_bookings').update({ status: 'cancelled' }).eq('id', b.dataset.rbx);
    if (error) alert(error.message);
    loadRoomRequests();
  });
}

async function renderRoomCalendar() {
  if (!calDate) calDate = todayKey();
  $('rbBody').innerHTML = `
    <div class="card">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
        <h2 style="margin:0">🗓️ Room calendar</h2>
        <button id="calPrev" class="btn ghost sm">‹</button>
        <input type="date" id="calDate" value="${calDate}" style="max-width:170px"/>
        <button id="calNext" class="btn ghost sm">›</button>
        <button id="calToday" class="btn secondary sm">Today</button>
      </div>
      <div class="meta" style="margin-bottom:8px"><span class="dotkey" style="background:var(--ok)"></span> approved
        <span class="dotkey" style="background:var(--warn);margin-left:12px"></span> pending</div>
      <div id="calGrid" class="table-wrap">Loading…</div>
    </div>`;
  const go = (d) => { calDate = d; renderRoomCalendar(); };
  const shift = (n) => go(dayKey(new Date(new Date(calDate + 'T12:00').getTime() + n * 86400000)));
  $('calDate').onchange = (e) => e.target.value && go(e.target.value);
  $('calPrev').onclick = () => shift(-1); $('calNext').onclick = () => shift(1);
  $('calToday').onclick = () => go(todayKey());
  window.__refresh = renderRoomCalendar;

  const dayStart = new Date(calDate + 'T00:00'), dayEnd = new Date(calDate + 'T23:59:59');
  const { data, error } = await SB.from('room_bookings').select('*')
    .in('status', ['approved', 'pending']).lt('start_at', dayEnd.toISOString()).gt('end_at', dayStart.toISOString());
  if (error) { $('calGrid').innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  const total = 24 * 3600000, pct = (t) => Math.max(0, Math.min(100, (new Date(t) - dayStart) / total * 100));
  $('calGrid').innerHTML = `<div class="cal">
    <div class="cal-row cal-head"><div class="cal-name"></div><div class="cal-track">
      ${Array.from({ length: 24 }, (_, h) => `<div class="cal-hour">${String(h).padStart(2, '0')}</div>`).join('')}</div></div>
    ${roomsCache.map(r => `<div class="cal-row"><div class="cal-name">${esc(r.name)}</div><div class="cal-track">
      ${Array.from({ length: 24 }, () => '<div class="cal-cell"></div>').join('')}
      ${(data || []).filter(b => b.room_id === r.id).map(b => {
        const l = pct(b.start_at), w = Math.max(1.5, pct(b.end_at) - l);
        return `<div class="cal-bar ${b.status}" data-bid="${b.id}" style="left:${l}%;width:${w}%" title="${esc(fmtTime(b.start_at))}–${esc(fmtTime(b.end_at))} · ${esc(b.team_leader)} · ${esc(b.purpose)} (${b.status})">${esc(fmtTime(b.start_at))} ${esc(b.team_leader)}</div>`;
      }).join('')}</div></div>`).join('')}
  </div>`;
  const byId = Object.fromEntries((data || []).map(b => [b.id, b]));
  $('calGrid').querySelectorAll('[data-bid]').forEach(el => el.onclick = () => showRoomDetail(byId[el.dataset.bid]));
}

// Details window for one booking (opened from the calendar). Approvers can act here.
function showRoomDetail(b) {
  if (!b) return;
  const row = (l, v) => `<div style="display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line)"><div class="meta" style="width:110px;flex:none">${l}</div><div>${v}</div></div>`;
  const bg = el(`<div class="modal-bg"><div class="modal" style="max-width:460px;text-align:left">
    <h2 style="margin:0 0 10px">${esc(roomName(b.room_id))} ${statusBadge(b.status)}</h2>
    ${row('When', fmtRange(b.start_at, b.end_at))}
    ${row('Team leader', esc(b.team_leader))}
    ${row('Requested by', esc(b.requester_name || '—'))}
    ${row('Purpose', esc(b.purpose))}
    ${b.notes ? row('Notes', esc(b.notes)) : ''}
    ${b.reject_reason ? row('Reason', esc(b.reject_reason)) : ''}
    ${row('Reference', esc(b.reference_code))}
    <div class="row-actions" style="margin-top:14px">
      ${isApprover && b.status === 'pending' ? `<button class="btn ok sm" id="mdOk">Approve</button><button class="btn danger sm" id="mdNo">Reject</button>` : ''}
      ${isApprover && ['pending', 'approved'].includes(b.status) ? `<button class="btn danger sm" id="mdX">Cancel booking</button>` : ''}
      <button class="btn ghost sm" id="mdClose">Close</button>
    </div></div></div>`);
  const close = () => { $('modalMount').innerHTML = ''; };
  const act = async (patch, errHint) => {
    const { error } = await SB.from('room_bookings').update(patch).eq('id', b.id);
    if (error) return alert(error.message.includes('no_room_double_booking') ? errHint : error.message);
    close(); if (typeof window.__refresh === 'function') window.__refresh();
  };
  $('modalMount').innerHTML = ''; $('modalMount').appendChild(bg);
  bg.querySelector('#mdClose').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  if (bg.querySelector('#mdOk')) bg.querySelector('#mdOk').onclick = () =>
    act({ status: 'approved' }, '⛔ Another approved booking already uses this room at that time.');
  if (bg.querySelector('#mdNo')) bg.querySelector('#mdNo').onclick = () => {
    const reason = (prompt('Reason for rejecting (required):') || '').trim();
    if (!reason) return alert('A reason is required to reject.');
    act({ status: 'rejected', reject_reason: reason });
  };
  if (bg.querySelector('#mdX')) bg.querySelector('#mdX').onclick = () => {
    if (confirm('Cancel this booking? The requester will get an SMS.')) act({ status: 'cancelled' });
  };
}

async function renderRoomStats() {
  $('rbBody').innerHTML = `<div class="card"><h2>📊 Usage</h2><div id="rbStats">Loading…</div></div>`;
  window.__refresh = renderRoomStats;
  const { data, error } = await SB.from('room_bookings').select('*');
  if (error) { $('rbStats').innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
  const rows = data || [];
  const hrs = (b) => (new Date(b.end_at) - new Date(b.start_at)) / 3600000;
  const perRoom = roomsCache.map(r => {
    const m = rows.filter(b => b.room_id === r.id);
    const ap = m.filter(b => b.status === 'approved');
    return { name: r.name, total: m.length, approved: ap.length, pending: m.filter(b => b.status === 'pending').length,
      rejected: m.filter(b => b.status === 'rejected').length, hours: ap.reduce((s, b) => s + hrs(b), 0) };
  });
  const leaders = {};
  rows.filter(b => b.status === 'approved').forEach(b => {
    const k = b.team_leader.trim(); (leaders[k] = leaders[k] || { n: 0, h: 0 }); leaders[k].n++; leaders[k].h += hrs(b);
  });
  const top = Object.entries(leaders).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
  $('rbStats').innerHTML = `
    <h3>Per room</h3>
    <div class="table-wrap"><table><thead><tr><th>Room</th><th>Requests</th><th>Approved</th><th>Pending</th><th>Rejected</th><th>Approved hours</th></tr></thead><tbody>${
      perRoom.map(r => `<tr><td>${esc(r.name)}</td><td>${r.total}</td><td>${r.approved}</td><td>${r.pending}</td><td>${r.rejected}</td><td>${r.hours.toFixed(1)}</td></tr>`).join('')}</tbody></table></div>
    <h3>Top team leaders (approved bookings)</h3>
    ${top.length ? `<div class="table-wrap"><table><thead><tr><th>Team leader</th><th>Bookings</th><th>Hours</th></tr></thead><tbody>${
      top.map(([n, v]) => `<tr><td>${esc(n)}</td><td>${v.n}</td><td>${v.h.toFixed(1)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No approved bookings yet.</p>'}`;
}
