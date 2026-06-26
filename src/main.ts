import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { vectorTileLayer } from "esri-leaflet-vector";
import L, { type GeoJSON as LeafletGeoJSON, type LatLngBounds } from "leaflet";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
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
type BasemapKey = "parks" | "osm" | "imagery";

const app = document.querySelector<HTMLDivElement>("#app");
const leftLogo = requireElement<HTMLImageElement>("#left-logo");
const rightLogo = requireElement<HTMLImageElement>("#right-logo");
const input = requireElement<HTMLInputElement>("#address-input");
const form = requireElement<HTMLFormElement>("#search-control");
const searchButton = requireElement<HTMLButtonElement>("#search-button");
const suggestionsList = requireElement<HTMLUListElement>("#suggestions");
const statusEl = requireElement<HTMLDivElement>("#status");
const PARKS_BASEMAP_ITEM_ID = "7bde4cb58f1c4fe3bef7f9fbeeeb7e4b";
const BASEMAP_LABELS: Record<BasemapKey, string> = {
  parks: "Parks",
  osm: "OSM",
  imagery: "Imagery",
};

leftLogo.src = leftLogoUrl;
rightLogo.src = rightLogoUrl;

const map = L.map("map", {
  zoomControl: false,
  minZoom: 8,
  maxZoom: 18,
  maxBoundsViscosity: 0.85,
}).setView([46.8721, -113.994], 12);

let activeBasemapKey: BasemapKey = "parks";
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

async function initialize(): Promise<void> {
  const [loadedCityLimits, addresses, parksRecLocations] = await Promise.all([
    fetchJson<CityLimitsGeoJson>("data/city-limits.geojson"),
    fetchJson<AddressRecord[]>("data/addresses.json"),
    fetchJson<ParksRecGeoJson>("data/parks-rec-locations.geojson"),
  ]);

  cityLimits = loadedCityLimits;
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

  const maxBounds = buildDataBounds(addresses, cityBounds).pad(0.12);
  map.setMaxBounds(maxBounds);
  map.fitBounds(cityBounds, {
    animate: false,
    paddingTopLeft: [32, 112],
    paddingBottomRight: [32, 32],
  });

  addressIndex = buildAddressSearchIndex(addresses);

  setBusy(false);
  setStatus("Ready");
  input.disabled = false;
  searchButton.disabled = false;
  input.focus();
}

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

function createBasemapLayer(key: BasemapKey): L.Layer {
  if (key === "parks") {
    return vectorTileLayer(PARKS_BASEMAP_ITEM_ID, {
      portalUrl: "https://www.arcgis.com",
    }) as L.Layer;
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

function createBasemapControl(): L.Control {
  const control = new L.Control({ position: "bottomright" });

  control.onAdd = () => {
    const container = L.DomUtil.create(
      "div",
      "leaflet-control basemap-control",
    );

    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);

    (["parks", "osm", "imagery"] as BasemapKey[]).forEach((key) => {
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

function updateBasemapControlState(): void {
  document
    .querySelectorAll<HTMLButtonElement>(".basemap-control button")
    .forEach((button) => {
      const isActive = button.dataset.basemap === activeBasemapKey;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
}

function bringOperationalLayersForward(): void {
  cityLayer?.bringToFront();

  parksRecLayer?.eachLayer((layer) => {
    if ("bringToFront" in layer && typeof layer.bringToFront === "function") {
      layer.bringToFront();
    }
  });

  resultMarker?.setZIndexOffset(800);
}

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

  resultMarker.bindPopup(resultText).openPopup();
  fitResult(latLng);
}

function fitResult(latLng: L.LatLng): void {
  if (!cityBounds) {
    map.setView(latLng, 13);
    return;
  }

  const targetBounds = L.latLngBounds(
    cityBounds.getSouthWest(),
    cityBounds.getNorthEast(),
  ).extend(latLng);

  map.fitBounds(targetBounds, {
    maxZoom: 13,
    paddingTopLeft: [24, 124],
    paddingBottomRight: [24, 36],
  });
}

function isAddressInsideCityLimits(address: AddressRecord): boolean {
  if (!cityLimits) {
    return address.insideCityLimits;
  }

  const addressPoint = point([address.lng, address.lat]);
  return cityLimits.features.some((feature) =>
    booleanPointInPolygon(addressPoint, feature),
  );
}

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
