import { useEffect, useRef, useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { combineAircraftUpdates, convertStateVector, getRetryDelayMs, isAircraftStale } from './data/aircraft.js';
import { readAircraftCache, saveAircraftCache } from './data/cache.js';
import { getPollingIntervalMinutes, regions } from './data/regions.js';

const OPEN_SKY_URL = '/opensky-api/states/all';
const TABLE_PAGE_SIZE = 15;

function formatNumber(value, digits = 0) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatPosition(latitude, longitude) {
  if (latitude === null || longitude === null) return 'Position unavailable';
  const latDirection = latitude >= 0 ? 'N' : 'S';
  const lonDirection = longitude >= 0 ? 'E' : 'W';
  return `${Math.abs(latitude).toFixed(2)}°${latDirection}, ${Math.abs(longitude).toFixed(2)}°${lonDirection}`;
}

function formatLastReported(timestamp) {
  if (!timestamp) return 'Unknown';
  const secondsAgo = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (secondsAgo < 60) return `${secondsAgo} sec ago`;
  return `${Math.floor(secondsAgo / 60)} min ago`;
}

function Icon({ children }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

function StatCard({ label, value, note, icon, accent }) {
  return (
    <article className="stat-card">
      <div className={`stat-icon ${accent}`}><Icon>{icon}</Icon></div>
      <div className="stat-copy"><span>{label}</span><strong>{value}</strong><small>{note}</small></div>
    </article>
  );
}

function MapSizeInvalidator() {
  const map = useMap();

  useEffect(() => {
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(map.getContainer());
    return () => resizeObserver.disconnect();
  }, [map]);

  return null;
}

function App() {
  const regionKey = 'europe';
  const [activeView, setActiveView] = useState('overview');
  const [savedSnapshot] = useState(readAircraftCache);
  const cachedSnapshot = savedSnapshot?.regionKey === regionKey ? savedSnapshot : null;
  const [aircraft, setAircraft] = useState(cachedSnapshot?.aircraft ?? []);
  const [selectedId, setSelectedId] = useState('');
  const [isLoading, setIsLoading] = useState(!cachedSnapshot);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(cachedSnapshot?.updatedAt ? new Date(cachedSnapshot.updatedAt) : null);
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [searchText, setSearchText] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [flightFilter, setFlightFilter] = useState('all');
  const [altitudeFilter, setAltitudeFilter] = useState('all');
  const [altitudeAlertThreshold, setAltitudeAlertThreshold] = useState(35_000);
  const [regionChanges, setRegionChanges] = useState({ entered: 0, left: 0 });
  const [updateHistory, setUpdateHistory] = useState([]);
  const aircraftRef = useRef(cachedSnapshot?.aircraft ?? []);
  const loadedRegionRef = useRef(cachedSnapshot ? regionKey : '');
  const detailsPanelRef = useRef(null);

  function navigateTo(view) {
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  const region = regions[regionKey];
  const pollingIntervalMinutes = getPollingIntervalMinutes(region.bounds);

  useEffect(() => {
    const clockId = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => window.clearInterval(clockId);
  }, []);

  useEffect(() => {
    let requestInProgress = false;
    let stopped = false;
    let activeController;
    let timerId;
    let timeoutId;
    let consecutiveFailures = 0;

    async function loadAircraft() {
      if (requestInProgress) return;
      requestInProgress = true;
      activeController = new AbortController();
      let requestTimedOut = false;

      if (loadedRegionRef.current === regionKey) setIsRefreshing(true);
      else setIsLoading(true);
      setError('');
      timeoutId = window.setTimeout(() => {
        requestTimedOut = true;
        activeController.abort();
      }, 15_000);

      const query = new URLSearchParams(region.bounds);
      try {
        // The Vite proxy keeps this API request on the same origin as the dashboard.
        const response = await fetch(`${OPEN_SKY_URL}?${query.toString()}`, {
          cache: 'no-store',
          signal: activeController.signal,
        });
        if (!response.ok) {
          if (response.status === 429) {
            throw new Error('OpenSky rate limit reached. Please wait before trying again.');
          }
          throw new Error(`OpenSky returned an error (${response.status}). Please try again later.`);
        }

        const data = await response.json();
        const currentAircraft = (data.states ?? []).map(convertStateVector).filter(Boolean);
        if (stopped) return;

        const sameRegion = loadedRegionRef.current === regionKey;
        const previousAircraft = sameRegion ? aircraftRef.current : [];
        const update = combineAircraftUpdates(previousAircraft, currentAircraft);
        aircraftRef.current = update.aircraft;
        loadedRegionRef.current = regionKey;
        setAircraft(update.aircraft);
        setRegionChanges(sameRegion
          ? { entered: update.enteredCount, left: update.leftCount }
          : { entered: 0, left: 0 });
        setSelectedId((previousId) => update.aircraft.some((plane) => plane.id === previousId)
          ? previousId
          : currentAircraft[0]?.id ?? '');
        const responseTime = data.time ? new Date(data.time * 1000) : new Date();
        setLastUpdated(responseTime);
        saveAircraftCache({
          regionKey,
          updatedAt: responseTime.toISOString(),
          aircraft: update.aircraft,
        });
        consecutiveFailures = 0;
        setUpdateHistory((history) => [{
          id: `${Date.now()}-${Math.random()}`,
          at: new Date(),
          type: 'success',
          message: `${currentAircraft.length.toLocaleString()} aircraft received`,
          entered: sameRegion ? update.enteredCount : 0,
          left: sameRegion ? update.leftCount : 0,
        }, ...history].slice(0, 6));
      } catch (requestError) {
        if (stopped || (requestError.name === 'AbortError' && !requestTimedOut)) return;
        consecutiveFailures += 1;
        const message = requestTimedOut
          ? 'OpenSky request timed out after 15 seconds.'
          : requestError instanceof TypeError
          ? 'Could not reach OpenSky through the local proxy. Check your internet connection and try again.'
          : requestError.message;
        const errorMessage = message || 'Unable to reach OpenSky. Check your connection and try again.';
        setError(errorMessage);
        setUpdateHistory((history) => [{
          id: `${Date.now()}-${Math.random()}`,
          at: new Date(),
          type: 'error',
          message: errorMessage,
        }, ...history].slice(0, 6));
      } finally {
        window.clearTimeout(timeoutId);
        requestInProgress = false;
        if (!stopped) {
          setIsLoading(false);
          setIsRefreshing(false);
          const nextDelay = consecutiveFailures
            ? getRetryDelayMs(consecutiveFailures)
            : pollingIntervalMinutes * 60 * 1000;
          timerId = window.setTimeout(loadAircraft, nextDelay);
        }
      }
    }

    loadAircraft();

    return () => {
      stopped = true;
      window.clearTimeout(timerId);
      window.clearTimeout(timeoutId);
      activeController?.abort();
    };
  }, [regionKey, refreshRequest, pollingIntervalMinutes]);

  function clearFilters() {
    setSearchText('');
    setFlightFilter('all');
    setAltitudeFilter('all');
    setCurrentPage(1);
  }

  const currentAircraft = aircraft.filter((plane) => !plane.leftRegion);
  const altitudeValues = currentAircraft.map((plane) => plane.altitude).filter(Number.isFinite);
  const speedValues = currentAircraft.map((plane) => plane.velocity).filter(Number.isFinite);
  const averageAltitude = altitudeValues.length
    ? altitudeValues.reduce((total, value) => total + value, 0) / altitudeValues.length
    : null;
  const averageSpeed = speedValues.length
    ? speedValues.reduce((total, value) => total + value, 0) / speedValues.length
    : null;

  const matchingAircraft = aircraft.filter((plane) => {
    const search = searchText.trim().toLowerCase();
    const matchesSearch = !search
      || plane.callsign.toLowerCase().includes(search)
      || plane.icao24.toLowerCase().includes(search);
    const matchesStatus = flightFilter === 'all'
      || (flightFilter === 'airborne' && !plane.leftRegion && plane.onGround === false)
      || (flightFilter === 'ground' && !plane.leftRegion && plane.onGround === true)
      || (flightFilter === 'stale' && isAircraftStale(plane, currentTime) && !plane.leftRegion)
      || (flightFilter === 'left' && plane.leftRegion);
    const matchesAltitude = altitudeFilter === 'all'
      || (plane.altitude !== null && plane.altitude >= Number(altitudeFilter));

    return matchesSearch && matchesStatus && matchesAltitude;
  });

  const mapAircraft = matchingAircraft.filter((plane) => !plane.leftRegion);
  const pageCount = Math.max(1, Math.ceil(matchingAircraft.length / TABLE_PAGE_SIZE));
  const visiblePage = Math.min(currentPage, pageCount);
  const firstVisibleRow = matchingAircraft.length ? (visiblePage - 1) * TABLE_PAGE_SIZE + 1 : 0;
  const lastVisibleRow = Math.min(visiblePage * TABLE_PAGE_SIZE, matchingAircraft.length);
  const pageAircraft = matchingAircraft.slice(firstVisibleRow - 1, lastVisibleRow);
  const altitudeAlerts = currentAircraft.filter((plane) => !isAircraftStale(plane, currentTime)
    && plane.onGround === false
    && Number.isFinite(plane.altitude)
    && plane.altitude >= altitudeAlertThreshold);
  const selectedAircraft = matchingAircraft.find((plane) => plane.id === selectedId)
    ?? matchingAircraft[0]
    ?? null;
  const timeLabel = lastUpdated
    ? `${lastUpdated.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase()} · ${lastUpdated.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' })} UTC`
    : 'WAITING FOR AIRCRAFT DATA';
  const selectedTrack = selectedAircraft?.observations?.map((point) => [point.latitude, point.longitude]) ?? [];

  function getAircraftStatus(plane) {
    if (plane.leftRegion) return 'Left region';
    if (isAircraftStale(plane, currentTime)) return 'Stale';
    if (plane.onGround === true) return 'On ground';
    if (plane.onGround === false) return 'Airborne';
    return 'Unknown';
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button type="button" className="brand" onClick={() => navigateTo('overview')} aria-label="Airspace dashboard home">
          <span className="brand-mark">✦</span><span>AIRSPACE<small>FLIGHT INTELLIGENCE</small></span>
        </button>
        <div className="side-label">WORKSPACE</div>
        <nav className="nav-list" aria-label="Main navigation">
          <button type="button" className={`nav-item ${activeView === 'overview' ? 'active' : ''}`} onClick={() => navigateTo('overview')} aria-current={activeView === 'overview' ? 'page' : undefined}><Icon>▦</Icon>Overview</button>
          <button type="button" className={`nav-item ${activeView === 'map' ? 'active' : ''}`} onClick={() => navigateTo('map')} aria-current={activeView === 'map' ? 'page' : undefined}><Icon>◎</Icon>Live map<span className="nav-count">{currentAircraft.length}</span></button>
          <button type="button" className={`nav-item ${activeView === 'aircraft' ? 'active' : ''}`} onClick={() => navigateTo('aircraft')} aria-current={activeView === 'aircraft' ? 'page' : undefined}><Icon>✈</Icon>Aircraft</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="region-card">
            <div className="region-top"><span className="region-dot"/>MONITORING REGION</div>
            <strong>{region.name}</strong>
            <span>Aircraft within selected bounds</span>
          </div>
          <div className="profile"><div className="avatar">VR</div><div><strong>Vijay Rohra</strong><small>Airspace analyst</small></div></div>
        </div>
      </aside>

      <section className="main-area" id="dashboard">
        <div className="content">
          {error && aircraft.length > 0 && <div className="offline-banner" role="status">
            Live refresh failed. Showing saved aircraft data from {lastUpdated?.toLocaleString() ?? 'the last successful update'}.
          </div>}
          <div className="page-heading">
            <div>
              <div className="eyebrow">{activeView === 'overview' ? timeLabel : `WORKSPACE / ${activeView === 'map' ? 'LIVE MAP' : 'AIRCRAFT'}`}</div>
              <h1>{activeView === 'overview' ? 'Airspace overview' : activeView === 'map' ? 'Live air traffic' : 'Aircraft'}</h1>
              <p>{activeView === 'aircraft' ? `Current and recently departed aircraft reported across ${region.name}.` : `Aircraft currently reported across ${region.name}.`}</p>
            </div>
            <div className="heading-actions">
              <span className="fixed-region">REGION · {region.name}</span>
              <button className="date-button" onClick={() => setRefreshRequest((count) => count + 1)} disabled={isLoading || isRefreshing}>
                ↻ <span>{isRefreshing ? 'Updating…' : 'Refresh now'}</span>
              </button>
            </div>
          </div>

          {activeView === 'overview' && <>
          <section className="stats-grid" aria-label="Aircraft statistics">
            <StatCard label="Aircraft in region" value={isLoading ? '…' : formatNumber(currentAircraft.length)} note="Current OpenSky response" icon="✈" accent="blue"/>
            <StatCard label="Aircraft on ground" value={isLoading ? '…' : formatNumber(currentAircraft.filter((plane) => plane.onGround === true).length)} note="In selected region" icon="◎" accent="green"/>
            <StatCard label="Avg. altitude" value={isLoading ? '…' : averageAltitude === null ? '—' : `${formatNumber(averageAltitude)} ft`} note="Aircraft with altitude reports" icon="↟" accent="purple"/>
            <StatCard label="Avg. ground speed" value={isLoading ? '…' : averageSpeed === null ? '—' : `${formatNumber(averageSpeed)} kts`} note="Aircraft with speed reports" icon="⌁" accent="orange"/>
          </section>

          <section className="panel altitude-alerts" aria-label="Altitude alert">
            <div className="alert-copy"><strong>Altitude alert</strong><span>{altitudeAlerts.length
              ? `${altitudeAlerts.length} fresh airborne aircraft at or above ${formatNumber(altitudeAlertThreshold)} ft`
              : `No fresh airborne aircraft at or above ${formatNumber(altitudeAlertThreshold)} ft`}</span></div>
            <label htmlFor="altitude-alert-threshold">Alert threshold (ft)</label>
            <input id="altitude-alert-threshold" type="number" min="0" max="60000" step="1000"
              value={altitudeAlertThreshold} onChange={(event) => setAltitudeAlertThreshold(Math.min(60000, Math.max(0, Number(event.target.value))))} />
            {altitudeAlerts.slice(0, 3).map((plane) => <button type="button" className="alert-select" key={plane.id}
              aria-label={`Show details for ${plane.callsign}, ${formatNumber(plane.altitude)} feet`}
              title="View aircraft details"
              onClick={() => {
                clearFilters();
                setSelectedId(plane.id);
                detailsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}>
              {plane.callsign} · {formatNumber(plane.altitude)} ft
            </button>)}
          </section>
          </>}

          {activeView !== 'aircraft' && <section className={`map-card ${activeView === 'map' ? 'map-view' : ''}`} id="map">
            <div className="section-heading">
              <div><h2>Live air traffic</h2><p>OpenSky-received positions across {region.name}</p></div>
            </div>
            <div className="map-wrap">
              <MapContainer key={regionKey} center={region.center} zoom={region.zoom} scrollWheelZoom preferCanvas className="traffic-map">
                <MapSizeInvalidator />
                <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
                {selectedTrack.length > 1 && <Polyline positions={selectedTrack} pathOptions={{ color: '#69aaff', weight: 3, opacity: 0.8, dashArray: '5 7' }} />}
                {mapAircraft.map((plane) => <CircleMarker
                  key={plane.id}
                  center={[plane.latitude, plane.longitude]}
                  radius={plane.id === selectedAircraft?.id ? 8 : 6}
                  pathOptions={{
                    color: plane.id === selectedAircraft?.id ? '#fff' : isAircraftStale(plane, currentTime) ? '#ffc16b' : '#a5d5ff',
                    weight: 2,
                    fillColor: plane.id === selectedAircraft?.id ? '#277dff' : isAircraftStale(plane, currentTime) ? '#a47a39' : '#438fe3',
                    fillOpacity: 0.95,
                  }}
                  eventHandlers={{ click: () => setSelectedId(plane.id) }}
                ><Tooltip>{plane.callsign} · {getAircraftStatus(plane)} · last report {formatLastReported(plane.lastContact)}</Tooltip></CircleMarker>)}
              </MapContainer>
              <div className="map-legend"><span><i className="legend-dot"/>Recent report</span><span><i className="legend-stale"/>Stale report (&gt;2 min)</span><span><i className="legend-ring"/>Selected</span></div>
              <div className="map-scale">100 km</div>
              {isLoading && <div className="map-message">Loading aircraft from OpenSky…</div>}
              {!isLoading && !error && mapAircraft.length === 0 && <div className="map-message empty-message">
                <strong>{currentAircraft.length === 0 ? 'No aircraft positions returned for this region.' : 'Filters are hiding the aircraft.'}</strong>
                {currentAircraft.length > 0 && <button onClick={clearFilters}>Clear filters</button>}
              </div>}
              {error && <div className="map-message error-message"><strong>Could not load live aircraft</strong><span>{error}</span><button onClick={() => setRefreshRequest((count) => count + 1)} disabled={isRefreshing}>Try again</button></div>}
            </div>
            <div className="map-footer">
              <span><i/>Showing <b>{formatNumber(mapAircraft.length)}</b> filtered aircraft of <b>{formatNumber(currentAircraft.length)}</b> in region</span>
              <span>{regionChanges.entered} entered · {regionChanges.left} left · Updated: {lastUpdated ? lastUpdated.toLocaleTimeString('en-GB', { timeZone: 'UTC' }) + ' UTC' : '—'}</span>
            </div>
          </section>}

          {activeView !== 'map' && <>
          <section className="bottom-grid">
            <div className="panel aircraft-panel" id="fleet">
              <div className="section-heading compact">
                <div><h2>Aircraft in region</h2><p>Current and recently departed OpenSky reports</p></div>
                <button className="text-button" onClick={() => setRefreshRequest((count) => count + 1)} disabled={isLoading || isRefreshing}>Refresh <b>↻</b></button>
              </div>
              <div className="table-filters">
                <input type="search" value={searchText} onChange={(event) => { setSearchText(event.target.value); setCurrentPage(1); }} placeholder="Search callsign or ICAO24" aria-label="Search aircraft"/>
                <select value={flightFilter} onChange={(event) => { setFlightFilter(event.target.value); setCurrentPage(1); }} aria-label="Filter by flight status">
                  <option value="all">All statuses</option>
                  <option value="airborne">Airborne</option>
                  <option value="ground">On ground</option>
                  <option value="stale">Stale reports</option>
                  <option value="left">Left region</option>
                </select>
                <select value={altitudeFilter} onChange={(event) => { setAltitudeFilter(event.target.value); setCurrentPage(1); }} aria-label="Filter by minimum altitude">
                  <option value="all">Any altitude</option>
                  <option value="10000">10,000+ ft</option>
                  <option value="30000">30,000+ ft</option>
                </select>
              </div>
              <div className="table-summary">
                <span>Showing {formatNumber(firstVisibleRow)}–{formatNumber(lastVisibleRow)} of {formatNumber(matchingAircraft.length)} matching aircraft</span>
                <span>Auto refresh about every {pollingIntervalMinutes} minutes</span>
              </div>
              {error && aircraft.length === 0 ? <div className="table-message">Aircraft list unavailable. Check the API status above and try again.</div>
                : isLoading ? <div className="table-message">Loading aircraft…</div>
                  : matchingAircraft.length === 0 ? <div className="table-message">{aircraft.length === 0 ? 'No aircraft positions were returned for this region.' : <>No aircraft match these filters. <button className="clear-filter-button" onClick={clearFilters}>Clear filters</button></>}</div>
                    : <div className="table-wrap"><table><thead><tr><th>CALLSIGN / ICAO24</th><th>ALTITUDE</th><th>SPEED</th><th>HEADING</th><th>STATUS</th></tr></thead><tbody>
                      {pageAircraft.map((plane) => <tr key={plane.id} className={selectedAircraft?.id === plane.id ? 'selected-row' : ''} onClick={() => setSelectedId(plane.id)}>
                        <td><span className="plane-badge">✈</span><b>{plane.callsign}</b></td>
                        <td>{formatNumber(plane.altitude)} ft</td>
                        <td>{formatNumber(plane.velocity)} kts</td>
                        <td>{formatNumber(plane.heading)}°</td>
                        <td><span className={`flight-status ${plane.leftRegion ? 'departed' : isAircraftStale(plane, currentTime) ? 'stale' : ''}`}><i/>{getAircraftStatus(plane)}</span></td>
                      </tr>)}
                    </tbody></table></div>}
              {matchingAircraft.length > TABLE_PAGE_SIZE && <div className="pagination-controls" aria-label="Aircraft table pages">
                <span>Page {visiblePage} of {pageCount}</span>
                <div>
                  <button onClick={() => setCurrentPage(Math.max(1, visiblePage - 1))} disabled={visiblePage === 1}>Previous</button>
                  <button onClick={() => setCurrentPage(Math.min(pageCount, visiblePage + 1))} disabled={visiblePage === pageCount}>Next</button>
                </div>
              </div>}
            </div>

            <div className="panel detail-panel" ref={detailsPanelRef}>
              <div className="section-heading compact"><div><h2>Aircraft details</h2><p>Selected aircraft information</p></div></div>
              {selectedAircraft ? <>
                <div className="detail-identity">
                  <div className="large-plane">✈</div>
                  <div><strong>{selectedAircraft.callsign}</strong><span>ICAO24: {selectedAircraft.icao24}</span></div>
                  <span className={`flight-status detail-status ${selectedAircraft.leftRegion ? 'departed' : isAircraftStale(selectedAircraft, currentTime) ? 'stale' : ''}`}><i/>{getAircraftStatus(selectedAircraft)}</span>
                </div>
                <div className="detail-metrics">
                  <div><span>ALTITUDE</span><strong>{formatNumber(selectedAircraft.altitude)} <small>ft</small></strong></div>
                  <div><span>GROUND SPEED</span><strong>{formatNumber(selectedAircraft.velocity)} <small>kts</small></strong></div>
                  <div><span>HEADING</span><strong>{formatNumber(selectedAircraft.heading)}° <small>→</small></strong></div>
                  <div><span>LAST POSITION</span><strong>{formatPosition(selectedAircraft.latitude, selectedAircraft.longitude)}</strong></div>
                </div>
                <div className="last-seen"><span><i/>Last reported</span><b>{formatLastReported(selectedAircraft.lastContact)}</b></div>
                <div className="movement-history">
                  <strong>Recent movement · {selectedTrack.length} positions</strong>
                  {selectedTrack.length > 1
                    ? <ol>{selectedAircraft.observations.slice(-5).reverse().map((point) => <li key={point.timestamp}>
                      <span>{formatPosition(point.latitude, point.longitude)}</span>
                      <time>{new Date(point.timestamp * 1000).toLocaleTimeString('en-GB', { timeZone: 'UTC' })} UTC</time>
                    </li>)}</ol>
                    : <span>More distinct position reports are needed to draw a path.</span>}
                </div>
              </> : <div className="table-message">{isLoading ? 'Aircraft details will appear when data loads.' : 'No aircraft match the current filters.'}</div>}
            </div>
          </section>
          </>}
          {activeView !== 'map' && <>
          <section className="panel update-history" aria-label="Recent data updates">
            <div className="section-heading compact">
              <div><h2>Recent data updates</h2><p>Request history for {region.name} · this session only</p></div>
              <span className="history-count">{updateHistory.length} of 6</span>
            </div>
            {updateHistory.length === 0
              ? <div className="history-empty">Update results will appear here after the first request.</div>
              : <ol className="history-list">{updateHistory.map((entry) => <li key={entry.id}>
                <i className={entry.type === 'error' ? 'history-error' : ''}/>
                <time>{entry.at.toLocaleTimeString('en-GB')}</time>
                <span className="history-message">{entry.message}</span>
                {entry.type === 'success' && <small>{entry.entered} entered · {entry.left} left</small>}
              </li>)}</ol>}
          </section>
          </>}
          <footer className="page-footer"><span>© 2026 Airspace Intelligence</span><span>Live position data: OpenSky Network</span></footer>
        </div>
      </section>
    </main>
  );
}

export default App;
