// Чистая логика без зависимостей: расстояния, радиус показа кода, границы Польши.
// Это та же логика, что в мобильной версии (src/geo.ts), покрыта тестами tests/geo.test.js.

export const REVEAL_RADIUS_M = 800;
/** Если точность GPS хуже этого значения (м), позиция считается ненадёжной и код скрыт. */
export const MAX_ACCURACY_M = 100;

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;

/** Расстояние между точками {latitude, longitude} по формуле гаверсинуса, в метрах. */
export function distanceMeters(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Можно ли показывать код домофона.
 * Нет позиции или плохая точность -> нельзя. Граница включительно (<= 800 м).
 */
export function canRevealCode(user, point, radiusM = REVEAL_RADIUS_M) {
  if (!user) return false;
  if (user.accuracy == null || !Number.isFinite(user.accuracy) || user.accuracy > MAX_ACCURACY_M) {
    return false;
  }
  return distanceMeters(user, point) <= radiusM;
}

/** Грубый прямоугольник Польши. Нужен только для включения 3D-зданий. */
export const POLAND_BBOX = { minLat: 49.0, maxLat: 54.9, minLon: 14.1, maxLon: 24.2 };

export function isInPoland(p) {
  return (
    p.latitude >= POLAND_BBOX.minLat &&
    p.latitude <= POLAND_BBOX.maxLat &&
    p.longitude >= POLAND_BBOX.minLon &&
    p.longitude <= POLAND_BBOX.maxLon
  );
}

export function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} м`;
  return `${(m / 1000).toFixed(1)} км`;
}
