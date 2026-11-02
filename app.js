import {
  REVEAL_RADIUS_M,
  MAX_ACCURACY_M,
  canRevealCode,
  distanceMeters,
  formatDistance,
  isInPoland,
} from './geo.js';
import { CONFIG } from './config.js';
import { createStore, legacy } from './store.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'; // OpenStreetMap, ключ не нужен
const WARSAW = [21.0122, 52.2297]; // [lon, lat]
const GREEN = '#12A150';
const GREY = '#8A94A6';
const MIN_LOAD_ZOOM = 9; // на меньшем масштабе метки не загружаются (слишком большая область)

const $ = (id) => document.getElementById(id);
const store = createStore(CONFIG);

// ---------- Состояние ----------
let markers = []; // [{id, latitude, longitude, title, mine}] - без паролей
let authUser = null;
let user = null; // позиция по GPS: {latitude, longitude, accuracy}
let gpsState = 'wait'; // wait | ok | denied | error
let netError = false;
let mode = 'browse'; // browse | placing
let in3D = null;
let firstFix = false;
let mapReady = false;
let watchId = null;
let userMarker = null;
let revealId = null;
let draftPos = null;
let toastTimer = null;
let loadTimer = null;
let loadSeq = 0;
let migrationAsked = false;
let role = null; // owner | moderator | null (определяет сервер)
let consentOk = false; // принял ли пользователь текущую версию документов
let consentVersion = null;
let reportTarget = null;

const isErr = (e, key) => e?.code === key || e?.message === key;

// ---------- Карта ----------
const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: WARSAW,
  zoom: 11,
  maxPitch: 70,
  attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true, visualizePitch: true }), 'top-right');

function geojson() {
  return {
    type: 'FeatureCollection',
    features: markers.map((m) => ({
      type: 'Feature',
      properties: { id: m.id, unlocked: canRevealCode(user, m) ? 1 : 0, mine: m.mine ? 1 : 0 }, // пароля здесь нет
      geometry: { type: 'Point', coordinates: [m.longitude, m.latitude] },
    })),
  };
}

const colorExpr = ['case', ['==', ['get', 'unlocked'], 1], GREEN, GREY];
// Размер метки зависит от масштаба: издали это маленькая точка, вблизи крупнее.
const zoomSize = (stops) => ['interpolate', ['linear'], ['zoom'], ...stops.flat()];

map.on('load', () => {
  map.addSource('markers', { type: 'geojson', data: geojson() });
  map.addLayer({
    id: 'markers-halo',
    type: 'circle',
    source: 'markers',
    paint: {
      'circle-radius': zoomSize([[10, 0], [13, 8], [16, 13], [19, 19]]),
      'circle-color': colorExpr,
      'circle-opacity': 0.22,
    },
  });
  map.addLayer({
    id: 'markers-dot',
    type: 'circle',
    source: 'markers',
    paint: {
      'circle-radius': zoomSize([[6, 2], [10, 3.5], [13, 5], [16, 8], [19, 11]]),
      'circle-color': colorExpr,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': zoomSize([[6, 0.5], [13, 1.5], [16, 2.5]]),
    },
  });
  mapReady = true;
  update3D();
  loadMarkers();
});

// 3D-здания только в Польше: по центру экрана включаем слои fill-extrusion стиля и наклон камеры.
function update3D() {
  if (!mapReady) return;
  const c = map.getCenter();
  const inPl = isInPoland({ latitude: c.lat, longitude: c.lng });
  if (inPl === in3D) return;
  in3D = inPl;
  for (const layer of map.getStyle().layers) {
    if (layer.type === 'fill-extrusion') {
      map.setLayoutProperty(layer.id, 'visibility', inPl ? 'visible' : 'none');
    }
  }
  map.easeTo({ pitch: inPl ? 55 : 0, duration: 600 });
  updateStatus();
}

map.on('moveend', () => {
  update3D();
  updateStatus();
  scheduleLoad();
});

// ---------- Загрузка меток (свои и чужие) ----------
function scheduleLoad(delay = 350) {
  clearTimeout(loadTimer);
  loadTimer = setTimeout(loadMarkers, delay);
}

async function loadMarkers() {
  if (!mapReady) return;
  const seq = ++loadSeq;
  if (map.getZoom() < MIN_LOAD_ZOOM) {
    markers = [];
    refresh();
    return;
  }
  const b = map.getBounds();
  try {
    const list = await store.markersInBounds({
      south: b.getSouth(),
      north: b.getNorth(),
      west: b.getWest(),
      east: b.getEast(),
    });
    if (seq !== loadSeq) return; // пришёл более старый ответ
    markers = list;
    netError = false;
  } catch {
    if (seq !== loadSeq) return;
    netError = true;
  }
  refresh();
}

