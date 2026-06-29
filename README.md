# Missoula City Limits Address Checker

## Run the App

```bash
npm install
npm run dev
```

The dev server runs at `http://127.0.0.1:5173/` by default.

Production build:

```bash
npm run build
```

`npm run prepare-data` reads the source GeoJSON files in `data/` and writes the browser-ready files in `public/data/`. The build and dev scripts run that step automatically.

The GitHub Pages workflow in `.github/workflows/deploy-pages.yml` builds `dist/` on pushes to `main` and publishes it to Pages.

## Goal

Simple web app with:

- An interactive Leaflet-style map centered on Missoula.
- A prominent search bar at the top center of the map.
- Address autocomplete and forgiving search.
- A result marker and popup that reports either `Within city limits` or `Outside city limits`.
- Map navigation locked to the Missoula area.

## Current Data

The repo currently includes:

- `data/Missoula_city_limits.geojson`
  - 1 `MultiPolygon` feature.
  - EPSG:4326.
  - Approximate bbox: `[-114.1273, 46.7915, -113.9104, 46.9500]`.
- `data/Address_Structure_Points.geojson`
  - 53,242 `Point` features.
  - EPSG:4326.
  - County-wide address coverage, not only Missoula city.
  - Useful address attributes include `fulladdress`, `addnum`, `predir`, `roadname`, `posttype`, `postdir`, `fullroadname`, `subaddtype`, `subadd`, `community`, `state`, and `zipcode`.

The county-wide address layer is useful because it allows the tool to return `Outside city limits` for addresses that are valid nearby addresses but not inside the city polygon.

