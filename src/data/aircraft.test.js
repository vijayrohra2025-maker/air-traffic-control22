import test from 'node:test';
import assert from 'node:assert/strict';
import { combineAircraftUpdates, convertStateVector, getRetryDelayMs, isAircraftStale } from './aircraft.js';

test('converts OpenSky vectors and converts altitude and speed units', () => {
  const plane = convertStateVector([
    'abc123', 'IGO6713 ', 'India', 1_800_000_000, 1_800_000_001,
    77.1, 28.6, 10_000, false, 100, 270,
  ]);

  assert.equal(plane.callsign, 'IGO6713');
  assert.equal(plane.latitude, 28.6);
  assert.equal(plane.longitude, 77.1);
  assert.equal(Math.round(plane.altitude), 32_808);
  assert.equal(Math.round(plane.velocity), 194);
  assert.equal(plane.onGround, false);
});

test('merges missing fields and detects aircraft entering and leaving', () => {
  const previous = [{
    id: 'abc123', icao24: 'abc123', callsign: 'IGO6713', latitude: 28.6,
    longitude: 77.1, altitude: 30_000, velocity: 200, heading: 270,
    onGround: false, lastContact: 1_800_000_000, lastSeenAt: 1_800_000_000_000,
  }];
  const current = [{
    id: 'abc123', icao24: 'abc123', callsign: 'IGO6713', latitude: 28.7,
    longitude: 77.2, altitude: null, velocity: null, heading: null,
    onGround: null, lastContact: 1_800_000_010, lastPositionUpdate: 1_800_000_010,
  }, {
    id: 'def456', icao24: 'def456', callsign: 'AIC101', latitude: 19,
    longitude: 72, altitude: 20_000, velocity: 180, heading: 90,
    onGround: false, lastContact: 1_800_000_010, lastPositionUpdate: 1_800_000_010,
  }];

  const update = combineAircraftUpdates(previous, current, 1_800_000_010_000);
  const retained = update.aircraft.find((plane) => plane.id === 'abc123');

  assert.equal(retained.altitude, 30_000);
  assert.equal(retained.velocity, 200);
  assert.equal(retained.observations.length, 1);
  assert.deepEqual(retained.observations[0], {
    latitude: 28.7,
    longitude: 77.2,
    timestamp: 1_800_000_010,
  });
  assert.equal(update.enteredCount, 1);
  assert.equal(update.leftCount, 0);

  const nextUpdate = combineAircraftUpdates(update.aircraft, [current[1]], 1_800_000_020_000);
  assert.equal(nextUpdate.leftCount, 1);
  assert.equal(nextUpdate.aircraft.find((plane) => plane.id === 'abc123').leftRegion, true);
});

test('records each position timestamp only once and keeps the latest twelve', () => {
  const base = {
    id: 'abc123', icao24: 'abc123', callsign: 'TEST1', latitude: 1,
    longitude: 2, altitude: 10_000, velocity: 100, heading: 90,
    onGround: false, lastContact: 1_800_000_000, lastPositionUpdate: 1_800_000_000,
  };
  const first = combineAircraftUpdates([], [base], 1_800_000_000_000).aircraft;
  const repeated = combineAircraftUpdates(first, [base], 1_800_000_001_000).aircraft;
  assert.equal(repeated[0].observations.length, 1);

  const twelvePositions = Array.from({ length: 13 }, (_, index) => ({
    ...base,
    latitude: index,
    lastPositionUpdate: 1_800_000_000 + index,
  }));
  const history = twelvePositions.reduce((previous, plane) =>
    combineAircraftUpdates(previous, [plane], (plane.lastPositionUpdate + 2) * 1000).aircraft,
  []);
  assert.equal(history[0].observations.length, 12);
  assert.equal(history[0].observations[0].latitude, 1);
});

test('backs off retries exponentially and caps the delay at five minutes', () => {
  assert.equal(getRetryDelayMs(1), 30_000);
  assert.equal(getRetryDelayMs(2), 60_000);
  assert.equal(getRetryDelayMs(3), 120_000);
  assert.equal(getRetryDelayMs(10), 300_000);
});

test('marks reports stale based on the latest received contact', () => {
  const plane = { lastSeenAt: 1_800_000_000_000 };
  assert.equal(isAircraftStale(plane, 1_800_000_119_999), false);
  assert.equal(isAircraftStale(plane, 1_800_000_120_001), true);
  assert.equal(isAircraftStale({ lastContact: 1_800_000_000 }, 1_800_000_120_001), true);
});