setInterval(() => {
  if (!document.hidden) loadMarkers();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadMarkers();
});

// ---------- Интерфейс ----------
function toast(text, ms = 3800) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

const ERRORS = {
  auth_required: 'Войдите в аккаунт.',
  too_far: `Код откроется в радиусе ${REVEAL_RADIUS_M} м от точки.`,
  low_accuracy: 'Слишком низкая точность GPS, код скрыт. Выйдите на открытое место.',
  not_found: 'Метка уже удалена.',
  rate_limit: 'Слишком много запросов. Попробуйте позже.',
  bad_code: 'Некорректный пароль.',
  bad_position: 'Некорректная позиция.',
  storage: 'Не удалось сохранить: хранилище браузера недоступно (приватный режим?).',
  not_configured: 'Сервер ещё не подключён.',
  lib_failed: 'Не удалось загрузить сервер. Проверьте интернет и перезагрузите страницу.',
  consent_required: 'Сначала примите правила и дайте согласие на обработку данных.',
  banned: 'Ваш аккаунт заблокирован за нарушение правил. Если это ошибка, напишите оператору.',
  already_reported: 'Вы уже жаловались на эту метку. Модераторы её рассмотрят.',
  own_marker: 'На свою метку жаловаться нельзя: её можно удалить.',
  bad_reason: 'Выберите причину жалобы.',
  bad_version: 'Документы обновились. Перезагрузите страницу.',
  owner_cannot_delete: 'Аккаунт владельца сервиса удалить нельзя.',
};
function errText(e) {
  const key = e?.code && ERRORS[e.code] ? e.code : e?.message;
  return ERRORS[key] || 'Не получилось выполнить действие. Проверьте интернет и повторите.';
}

function updateStatus() {
  let text;
  if (mode === 'placing') text = 'Наведите прицел на дом и нажмите «Поставить здесь»';
  else if (gpsState === 'denied') text = 'GPS выключен: коды скрыты';
  else if (gpsState === 'error' && !user) text = 'GPS недоступен: коды скрыты';
  else if (user) text = `GPS ±${Math.round(user.accuracy ?? 0)} м${in3D ? ' · 3D' : ''}`;
  else text = 'Ищу GPS…';
  if (mode !== 'placing') {
    if (mapReady && map.getZoom() < MIN_LOAD_ZOOM) text += ' · приблизьте карту, чтобы увидеть метки';
    else if (netError) text += ' · нет связи с сервером';
  }
  $('status').textContent = text;
}

function refresh() {
  if (mapReady) map.getSource('markers').setData(geojson());
  updateStatus();
  // Ушли из радиуса, пока окно с кодом открыто: закрываем и стираем код из страницы.
  if (revealId) {
    const m = markers.find((x) => x.id === revealId);
    if (!m || !canRevealCode(user, m)) {
      closeReveal();
      toast('Вы вышли из радиуса, код скрыт.');
    }
  }
}

function setMode(next) {
  mode = next;
  const placing = next === 'placing';
  $('cross').hidden = !placing;
  $('fabs').hidden = placing;
  $('bar').hidden = !placing;
  updateStatus();
}

// ---------- GPS ----------
function startGps() {
  if (!('geolocation' in navigator)) {
    gpsState = 'error';
    updateStatus();
    return;
  }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 20000,
  });
}

function onPosition(p) {
  gpsState = 'ok';
  user = { latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy };
  const lngLat = [user.longitude, user.latitude];
  if (!userMarker) {
    const el = document.createElement('div');
    el.className = 'user-dot';
    userMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map);
  } else {
    userMarker.setLngLat(lngLat);
  }
  if (!firstFix) {
    firstFix = true;
    map.flyTo({ center: lngLat, zoom: 16 });
  }
  refresh();
}

function onGpsError(e) {
  if (e.code === 1) {
    gpsState = 'denied';
    user = null; // доступа нет - позицию не помним
  } else {
    gpsState = user ? 'ok' : 'error';
  }
  refresh();
}

$('btnMe').addEventListener('click', () => {
  if (user) {
    map.flyTo({ center: [user.longitude, user.latitude], zoom: Math.max(map.getZoom(), 17) });
  } else if (gpsState === 'denied') {
    toast('Нет доступа к геолокации. Разрешите её для этого сайта в настройках Safari.', 5000);
    startGps();
  } else {
    toast('Ищу сигнал GPS…');
    startGps();
  }
});