-Data source for city limits: Missoula County Open Data Portal (https://missoula-county-open-data-mcgis.hub.arcgis.com/datasets/577a441aebea4dfe97a2840666f99dc2_4/explore?location=46.871350%2C-114.017257%2C12)(https://arcg.is/05G1Ki)
-Data source for address points: Missoula County Open Data Portal (https://missoula-county-open-data-mcgis.hub.arcgis.com/datasets/2cc878f55cbb492c9388026aec382e58_0/explore?location=47.202824%2C-113.927808%2C9)(https://arcg.is/1uLiXj1)

## Recommended Stack

Keep this as a static frontend app unless a future requirement forces a backend.

- Vite for the frontend build.
- TypeScript for safer address/search/map logic.
- Leaflet for the interactive map.
- Turf for point-in-polygon checks and bbox helpers.
- Fuse.js or MiniSearch for forgiving address search.
- OpenStreetMap or another public tile layer for the basemap, subject to attribution and usage limits.

This should deploy cleanly to GitHub Pages, Netlify, Cloudflare Pages, or any static host.

## Data Preparation Plan

Do not load the raw 55 MB address GeoJSON directly in the browser. Add a small preprocessing script later that creates web-ready files.

Recommended generated files:

- `public/data/city-limits.geojson`
  - Minified city limits geometry.
  - Preserve only the geometry and any properties needed for display.
- `public/data/addresses.json`
  - Compact address records with only the fields needed by the app.
  - Suggested shape:

```json
[
  {
    "id": 1,
    "fulladdress": "123 N HIGGINS AVE",
    "normalized": "123 NORTH HIGGINS AVENUE",
    "display": "123 N Higgins Ave, Missoula, MT 59802",
    "addnum": 123,
    "roadname": "HIGGINS",
    "fullroadname": "N HIGGINS AVE",
    "community": "MISSOULA",
    "zipcode": "59802",
    "lng": -113.99,
    "lat": 46.87
  }
]
```

Optional generated file:

- `public/data/search-index.json`
  - Prebuilt search index if the chosen search library supports it.
  - Useful if runtime indexing feels slow.

During preprocessing:

- Normalize all address strings to uppercase.
- Trim repeated whitespace.
- Expand or standardize common street suffixes and directionals.
- Keep the original display address for UI.
- Consider filtering out unusable records, such as empty `fulladdress` values or placeholder `0` address numbers, unless those are meaningful for the intended users.
- Precompute `insideCityLimits` if desired. Runtime Turf checks are also fine for 53k points, but precomputing makes the final search interaction simpler and faster.

## Address Normalization

Use a shared normalizer for both source addresses and user input.

Suggested normalization rules:

- Case-insensitive matching.
- Ignore punctuation such as periods and commas.
- Collapse whitespace.
- Treat common suffixes as equivalent:
  - `ST`, `STREET`
  - `AVE`, `AVENUE`
  - `RD`, `ROAD`
  - `DR`, `DRIVE`
  - `LN`, `LANE`
  - `TRL`, `TRAIL`
  - `CT`, `COURT`
  - `CIR`, `CIRCLE`
  - `HWY`, `HIGHWAY`
- Treat directionals as equivalent:
  - `N`, `NORTH`
  - `S`, `SOUTH`
  - `E`, `EAST`
  - `W`, `WEST`
- Preserve unit/subaddress tokens where available, but do not require them for a base-address match.

## Search Behavior

Search should have two phases.

### 1. Autocomplete While Typing

As the user types, suggest likely matches using:

- `fulladdress`
- `fullroadname`
- `roadname`
- `addnum`
- `community`
- `zipcode`

Prioritize suggestions that:

- Match the address number exactly.
- Match the road name strongly.
- Are in `community = MISSOULA`.
- Have a ZIP code commonly associated with Missoula.
- Have a valid point geometry.

The suggestions should display enough context to disambiguate nearby or duplicate addresses, for example:

`123 N Higgins Ave, Missoula, MT 59802`

### 2. Submit On Enter

When the user presses Enter:

1. Normalize the typed address.
2. Look for an exact normalized `fulladdress` match.
3. If no exact match exists, look for a high-confidence fuzzy match.
4. If there are multiple plausible matches, show a short suggestion list instead of silently choosing.
5. Once a single address is selected, check whether its point is within the city limits polygon.
6. Display the result marker and popup.

For fuzzy matching, avoid returning a confident result when the score is weak. In that case, show alternatives such as:

- `Address not found. Did you mean ...`
- `Multiple matches found. Choose one: ...`

## City-Limit Check

The core spatial test is:

1. Find the matched address point.
2. Run a point-in-polygon check against `Missoula_city_limits.geojson`.
3. Return:
   - `Within city limits` if the point is inside or on the city boundary.
   - `Outside city limits` otherwise.

Use Turf's boolean point-in-polygon helper for implementation. Confirm how boundary points are handled during testing and document that behavior if needed.

## Map Behavior

Initial map:

- Fit to the Missoula city limits polygon with padding.
- Draw the city limits polygon with a clear but unobtrusive outline/fill.
- Keep the basemap visible underneath.

Navigation lock:

- Set Leaflet `maxBounds` around the Missoula area.
- Use `maxBoundsViscosity`.
- Set sensible `minZoom` and `maxZoom`.
- Do not let users pan far away from Missoula or zoom out to a statewide/national view.

Search result:

- Place or move a single result marker at the matched address.
- Open a popup over that marker.
- Popup text should be exactly:
  - `Within city limits`
  - `Outside city limits`
- Fit the map so the marker is visible and the full city limits polygon remains visible.
- Because the full polygon must remain visible, the result zoom should be modest rather than a tight parcel-level zoom.

## UI Plan

Keep the first screen as the actual tool, not a landing page.

Layout:

- Full-window map.
- Top-centered search control overlay.
- Search input large enough for a full street address.
- Autocomplete dropdown directly under the input.
- Small loading state while data/indexes initialize.
- Compact error or empty-result state under the search bar.

Recommended states:

- Loading data.
- Ready for search.
- Showing suggestions.
- No match found.
- Multiple possible matches.
- Result inside city limits.
- Result outside city limits.

## Implementation Phases

1. Scaffold the app
   - Add Vite, TypeScript, Leaflet, Turf, and the chosen search library.
   - Create the full-window map shell.

2. Add data preprocessing
   - Read the source GeoJSON files.
   - Emit compact web-ready data.
   - Normalize address strings.
   - Optionally precompute `insideCityLimits`.

3. Build the map
   - Load the city limits polygon.
   - Fit initial bounds.
   - Lock map navigation to the Missoula area.
   - Style the polygon.

4. Build search indexing
   - Load compact address data.
   - Create exact-match lookup by normalized address.
   - Create fuzzy/autocomplete index.
   - Rank matches using address number, road name, community, ZIP, and fuzzy score.

5. Build search UI
   - Add the top-centered input.
   - Add suggestions.
   - Handle Enter and suggestion selection.
   - Add empty and ambiguous-result states.

6. Build result behavior
   - Add/update the marker.
   - Run or read the city-limit result.
   - Open the popup.
   - Refit the map while keeping the city polygon visible.

7. Test and polish
   - Test known inside addresses.
   - Test known outside addresses.
   - Test misspellings and suffix variants.
   - Test duplicate/ambiguous addresses.
   - Test mobile viewport behavior.
   - Test map bounds locking.

## Open Decisions

- Whether to precompute `insideCityLimits` during data preparation or compute it in the browser after a match.
- Whether placeholder address numbers such as `0 HIGHWAY 83` should appear in search suggestions.
- Which basemap provider to use.
- Whether the app should support unit/subaddress searches as exact matches or only as secondary display context.
- Whether the search should prefer only `community = MISSOULA` suggestions or continue showing all county addresses so outside-city addresses are easy to verify.
