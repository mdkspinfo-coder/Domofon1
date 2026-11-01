import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, canRevealCode, isInPoland, formatDistance, REVEAL_RADIUS_M } from '../geo.js';

const point = { latitude: 50.0617, longitude: 19.9373 }; // Рынок, Краков
const northOf = (p, m) => ({ latitude: p.latitude + m / 111195, longitude: p.longitude });

test('расстояние до самой себя = 0', () => assert.equal(distanceMeters(point, point), 0));

test('Краков - Варшава примерно 252 км', () => {
  const d = distanceMeters(point, { latitude: 52.2297, longitude: 21.0122 }) / 1000;
  assert.ok(d > 245 && d < 260, `получили ${d} км`);
});

test('сдвиг на 500 м даёт ~500 м', () => {
  assert.ok(Math.abs(distanceMeters(point, northOf(point, 500)) - 500) < 2);
});

test('на 790 м код доступен, на 810 м нет', () => {
  assert.equal(canRevealCode({ ...northOf(point, 790), accuracy: 10 }, point), true);
  assert.equal(canRevealCode({ ...northOf(point, 810), accuracy: 10 }, point), false);
});

test('далеко (5 км) код недоступен', () => {
  assert.equal(canRevealCode({ ...northOf(point, 5000), accuracy: 5 }, point), false);
});

test('радиус по умолчанию = 800', () => assert.equal(REVEAL_RADIUS_M, 800));

test('нет GPS -> недоступен', () => {
  assert.equal(canRevealCode(null, point), false);
  assert.equal(canRevealCode(undefined, point), false);
});

test('плохая точность (>100 м) -> недоступен даже рядом', () => {
  assert.equal(canRevealCode({ ...point, accuracy: 500 }, point), false);
  assert.equal(canRevealCode({ ...point, accuracy: null }, point), false);
  assert.equal(canRevealCode({ ...point, accuracy: NaN }, point), false);
});

test('границы Польши', () => {
  assert.equal(isInPoland(point), true);
  assert.equal(isInPoland({ latitude: 52.2297, longitude: 21.0122 }), true);
  assert.equal(isInPoland({ latitude: 54.35, longitude: 18.65 }), true);
  assert.equal(isInPoland({ latitude: 52.52, longitude: 13.405 }), false);
  assert.equal(isInPoland({ latitude: 50.45, longitude: 30.52 }), false);
});

test('форматирование расстояния', () => {
  assert.equal(formatDistance(420.4), '420 м');
  assert.equal(formatDistance(1500), '1.5 км');
});