// ---------- Аккаунт ----------
function renderAccountButton() {
  const btn = $('accountBtn');
  btn.querySelector('.initial, img')?.remove();
  $('accIcon').style.display = authUser ? 'none' : '';
  if (!authUser) return;
  if (authUser.avatar) {
    const img = document.createElement('img');
    img.src = authUser.avatar;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(initialEl()));
    btn.appendChild(img);
  } else {
    btn.appendChild(initialEl());
  }
}
function initialEl() {
  const d = document.createElement('div');
  d.className = 'initial';
  d.textContent = (authUser?.name || authUser?.email || '?').trim().charAt(0).toUpperCase();
  return d;
}

function renderAccountSheet(message) {
  const remote = store.kind === 'remote';
  $('accMsg').textContent = message || '';
  $('accMsg').hidden = !message;
  $('accOut').hidden = !remote || !!authUser;
  $('accIn').hidden = !remote || !authUser;
  $('accOff').hidden = remote;
  if (!remote) $('accOff').textContent = ERRORS[store.reason] + ' Пока метки хранятся только на этом телефоне и другим пользователям не видны.';

  const appleOn = !!CONFIG.PROVIDERS?.apple;
  $('btnApple').disabled = !appleOn;
  $('appleSoon').hidden = appleOn;
  $('btnGoogle').hidden = !CONFIG.PROVIDERS?.google;
  $('btnMod').hidden = !role;
  $('btnDeleteAccount').hidden = !authUser;
  $('accRole').hidden = !role;
  $('accRole').textContent = role === 'owner' ? 'Владелец' : role === 'moderator' ? 'Модератор' : '';

  if (authUser) {
    $('accName').textContent = authUser.name;
    $('accMail').textContent = authUser.email;
    const av = $('accAvatar');
    av.textContent = '';
    if (authUser.avatar) {
      const img = document.createElement('img');
      img.src = authUser.avatar;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      av.appendChild(img);
    } else {
      av.textContent = initialEl().textContent;
    }
  }
}

function openAccount(message) {
  renderAccountSheet(message);
  $('accModal').hidden = false;
}
$('accountBtn').addEventListener('click', () => openAccount());
$('btnAccClose').addEventListener('click', () => ($('accModal').hidden = true));
$('accModal').addEventListener('click', (e) => {
  if (e.target === $('accModal')) $('accModal').hidden = true;
});

async function signIn(provider) {
  try {
    await store.signIn(provider); // дальше браузер уходит на страницу входа и возвращается обратно
  } catch (e) {
    toast(errText(e), 5000);
  }
}
$('btnGoogle').addEventListener('click', () => signIn('google'));
$('btnApple').addEventListener('click', () => signIn('apple'));

$('btnSignOut').addEventListener('click', async () => {
  try {
    await store.signOut();
  } catch {
    /* сессия всё равно сбрасывается на устройстве */
  }
  closeReveal();
  $('accModal').hidden = true;
});

async function onAuth(u) {
  authUser = u;
  renderAccountButton();
  if (!u) {
    closeReveal();
    closeConsent();
    $('reportModal').hidden = true;
    reportTarget = null;
    role = null;
    consentOk = false;
  }
  if (!$('accModal').hidden) renderAccountSheet();
  await loadMarkers(); // флаг «мои» зависит от того, кто вошёл
  if (u) {
    await loadAccountMeta();
    if (consentOk) offerMigration();
  }
}

// Роль (владелец/модератор) и статус согласия определяет сервер. Тут мы только показываем нужные кнопки и окна.
async function loadAccountMeta() {
  role = null;
  consentOk = false;
  if (store.kind !== 'remote' || !authUser) return;
  try {
    const [c, r] = await Promise.all([store.call('my_consent'), store.call('my_role')]);
    consentOk = !!c?.accepted;
    consentVersion = c?.version ?? null;
    role = r || null;
    if (!consentOk) showConsent();
  } catch {
    /* нет связи: действия всё равно проверит сервер */
  }
  if (!$('accModal').hidden) renderAccountSheet();
}

// ---------- Согласие с документами ----------
function showConsent() {
  $('chkTerms').checked = false;
  $('chkData').checked = false;
  $('btnConsentAccept').disabled = true;
  $('consentModal').hidden = false;
}
function closeConsent() {
  $('consentModal').hidden = true;
}
const syncConsentBtn = () => ($('btnConsentAccept').disabled = !($('chkTerms').checked && $('chkData').checked));
$('chkTerms').addEventListener('change', syncConsentBtn);
$('chkData').addEventListener('change', syncConsentBtn);

