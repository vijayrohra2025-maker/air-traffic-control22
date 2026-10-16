# Airspace Flight Intelligence

Airspace is a web dashboard that displays aircraft position reports for **Western Europe**. It combines live state data from the OpenSky Network with an interactive map from OpenStreetMap. It is a learning project—not an air traffic control system—and it does not create fake aircraft when live data is unavailable.

## What you can do

- View aircraft positions on a Leaflet map and select an aircraft to see its reported details.
- Search and filter the aircraft list by callsign, status, or minimum altitude.
- See aircraft that are airborne, on the ground, stale, or recently outside the monitored area.
- Set an altitude alert threshold and select aircraft meeting that threshold.
- Review recent data requests and see when the last successful update occurred.

The monitored area is fixed to Western Europe in `src/data/regions.js`. The dashboard normally polls about every 15 minutes; you can also request a manual refresh.

## Advantages

- Combines a map, aircraft list, and selected-aircraft details in one dashboard.
- Makes it easier to inspect reports with search, status and altitude filters, pagination, and configurable altitude alerts.
- Keeps the last successful snapshot visible during temporary API failures and explains when fresh data cannot be loaded.
- Uses no account or API key for the current anonymous OpenSky integration.

## Run it on your computer

You need **Node.js 18 or newer**, npm, and an internet connection for OpenSky data and map tiles.

1. Open a terminal in the project folder.
2. Install the dependencies:

   ```sh
   npm install
   ```

3. Start the development server:

   ```sh
   npm run dev
   ```

4. Open the local address printed in the terminal, usually `http://localhost:5173`.

To stop the server, press `Ctrl+C` in the terminal.

## How the data gets to the screen

1. The browser asks `/opensky-api/states/all` for aircraft reports inside the Western Europe bounding box.
2. During development, `vite.config.js` forwards that request to OpenSky. On Vercel, `vercel.json` provides the equivalent rewrite.
3. `src/data/aircraft.js` converts OpenSky's positional arrays into named aircraft fields and converts altitude and speed into feet and knots.
4. `src/App.jsx` keeps the aircraft snapshot and interface state, including selected aircraft, filters, alerts, loading status, and errors.
5. React renders the resulting data in the map, statistics, and aircraft table. The Leaflet map uses OpenStreetMap tiles for its background.

There is **no separate application server or database**. The Vite development server and Vercel rewrite act as proxies for API requests. The browser stores a small versioned snapshot in `localStorage`, so it can show the last successful data while it tries to refresh. That saved data is local to the browser and is not a shared history service.

## Data freshness, errors, and request limits

- A report with no contact for more than two minutes is marked **stale**. A small clock updates its visible age between API polls.
- Requests time out after 15 seconds. Failed requests are retried with increasing delays, up to five minutes. The dashboard keeps the last successful results and displays an error instead of treating a failed request as an empty region.
- Polling is intentionally limited to about once every 15 minutes to reduce API usage. OpenSky quotas and bounding-box costs can change, so check the [OpenSky REST API documentation](https://openskynetwork.github.io/opensky-api/rest.html) before changing the interval.
- Each aircraft keeps up to 12 distinct reported positions in local storage. A dashed track is shown only when there are at least two positions. This is not a complete flight-history archive, and the app does not predict future positions.
- OpenSky coverage is incomplete and varies by location. A blank part of the map does **not** prove no aircraft are there. Callsigns or other fields may also be missing. See the [OpenSky FAQ](https://opensky-network.org/about/faq) for coverage information.

## Limitations

- The dashboard only monitors the configured Western Europe region; it does not show global traffic or guarantee that every aircraft in that region will appear.
- The data is limited by OpenSky's sensor coverage, request quotas, and service availability. A 15-minute polling interval is suitable for this dashboard, but it is not continuous radar tracking.
- Aircraft missing from a later response are retained in the table as recently departed for up to one hour. Cached reports and saved movement history exist only in the current browser.
- The app does not provide a complete flight-history archive, predict future positions, or support real operational air traffic control.

## Main project files

- `src/main.jsx` loads Leaflet and the dashboard stylesheet, then starts the React app.
- `src/App.jsx` renders the dashboard and manages its interface and request state.
- `src/data/regions.js` defines the monitored bounds and polling interval.
- `src/data/aircraft.js` converts, merges, and tracks aircraft reports.
- `src/data/cache.js` saves and reads the browser's last successful snapshot.
- `src/data/*.test.js` contains automated tests for aircraft conversion, merging, retry behavior, and caching.
- `src/dashboard.css` contains all app-specific styles and responsive layout rules.
- `vite.config.js` configures the local OpenSky development proxy; `vercel.json` configures the production proxy and page fallback on Vercel.

## Check and build the project

Run the automated tests:

```sh
npm test
```

Create and locally preview the production build:

```sh
npm run build
npm run preview
```

Vite writes the production files to `dist/`. Unit tests check the app's data-handling logic, but they do not guarantee that OpenSky is reachable at a particular time.

## Deploy on Vercel

1. Push this project to a GitHub repository.
2. In Vercel, choose **Add New → Project** and import that repository.
3. Use `npm run build` for the build command and `dist` for the output directory if Vercel does not detect them automatically.
4. Deploy. `vercel.json` forwards the app's `/opensky-api/*` calls to OpenSky and sends app-page requests to `index.html`.

For another static host, configure an equivalent external API proxy and single-page-app fallback. The development proxy in `vite.config.js` is not included in the built files.

The current anonymous OpenSky integration uses no API key, so there are no credentials to configure. Review OpenSky's current terms and quotas before publishing a public deployment. This dashboard is for learning and demonstration only; do not use it for operational or safety-critical decisions.
