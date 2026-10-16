const METERS_TO_FEET = 3.28084;
const METERS_PER_SECOND_TO_KNOTS = 1.94384;
const STALE_AFTER_MS = 2 * 60 * 1000;
const LEFT_REGION_RETENTION_MS = 60 * 60 * 1000;

export function getRetryDelayMs(failureCount) {
  const retryNumber = Math.max(1, Math.floor(failureCount));
  return Math.min(30_000 * (2 ** Math.min(retryNumber - 1, 4)), 5 * 60 * 1000);
}

export function isAircraftStale(plane, now = Date.now()) {
  const lastSeenAt = Number.isFinite(plane.lastSeenAt)
    ? plane.lastSeenAt
    : Number.isFinite(plane.lastContact)
      ? plane.lastContact * 1000
      : null;
  return lastSeenAt !== null && now - lastSeenAt > STALE_AFTER_MS;
}

export function convertStateVector(state) {
  const latitude = state[6];
  const longitude = state[5];
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const icao24 = state[0];
  const callsign = typeof state[1] === 'string' ? state[1].trim() : '';
  const altitudeMeters = state[7] ?? state[13];

  return {
    id: icao24,
    icao24,
    callsign: callsign || icao24.toUpperCase(),
    latitude,
    longitude,
    altitude: Number.isFinite(altitudeMeters) ? altitudeMeters * METERS_TO_FEET : null,
    velocity: Number.isFinite(state[9]) ? state[9] * METERS_PER_SECOND_TO_KNOTS : null,
    heading: Number.isFinite(state[10]) ? state[10] : null,
    onGround: state[8],
    lastPositionUpdate: Number.isFinite(state[3]) ? state[3] : null,
    lastContact: state[4],
  };
}

export function combineAircraftUpdates(previousAircraft, currentAircraft, now = Date.now()) {
  const previousById = new Map(previousAircraft.map((plane) => [plane.id, plane]));
  const currentIds = new Set(currentAircraft.map((plane) => plane.id));

  let enteredCount = 0;
  let leftCount = 0;

  const updatedAircraft = currentAircraft.map((plane) => {
    const previous = previousById.get(plane.id);
    const lastSeenAt = Number.isFinite(plane.lastContact)
      ? plane.lastContact * 1000
      : previous?.lastSeenAt ?? now;
    const observations = previous?.observations ?? [];
    const observationTime = plane.lastPositionUpdate;
    const lastObservation = observations.at(-1);
    const hasNewObservation = Number.isFinite(observationTime)
      && lastObservation?.timestamp !== observationTime;

    // Keep only distinct, timestamped positions to bound local history size.
    const nextObservations = hasNewObservation
      ? [...observations, {
        latitude: plane.latitude,
        longitude: plane.longitude,
        timestamp: observationTime,
      }].slice(-12)
      : observations;

    if (!previous || previous.leftRegion) enteredCount += 1;

    return {
      ...previous,
      ...plane,
      callsign: plane.callsign || previous?.callsign || plane.icao24.toUpperCase(),
      altitude: plane.altitude ?? previous?.altitude ?? null,
      velocity: plane.velocity ?? previous?.velocity ?? null,
      heading: plane.heading ?? previous?.heading ?? null,
      onGround: plane.onGround ?? previous?.onGround ?? null,
      lastPositionUpdate: plane.lastPositionUpdate ?? previous?.lastPositionUpdate ?? null,
      lastContact: plane.lastContact ?? previous?.lastContact ?? null,
      observations: nextObservations,
      lastSeenAt,
      isStale: isAircraftStale({ lastSeenAt }, now),
      leftRegion: false,
      enteredRegion: !previous || previous.leftRegion,
    };
  });

  const recentlyLeft = previousAircraft
    .filter((plane) => !currentIds.has(plane.id) && now - plane.lastSeenAt < LEFT_REGION_RETENTION_MS)
    .map((plane) => {
      if (!plane.leftRegion) leftCount += 1;
      return { ...plane, isStale: true, leftRegion: true, enteredRegion: false };
    });

  return {
    aircraft: [...updatedAircraft, ...recentlyLeft],
    enteredCount,
    leftCount,
  };
}
