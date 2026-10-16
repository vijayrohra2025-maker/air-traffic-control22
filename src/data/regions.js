export const regions = {
  europe: {
    name: 'Western Europe',
    bounds: { lamin: 45, lomin: -5, lamax: 58, lomax: 15 },
    center: [51.4, 5],
    zoom: 5,
  },
};

export function getPollingIntervalMinutes(bounds) {
  const latitudeRange = Math.abs(bounds.lamax - bounds.lamin);
  const longitudeRange = Math.abs(bounds.lomax - bounds.lomin);
  const area = latitudeRange * longitudeRange;

  let requestCredits = 4;
  if (area <= 25) requestCredits = 1;
  else if (area <= 100) requestCredits = 2;
  else if (area <= 400) requestCredits = 3;

  return requestCredits * 5;
}
