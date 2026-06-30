import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import L, { type GeoJSON as LeafletGeoJSON, type LatLngBounds } from "leaflet";
import "leaflet/dist/leaflet.css";
import { createIcons, Search } from "lucide";
import currentsLogoUrl from "../graphics/Currents_logo.png";
import splashLogoUrl from "../graphics/Splash_logo.png";
import leftLogoUrl from "../graphics/img1.png";
import rightLogoUrl from "../graphics/img2.png";
import {
  type AddressRecord,
  type AddressSearchIndex,
  type RankedAddress,
  buildAddressSearchIndex,
  findExactCandidates,
  isConfidentMatch,
  searchAddresses,
} from "./address";
import "./styles.css";

type CityLimitsGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.MultiPolygon | GeoJSON.Polygon
>;
type ParksRecGeoJson = GeoJSON.FeatureCollection<
  GeoJSON.Point,
  { location: string }
>;
type BasemapKey = "topo" | "osm" | "imagery";

const app = document.querySelector<HTMLDivElement>("#app");
const leftLogo = requireElement<HTMLImageElement>("#left-logo");
const rightLogo = requireElement<HTMLImageElement>("#right-logo");
const input = requireElement<HTMLInputElement>("#address-input");
const form = requireElement<HTMLFormElement>("#search-control");
const searchButton = requireElement<HTMLButtonElement>("#search-button");
const suggestionsList = requireElement<HTMLUListElement>("#suggestions");
const statusEl = requireElement<HTMLDivElement>("#status");
const BASEMAP_LABELS: Record<BasemapKey, string> = {
  topo: "Topo",
  osm: "OSM",
  imagery: "Imagery",
};
const INITIAL_CITY_BOUNDS_PAD = 0.12;
const INSIDE_RESULT_BOUNDS_PAD = 0.035;
const OUTSIDE_RESULT_BOUNDS_PAD = 0.08;
const MAP_TOP_PADDING: L.PointExpression = [40, 128];
const MAP_BOTTOM_PADDING: L.PointExpression = [40, 72];

leftLogo.src = leftLogoUrl;
rightLogo.src = rightLogoUrl;

const map = L.map("map", {
  zoomControl: false,
  minZoom: 8,
  maxZoom: 18,
  // Result zoom: fractional zoom allows subtle fitBounds changes instead of big jumps.
  zoomDelta: 0.5,
  zoomSnap: 0.25,
  maxBoundsViscosity: 0.85,
}).setView([46.8721, -113.994], 12);

// Basemap switcher: start on OSM and let users toggle Esri Topo/Imagery.
let activeBasemapKey: BasemapKey = "osm";
let activeBasemapLayer = createBasemapLayer(activeBasemapKey).addTo(map);
const basemapControl = createBasemapControl();
basemapControl.addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

createIcons({ icons: { Search } });

let cityLayer: LeafletGeoJSON | null = null;
let cityBounds: LatLngBounds | null = null;
let cityLimits: CityLimitsGeoJson | null = null;
let addressIndex: AddressSearchIndex | null = null;
let parksRecLayer: L.LayerGroup | null = null;
let parksRecLocations: ParksRecGeoJson | null = null;
let resultMarker: L.Marker | null = null;
let currentSuggestions: RankedAddress[] = [];
let highlightedSuggestion = -1;
let inputDebounce: number | undefined;

setBusy(true);
setStatus("Loading data...");

initialize().catch((error: unknown) => {
  console.error(error);
  setBusy(false);
  setStatus("Could not load map data.");
  app?.classList.add("is-error");
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  clearPendingSuggestions();

  if (!addressIndex) {
    return;
  }

  if (highlightedSuggestion >= 0 && currentSuggestions[highlightedSuggestion]) {
    selectAddress(currentSuggestions[highlightedSuggestion].record);
    return;
  }

  submitSearch(input.value);
});

input.addEventListener("input", () => {
  window.clearTimeout(inputDebounce);
  inputDebounce = window.setTimeout(() => {
    updateSuggestions(input.value);
  }, 80);
});

input.addEventListener("keydown", (event) => {
  if (suggestionsList.hidden || currentSuggestions.length === 0) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    highlightedSuggestion = Math.min(
      highlightedSuggestion + 1,
      currentSuggestions.length - 1,
    );
    renderSuggestions(currentSuggestions);
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    highlightedSuggestion = Math.max(highlightedSuggestion - 1, 0);
    renderSuggestions(currentSuggestions);
  }

  if (event.key === "Escape") {
    hideSuggestions();
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!form.contains(event.target as Node)) {
    hideSuggestions();
  }
});

