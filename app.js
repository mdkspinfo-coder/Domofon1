import {
  REVEAL_RADIUS_M,
  MAX_ACCURACY_M,
  canRevealCode,
  distanceMeters,
  formatDistance,
  isInPoland,
} from './geo.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty'; // OpenStreetMap, ключ не нужен
const WARSAW = [21.0122, 52.2297]; // [lon, lat]
const GREEN = '#12A150';
const GREY = '#8A94A6';
const MARKERS_KEY = 'domofon.markers.v1';
const codeKey = (id) => `domofon.code.${id}`;

const $ = (id) => document.getElementById(id);

// ---------- Хранилище ----------
// Координаты и подписи лежат в одном ключе, коды - в отдельных. Коды никогда не попадают в данные карты.
function loadMarkers() {
  try {
    return JSON.parse(localStorage.getItem(MARKERS_KEY) || '[]');
  } catch {
    return [];
  }
}
function saveMarkers(list) {
  localStorage.setItem(MARKERS_KEY, JSON.stringify(list));
}

// ---------- Состояние ----------
let markers = loadMarkers();
let user = null; // {latitude, longitude, accuracy}
let gpsState = 'wait'; // wait | ok | denied | error
let mode = 'browse'; // browse | placing
let in3D = null;
let firstFix = false;
let mapReady = false;
let watchId = null;
let userMarker = null;
let revealId = null;
let draftPos = null;
let toastTimer = null;

// ---------- Карта ----------
const map = new maplibregl.Map({
  container: 'map',
  style: STYLE_URL,
  center: WARSAW,
  zoom: 11,
  maxPitch: 70,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

function geojson() {
  return {
    type: 'FeatureCollection',
    features: markers.map((m) => ({
      type: 'Feature',
      properties: { id: m.id, unlocked: canRevealCode(user, m) ? 1 : 0 }, // пароля здесь нет
      geometry: { type: 'Point', coordinates: [m.longitude, m.latitude] },
    })),
  };
}

const colorExpr = ['case', ['==', ['get', 'unlocked'], 1], GREEN, GREY];

map.on('load', () => {
  map.addSource('markers', { type: 'geojson', data: geojson() });
  map.addLayer({
    id: 'markers-halo',
    type: 'circle',
    source: 'markers',
    paint: { 'circle-radius': 20, 'circle-color': colorExpr, 'circle-opacity': 0.25 },
  });
  map.addLayer({
    id: 'markers-dot',
    type: 'circle',
    source: 'markers',
    paint: {
      'circle-radius': 9,
      'circle-color': colorExpr,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  mapReady = true;
  update3D();
  refresh();
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
map.on('moveend', update3D);

// ---------- Интерфейс ----------
function toast(text, ms = 3500) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function updateStatus() {
  let text;
  if (mode === 'placing') text = 'Наведите прицел на дом и нажмите «Поставить здесь»';
  else if (gpsState === 'denied') text = 'GPS выключен: коды скрыты';
  else if (gpsState === 'error' && !user) text = 'GPS недоступен: коды скрыты';
  else if (user) text = `GPS ±${Math.round(user.accuracy ?? 0)} м${in3D ? ' · 3D' : ''}`;
  else text = 'Ищу GPS…';
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
  $('btnAdd').hidden = placing;
  $('btnMe').hidden = placing;
  $('btnCancel').hidden = !placing;
  $('btnPlace').hidden = !placing;
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
    map.flyTo({ center: [user.longitude, user.latitude], zoom: 17 });
  } else if (gpsState === 'denied') {
    toast('Нет доступа к геолокации. Разрешите её для этого сайта в настройках Safari.', 5000);
    startGps();
  } else {
    toast('Ищу сигнал GPS…');
    startGps();
  }
});

// ---------- Добавление маркера ----------
$('btnAdd').addEventListener('click', () => setMode('placing'));
$('btnCancel').addEventListener('click', () => setMode('browse'));

$('btnPlace').addEventListener('click', () => {
  const c = map.getCenter();
  draftPos = { latitude: c.lat, longitude: c.lng };
  $('inTitle').value = '';
  $('inCode').value = '';
  $('addModal').hidden = false;
  setMode('browse');
  setTimeout(() => $('inCode').focus(), 50);
});

$('btnAddCancel').addEventListener('click', () => {
  $('addModal').hidden = true;
  draftPos = null;
});

$('btnSave').addEventListener('click', () => {
  const code = $('inCode').value.trim();
  if (!code) {
    toast('Введите пароль домофона.');
    return;
  }
  if (!draftPos) return;
  const marker = {
    id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    latitude: draftPos.latitude,
    longitude: draftPos.longitude,
    title: $('inTitle').value.trim(),
    createdAt: Date.now(),
  };
  try {
    // Сначала код, потом список: маркер без кода не появится.
    localStorage.setItem(codeKey(marker.id), code);
    markers = [...markers, marker];
    saveMarkers(markers);
  } catch {
    localStorage.removeItem(codeKey(marker.id));
    markers = markers.filter((m) => m.id !== marker.id);
    toast('Не удалось сохранить: хранилище браузера недоступно (приватный режим?).', 5000);
    return;
  }
  $('addModal').hidden = true;
  draftPos = null;
  refresh();
  toast('Маркер сохранён.');
});

// ---------- Нажатие на маркер ----------
map.on('click', (e) => {
  if (mode === 'placing' || !mapReady) return;
  const f = map.queryRenderedFeatures(e.point, { layers: ['markers-halo'] })[0];
  if (f) onMarkerTap(f.properties.id);
});

function onMarkerTap(id) {
  const marker = markers.find((m) => m.id === id);
  if (!marker) return;
  const name = marker.title || 'Домофон';

  // Проверка повторяется в момент нажатия: данные карты могли устареть.
  if (!canRevealCode(user, marker)) {
    if (!user) toast(`${name}: нет сигнала GPS, код скрыт.`);
    else if (user.accuracy == null || user.accuracy > MAX_ACCURACY_M)
      toast(`${name}: слишком низкая точность GPS, код скрыт. Выйдите на открытое место.`, 5000);
    else
      toast(`${name}: код откроется в радиусе ${REVEAL_RADIUS_M} м. Сейчас до точки ${formatDistance(distanceMeters(user, marker))}.`, 5000);
    return;
  }
  revealId = id;
  $('revealTitle').textContent = name;
  $('revealCode').textContent = localStorage.getItem(codeKey(id)) ?? '— не найден —';
  $('revealModal').hidden = false;
}

function closeReveal() {
  revealId = null;
  $('revealCode').textContent = '';
  $('revealModal').hidden = true;
}
$('btnClose').addEventListener('click', closeReveal);
$('revealModal').addEventListener('click', (e) => {
  if (e.target === $('revealModal')) closeReveal();
});

$('btnDelete').addEventListener('click', () => {
  if (!revealId) return;
  if (!confirm('Удалить маркер? Код будет стёрт с устройства.')) return;
  const id = revealId;
  closeReveal();
  markers = markers.filter((m) => m.id !== id);
  saveMarkers(markers);
  localStorage.removeItem(codeKey(id));
  refresh();
});

// ---------- Запуск ----------
startGps();
updateStatus();
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