$('btnConsentAccept').addEventListener('click', async () => {
  $('btnConsentAccept').disabled = true;
  try {
    if (!consentVersion) consentVersion = (await store.call('my_consent'))?.version;
    await store.call('accept_terms', { p_version: consentVersion });
    consentOk = true;
    closeConsent();
    toast('Спасибо! Теперь можно добавлять домофоны и открывать коды.', 5000);
    offerMigration();
  } catch (e) {
    syncConsentBtn();
    toast(errText(e), 5000);
  }
});

$('btnConsentDecline').addEventListener('click', async () => {
  closeConsent();
  try {
    await store.signOut();
  } catch {
    /* сессия всё равно сбрасывается на устройстве */
  }
  toast('Без согласия пользоваться аккаунтом нельзя. Карту можно смотреть и без входа.', 6000);
});

function ensureConsent() {
  if (store.kind !== 'remote' || !authUser || consentOk) return true;
  showConsent();
  return false;
}
function consentMissing() {
  consentOk = false; // сервер сказал, что согласия нет (например, документы обновились)
  showConsent();
}

// ---------- Модерация и удаление аккаунта ----------
$('btnMod').addEventListener('click', () => window.open('moderation.html', '_blank', 'noopener'));

$('btnDeleteAccount').addEventListener('click', async () => {
  if (!confirm('Удалить аккаунт? Будут безвозвратно удалены ваши метки, коды и согласие. Это нельзя отменить.')) return;
  if (!confirm('Точно удалить аккаунт и все ваши метки?')) return;
  try {
    await store.call('delete_my_account');
  } catch (e) {
    toast(errText(e), 5000);
    return;
  }
  try {
    await store.signOut();
  } catch {
    /* аккаунта уже нет, сессия сбросится сама */
  }
  closeReveal();
  $('accModal').hidden = true;
  toast('Аккаунт удалён вместе с вашими метками.', 6000);
  loadMarkers();
});

// Метки, созданные в старой версии (только на телефоне), можно один раз перенести на сервер.
async function offerMigration() {
  if (migrationAsked || store.kind !== 'remote') return;
  const old = legacy.list();
  if (!old.length) return;
  migrationAsked = true;
  if (!confirm(`На этом телефоне есть метки из старой версии (${old.length}). Загрузить их на сервер, чтобы их видели другие?`)) return;
  let done = 0;
  for (const m of old) {
    const code = legacy.code(m.id);
    if (!code) continue;
    try {
      await store.addMarker({ latitude: m.latitude, longitude: m.longitude, title: m.title || '', code });
      legacy.remove(m.id);
      done++;
    } catch (e) {
      toast(errText(e), 5000);
      break;
    }
  }
  if (done) toast(`Перенесено меток: ${done}.`);
  loadMarkers();
}

// ---------- Добавление маркера ----------
$('btnAdd').addEventListener('click', () => {
  if (store.kind === 'remote' && !authUser) {
    openAccount('Войдите, чтобы добавлять домофоны.');
    return;
  }
  if (!ensureConsent()) return;
  setMode('placing');
});
$('btnCancel').addEventListener('click', () => setMode('browse'));

$('btnPlace').addEventListener('click', () => {
  const c = map.getCenter();
  draftPos = { latitude: c.lat, longitude: c.lng };
  $('inTitle').value = '';
  $('inCode').value = '';
  $('addHint').hidden = store.kind !== 'remote';
  $('addModal').hidden = false;
  setMode('browse');
  setTimeout(() => $('inCode').focus(), 50);
});

$('btnAddCancel').addEventListener('click', () => {
  $('addModal').hidden = true;
  draftPos = null;
});

$('btnSave').addEventListener('click', async () => {
  const code = $('inCode').value.trim();
  if (!code) {
    toast('Введите пароль домофона.');
    return;
  }
  if (!draftPos) return;
  $('btnSave').disabled = true;
  try {
    await store.addMarker({
      latitude: draftPos.latitude,
      longitude: draftPos.longitude,
      title: $('inTitle').value.trim(),
      code,
    });
  } catch (e) {
    $('btnSave').disabled = false;
    if (isErr(e, 'auth_required')) {
      $('addModal').hidden = true;
      openAccount('Сессия закончилась. Войдите снова.');
    } else if (isErr(e, 'consent_required')) {
      $('addModal').hidden = true;
      consentMissing();
    } else {
      toast(errText(e), 5000);
    }
    return;
  }
  $('btnSave').disabled = false;
  $('addModal').hidden = true;
  draftPos = null;
  toast('Метка сохранена.');
  loadMarkers();
});