// App initialization: load prepared GeoJSON/JSON, draw map layers, lock map bounds, then build search.
async function initialize(): Promise<void> {
  const [loadedCityLimits, addresses, loadedParksRecLocations] =
    await Promise.all([
      fetchJson<CityLimitsGeoJson>("data/city-limits.geojson"),
      fetchJson<AddressRecord[]>("data/addresses.json"),
      fetchJson<ParksRecGeoJson>("data/parks-rec-locations.geojson"),
    ]);

  cityLimits = loadedCityLimits;
  parksRecLocations = loadedParksRecLocations;
  cityLayer = L.geoJSON(cityLimits, {
    style: {
      color: "#125f63",
      weight: 2,
      opacity: 0.9,
      fillColor: "#1b9aaa",
      fillOpacity: 0.12,
    },
  }).addTo(map);
  cityBounds = cityLayer.getBounds();
  parksRecLayer = addParksRecMarkers(parksRecLocations);

  // Map extent lock: include all address data but keep users anchored near Missoula County.
  const maxBounds = buildDataBounds(addresses, cityBounds).pad(0.12);
  map.setMaxBounds(maxBounds);
  map.fitBounds(cityBounds.pad(INITIAL_CITY_BOUNDS_PAD), {
    animate: false,
    paddingTopLeft: MAP_TOP_PADDING,
    paddingBottomRight: MAP_BOTTOM_PADDING,
  });

  addressIndex = buildAddressSearchIndex(addresses);

  setBusy(false);
  setStatus("Ready");
  input.disabled = false;
  searchButton.disabled = false;
  input.focus();
}

// Parks Rec location pins: permanent Currents/Splash logo markers.
function addParksRecMarkers(locations: ParksRecGeoJson): L.LayerGroup {
  const layer = L.layerGroup();

  for (const feature of locations.features) {
    const location = feature.properties?.location || "Parks & Rec location";
    const [lng, lat] = feature.geometry.coordinates;

    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      continue;
    }

    L.marker([lat, lng], {
      icon: createParksRecIcon(location),
      keyboard: true,
      title: location,
      zIndexOffset: 400,
    })
      .bindPopup(location)
      .addTo(layer);
  }

  layer.addTo(map);
  return layer;
}

// Parks Rec pin icon: choose the correct logo and place it inside a circular marker.
function createParksRecIcon(location: string): L.DivIcon {
  const logoUrl = location.toLowerCase().includes("splash")
    ? splashLogoUrl
    : currentsLogoUrl;

  return L.divIcon({
    className: "parks-rec-pin",
    html: `<span style="--pin-logo: url('${logoUrl}')"></span>`,
    iconSize: [58, 58],
    iconAnchor: [29, 29],
    popupAnchor: [0, -30],
  });
}

// Basemap layer factory: all basemaps are raster tile layers to avoid token-gated vector basemaps.
function createBasemapLayer(key: BasemapKey): L.Layer {
  if (key === "topo") {
    return L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution:
          "Tiles &copy; Esri, TomTom, Garmin, FAO, NOAA, USGS, and the GIS User Community",
      },
    );
  }

  if (key === "imagery") {
    return L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 19,
        attribution:
          "Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      },
    );
  }

  return L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

// Basemap control: custom horizontal Leaflet control below the zoom buttons.
function createBasemapControl(): L.Control {
  const control = new L.Control({ position: "bottomright" });

  control.onAdd = () => {
    const container = L.DomUtil.create(
      "div",
      "leaflet-control basemap-control",
    );

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    (["topo", "osm", "imagery"] as BasemapKey[]).forEach((key) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.basemap = key;
      button.textContent = BASEMAP_LABELS[key];
      button.setAttribute(
        "aria-label",
        `Switch to ${BASEMAP_LABELS[key]} basemap`,
      );
      button.setAttribute("aria-pressed", String(key === activeBasemapKey));
      button.classList.toggle("is-active", key === activeBasemapKey);
      button.addEventListener("click", () => setBasemap(key));
      container.append(button);
    });

    return container;
  };

  return control;
}

// Basemap switch action: replace the tile layer and bring city/search layers back above it.
function setBasemap(key: BasemapKey): void {
  if (key === activeBasemapKey) {
    return;
  }

  map.removeLayer(activeBasemapLayer);
  activeBasemapKey = key;
  activeBasemapLayer = createBasemapLayer(key).addTo(map);
  updateBasemapControlState();
  bringOperationalLayersForward();
}

// Basemap active state: update button styling and aria-pressed after toggles.
function updateBasemapControlState(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".basemap-control button")
    .forEach((button) => {
      const isActive = button.dataset.basemap === activeBasemapKey;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
}

// Layer ordering: keep city limits, Parks Rec pins, and result pin above the current basemap.
function bringOperationalLayersForward(): void {
  cityLayer?.bringToFront();

  parksRecLayer?.eachLayer((layer) => {
    if ("bringToFront" in layer && typeof layer.bringToFront === "function") {
      layer.bringToFront();
    }
  });

  resultMarker?.setZIndexOffset(800);
}

// Address search submit: exact match first, then fuzzy match, then suggestions if uncertain.
function submitSearch(rawQuery: string): void {
  clearPendingSuggestions();
  const query = rawQuery.trim();

  if (!addressIndex || !query) {
    setStatus("Ready");
    hideSuggestions();
    return;
  }

  const exactCandidates = findExactCandidates(addressIndex, query);

  if (exactCandidates.length === 1) {
    selectAddress(exactCandidates[0]);
    return;
  }

  if (exactCandidates.length > 1) {
    const matches = exactCandidates.map((record, index) => ({
      record,
      score: 100 - index,
      miniSearchScore: 0,
    }));

    showAmbiguousMatches(matches, "Multiple matches found. Choose one:");
    return;
  }

  const matches = searchAddresses(addressIndex, query, 6);

  if (isConfidentMatch(query, matches)) {
    selectAddress(matches[0].record);
    return;
  }

  if (matches.length > 0) {
    showAmbiguousMatches(matches, "Address not found. Did you mean...");
    return;
  }

  setStatus("Address not found.");
  hideSuggestions();
}

// Address autocomplete: fuzzy/prefix suggestions while the user types.
function updateSuggestions(rawQuery: string): void {
  if (!addressIndex) {
    return;
  }

  const query = rawQuery.trim();

  if (query.length < 2) {
    hideSuggestions();
    setStatus("Ready");
    return;
  }

  const matches = searchAddresses(addressIndex, query, 7);
  highlightedSuggestion = -1;

  if (matches.length === 0) {
    hideSuggestions();
    setStatus("No match found.");
    return;
  }

  setStatus("Showing suggestions");
  renderSuggestions(matches);
}

function showAmbiguousMatches(matches: RankedAddress[], message: string): void {
  highlightedSuggestion = -1;
  setStatus(message);
  renderSuggestions(matches);
}

// Search suggestions renderer: one button per ranked address candidate.
function renderSuggestions(matches: RankedAddress[]): void {
  currentSuggestions = matches;
  suggestionsList.innerHTML = "";

  matches.forEach((match, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const title = document.createElement("span");
    const meta = document.createElement("span");

    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === highlightedSuggestion));
    button.type = "button";
    button.className = "suggestion-button";
    button.addEventListener("click", () => selectAddress(match.record));
    title.className = "suggestion-title";
    title.textContent = match.record.display;
    meta.className = "suggestion-meta";
    meta.textContent = [match.record.community, match.record.zipcode]
      .filter(Boolean)
      .join(" · ");

    button.append(title, meta);
    item.append(button);
    suggestionsList.append(item);
  });

  suggestionsList.hidden = matches.length === 0;
  input.setAttribute("aria-expanded", String(matches.length > 0));
}

function hideSuggestions(): void {
  currentSuggestions = [];
  highlightedSuggestion = -1;
  suggestionsList.hidden = true;
  suggestionsList.innerHTML = "";
  input.setAttribute("aria-expanded", "false");
}

// Found address result: move the result pin, open the popup, and zoom toward the address.
function selectAddress(address: AddressRecord): void {
  clearPendingSuggestions();
  input.value = address.display;
  hideSuggestions();

  const insideCityLimits =
    address.insideCityLimits || isAddressInsideCityLimits(address);
  const resultText = insideCityLimits
    ? "Within city limits"
    : "Outside city limits";

  setStatus(resultText);
  app?.classList.toggle("result-inside", insideCityLimits);
  app?.classList.toggle("result-outside", !insideCityLimits);

  const latLng = L.latLng(address.lat, address.lng);

  if (!resultMarker) {
    resultMarker = L.marker(latLng, {
      icon: L.divIcon({
        className: "result-marker",
        html: "<span></span>",
        iconSize: [30, 30],
        iconAnchor: [15, 28],
        popupAnchor: [0, -28],
      }),
    }).addTo(map);
  } else {
    resultMarker.setLatLng(latLng);
  }

  const markerElement = resultMarker.getElement();
  markerElement?.classList.toggle("is-inside", insideCityLimits);
  markerElement?.classList.toggle("is-outside", !insideCityLimits);

  resultMarker
    .bindPopup(buildResultPopupContent(resultText, address))
    .openPopup();
  fitResult(latLng, insideCityLimits);
}