// ---------- Нажатие на маркер ----------
map.on('click', (e) => {
  if (mode === 'placing' || !mapReady) return;
  const r = 14; // маленькие точки трудно задеть пальцем, поэтому ищем в квадрате вокруг касания
  const f = map.queryRenderedFeatures(
    [[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]],
    { layers: ['markers-dot'] },
  )[0];
  if (f) onMarkerTap(f.properties.id);
});

async function onMarkerTap(id) {
  const marker = markers.find((m) => m.id === id);
  if (!marker) return;
  const name = marker.title || 'Домофон';

  // Проверка на телефоне нужна, чтобы не слать лишних запросов. Окончательное решение принимает сервер.
  if (!canRevealCode(user, marker)) {
    if (!user) toast(`${name}: нет сигнала GPS, код скрыт.`);
    else if (user.accuracy == null || user.accuracy > MAX_ACCURACY_M) toast(`${name}: ${ERRORS.low_accuracy}`, 5000);
    else toast(`${name}: код откроется в радиусе ${REVEAL_RADIUS_M} м. Сейчас до точки ${formatDistance(distanceMeters(user, marker))}.`, 5000);
    return;
  }
  if (store.kind === 'remote' && !authUser) {
    openAccount('Войдите, чтобы увидеть код.');
    return;
  }
  if (!ensureConsent()) return;
  try {
    const code = await store.revealCode(id, user);
    if (!canRevealCode(user, marker)) return; // пока шёл запрос, вы отошли
    revealId = id;
    $('revealTitle').textContent = name;
    $('revealCode').textContent = code ?? '— не найден —';
    $('btnDelete').hidden = !marker.mine;
    $('btnReport').hidden = marker.mine || store.kind !== 'remote'; // на свою метку жаловаться незачем
    $('revealModal').hidden = false;
  } catch (e) {
    if (isErr(e, 'consent_required')) consentMissing();
    else toast(`${name}: ${errText(e)}`, 5000);
  }
}

// ---------- Жалобы ----------
$('btnReport').addEventListener('click', () => {
  if (!revealId) return;
  reportTarget = revealId;
  document.querySelectorAll('#reasons input').forEach((r) => (r.checked = false));
  $('reportComment').value = '';
  $('btnReportSend').disabled = true;
  $('reportModal').hidden = false;
});
document.querySelectorAll('#reasons input').forEach((r) =>
  r.addEventListener('change', () => ($('btnReportSend').disabled = false)),
);
$('btnReportCancel').addEventListener('click', () => {
  $('reportModal').hidden = true;
  reportTarget = null;
});
$('btnReportSend').addEventListener('click', async () => {
  const reason = document.querySelector('#reasons input:checked')?.value;
  if (!reason || !reportTarget) return;
  $('btnReportSend').disabled = true;
  try {
    await store.call('report_marker', {
      p_marker: reportTarget,
      p_reason: reason,
      p_comment: $('reportComment').value.trim(),
    });
    $('reportModal').hidden = true;
    reportTarget = null;
    toast('Жалоба отправлена. Её увидят модераторы. Спасибо!', 5000);
  } catch (e) {
    $('btnReportSend').disabled = false;
    if (isErr(e, 'consent_required')) {
      $('reportModal').hidden = true;
      consentMissing();
    } else {
      toast(errText(e), 5000);
    }
  }
});

function closeReveal() {
  revealId = null;
  $('revealCode').textContent = '';
  $('revealModal').hidden = true;
}
$('btnClose').addEventListener('click', closeReveal);
$('revealModal').addEventListener('click', (e) => {
  if (e.target === $('revealModal')) closeReveal();
});

$('btnDelete').addEventListener('click', async () => {
  if (!revealId) return;
  if (!confirm('Удалить метку? Она пропадёт у всех пользователей.')) return;
  const id = revealId;
  try {
    await store.deleteMarker(id);
  } catch (e) {
    toast(errText(e), 5000);
    return;
  }
  closeReveal();
  loadMarkers();
});

// ---------- Запуск ----------
async function boot() {
  startGps();
  updateStatus();
  const params = new URLSearchParams(location.search);
  const authError = params.get('error_description');
  try {
    const u = await store.init();
    store.onAuthChange(onAuth);
    authUser = u;
    renderAccountButton();
  } catch {
    /* работаем как гость */
  }
  if (/[?&](code|error|error_description)=|access_token=/.test(location.search + location.hash)) {
    history.replaceState(null, '', location.pathname); // убираем служебные параметры входа из адреса
  }
  if (authError) toast(`Вход не удался: ${authError}`, 6000);
  loadMarkers();
  if (authUser) {
    await loadAccountMeta();
    if (consentOk) offerMigration();
  }
}
boot();

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