// Result popup content: bold city-limit result plus a normal-weight distance line.
function buildResultPopupContent(
  resultText: "Within city limits" | "Outside city limits",
  address: AddressRecord,
): string {
  const distanceText = buildDistanceText(address);

  return [
    `<strong>${resultText}</strong>`,
    distanceText
      ? `<span class="popup-distance-line">${distanceText}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("<br>");
}

// Distance popup line: show planar miles from the searched address to Currents and Splash.
function buildDistanceText(address: AddressRecord): string {
  const currents = findParksRecLocation("Currents");
  const splash = findParksRecLocation("Splash");

  if (!currents || !splash) {
    return "";
  }

  const currentsMiles = planarDistanceMiles(address, currents);
  const splashMiles = planarDistanceMiles(address, splash);

  return `${formatMiles(currentsMiles)} miles to Currents / ${formatMiles(splashMiles)} miles to Splash`;
}

// Parks Rec lookup: find a named set location from the loaded ParksRec GeoJSON.
function findParksRecLocation(
  name: string,
): GeoJSON.Feature<GeoJSON.Point, { location: string }> | null {
  const normalizedName = name.toLowerCase();

  return (
    parksRecLocations?.features.find((feature) =>
      feature.properties?.location?.toLowerCase().includes(normalizedName),
    ) ?? null
  );
}

// Euclidean distance: local planar approximation in miles for Missoula-area lat/lng.
function planarDistanceMiles(
  address: AddressRecord,
  destination: GeoJSON.Feature<GeoJSON.Point, { location: string }>,
): number {
  const [destinationLng, destinationLat] = destination.geometry.coordinates;
  const averageLatRadians =
    ((address.lat + destinationLat) / 2) * (Math.PI / 180);
  const milesPerDegreeLatitude = 69.0;
  const milesPerDegreeLongitude = Math.cos(averageLatRadians) * 69.172;
  const dx = (destinationLng - address.lng) * milesPerDegreeLongitude;
  const dy = (destinationLat - address.lat) * milesPerDegreeLatitude;

  return Math.hypot(dx, dy);
}

function formatMiles(miles: number): string {
  if (miles < 0.05) {
    return "<0.1";
  }

  return miles.toFixed(1);
}

// Result zoom: slight city zoom for inside matches; outside matches fit city plus result pin.
function fitResult(latLng: L.LatLng, insideCityLimits: boolean): void {
  if (!cityBounds) {
    map.setView(latLng, insideCityLimits ? 12.5 : 11);
    return;
  }

  const targetBounds = insideCityLimits
    ? L.latLngBounds(cityBounds.getSouthWest(), cityBounds.getNorthEast()).pad(
        INSIDE_RESULT_BOUNDS_PAD,
      )
    : L.latLngBounds(cityBounds.getSouthWest(), cityBounds.getNorthEast())
        .extend(latLng)
        .pad(OUTSIDE_RESULT_BOUNDS_PAD);

  map.fitBounds(targetBounds, {
    paddingTopLeft: MAP_TOP_PADDING,
    paddingBottomRight: MAP_BOTTOM_PADDING,
  });
}

// City limits check: Turf point-in-polygon test against the loaded Missoula boundary.
function isAddressInsideCityLimits(address: AddressRecord): boolean {
  if (!cityLimits) {
    return address.insideCityLimits;
  }

  const addressPoint = point([address.lng, address.lat]);
  return cityLimits.features.some((feature) =>
    booleanPointInPolygon(addressPoint, feature),
  );
}

// Data bounds: builds the max pan extent from city limits plus all county address points.
function buildDataBounds(
  addresses: AddressRecord[],
  initialBounds: LatLngBounds,
): LatLngBounds {
  const bounds = L.latLngBounds(
    initialBounds.getSouthWest(),
    initialBounds.getNorthEast(),
  );

  for (const address of addresses) {
    bounds.extend([address.lat, address.lng]);
  }

  return bounds;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`Failed to load ${path}: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function setBusy(isBusy: boolean): void {
  app?.classList.toggle("is-busy", isBusy);
  input.disabled = isBusy;
  searchButton.disabled = isBusy;
}

function clearPendingSuggestions(): void {
  window.clearTimeout(inputDebounce);
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}
