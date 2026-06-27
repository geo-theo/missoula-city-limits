import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { point } from "@turf/helpers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sourceCityPath = path.join(root, "data", "Missoula_city_limits.geojson");
const sourceAddressPath = path.join(root, "data", "Address_Structure_Points.geojson");
const sourceParksRecPath = path.join(root, "data", "ParksRec_Locations.geojson");
const publicDataDir = path.join(root, "public", "data");
const outputCityPath = path.join(publicDataDir, "city-limits.geojson");
const outputAddressPath = path.join(publicDataDir, "addresses.json");
const outputParksRecPath = path.join(publicDataDir, "parks-rec-locations.geojson");

const TOKEN_EQUIVALENTS = {
  N: "NORTH",
  S: "SOUTH",
  E: "EAST",
  W: "WEST",
  NO: "NORTH",
  SO: "SOUTH",
  ST: "STREET",
  STREET: "STREET",
  AV: "AVENUE",
  AVE: "AVENUE",
  AVENUE: "AVENUE",
  RD: "ROAD",
  ROAD: "ROAD",
  DR: "DRIVE",
  DRIVE: "DRIVE",
  LN: "LANE",
  LANE: "LANE",
  TRL: "TRAIL",
  TRAIL: "TRAIL",
  CT: "COURT",
  COURT: "COURT",
  CIR: "CIRCLE",
  CIRCLE: "CIRCLE",
  HWY: "HIGHWAY",
  HIGHWAY: "HIGHWAY",
  BLVD: "BOULEVARD",
  BOULEVARD: "BOULEVARD",
  PKWY: "PARKWAY",
  PARKWAY: "PARKWAY",
  PL: "PLACE",
  PLACE: "PLACE",
  TER: "TERRACE",
  TERRACE: "TERRACE",
  APT: "UNIT",
  APARTMENT: "UNIT",
  STE: "SUITE",
  BLDG: "BUILDING",
};

const TITLE_CASE_SMALL_WORDS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "US", "MT"]);

await mkdir(publicDataDir, { recursive: true });

// Data prep inputs: read original GIS exports from /data before creating browser-ready files.
const cityLimits = JSON.parse(await readFile(sourceCityPath, "utf8"));
const addressesSource = JSON.parse(await readFile(sourceAddressPath, "utf8"));
const parksRecSource = JSON.parse(await readFile(sourceParksRecPath, "utf8"));

// City limits output: strip metadata and keep only the geometry/display name needed by the app.
const compactCityLimits = {
  type: "FeatureCollection",
  features: cityLimits.features.map((feature) => ({
    type: "Feature",
    properties: {
      name: "Missoula city limits",
    },
    geometry: feature.geometry,
  })),
};

const cityGeometry = compactCityLimits.features[0];
const addresses = [];

// Parks Rec output: normalize Currents/Splash point fields for permanent map pins.
const parksRecLocations = {
  type: "FeatureCollection",
  features: parksRecSource.features
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature) => ({
      type: "Feature",
      properties: {
        location: clean(feature.properties?.Location),
      },
      geometry: feature.geometry,
    })),
};

// Address output: compact 50k+ raw point features into searchable browser records.
for (const feature of addressesSource.features) {
  const properties = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;
  const lng = Number(coordinates?.[0]);
  const lat = Number(coordinates?.[1]);
  const fulladdress = clean(properties.fulladdress);

  if (!fulladdress || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    continue;
  }

  const addnum = Number.isFinite(Number(properties.addnum)) ? Number(properties.addnum) : null;
  const fullroadname = clean(properties.fullroadname);
  const normalized = normalizeAddress(fulladdress);
  const normalizedBase = normalizeAddress([addnum ?? "", fullroadname].filter(Boolean).join(" "));
  const community = clean(properties.community);
  const state = clean(properties.state || "MT");
  const zipcode = clean(properties.zipcode);

  addresses.push({
    id: Number(properties.OBJECTID) || addresses.length + 1,
    fulladdress,
    normalized,
    normalizedBase,
    display: buildDisplayAddress(fulladdress, community, state, zipcode),
    addnum,
    roadname: clean(properties.roadname),
    fullroadname,
    community,
    state,
    zipcode,
    lng: roundCoordinate(lng),
    lat: roundCoordinate(lat),
    // City limits precompute: store the point-in-polygon result for fast popup responses.
    insideCityLimits: booleanPointInPolygon(point([lng, lat]), cityGeometry),
    searchText: normalizeAddress(
      [
        fulladdress,
        fullroadname,
        properties.roadname,
        addnum,
        community,
        state,
        zipcode,
      ]
        .filter(Boolean)
        .join(" ")
    ),
  });
}

// Address sort order: put Missoula community results first, then alphabetize display labels.
addresses.sort((a, b) => {
  if (a.community !== b.community) {
    if (a.community === "MISSOULA") return -1;
    if (b.community === "MISSOULA") return 1;
  }

  return a.display.localeCompare(b.display);
});

await writeFile(outputCityPath, `${JSON.stringify(compactCityLimits)}\n`);
await writeFile(outputAddressPath, `${JSON.stringify(addresses)}\n`);
await writeFile(outputParksRecPath, `${JSON.stringify(parksRecLocations)}\n`);

const insideCount = addresses.filter((address) => address.insideCityLimits).length;
console.log(`Wrote ${path.relative(root, outputCityPath)}`);
console.log(`Wrote ${addresses.length.toLocaleString()} addresses to ${path.relative(root, outputAddressPath)}`);
console.log(`Wrote ${parksRecLocations.features.length.toLocaleString()} Parks & Rec locations to ${path.relative(root, outputParksRecPath)}`);
console.log(`${insideCount.toLocaleString()} addresses are within city limits`);

// Address normalization: same idea as app search, standardizing suffixes and directionals.
function normalizeAddress(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[#.,/\\\-]+/g, " ")
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => TOKEN_EQUIVALENTS[token] ?? token)
    .join(" ")
    .trim();
}

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function buildDisplayAddress(fulladdress, community, state, zipcode) {
  return [
    toTitleCase(fulladdress),
    toTitleCase(community),
    [state, zipcode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
}

function toTitleCase(value) {
  return clean(value)
    .split(/\s+/)
    .map((part) => {
      if (TITLE_CASE_SMALL_WORDS.has(part.toUpperCase())) {
        return part.toUpperCase();
      }

      if (/^\d+[A-Z]?$/.test(part)) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function roundCoordinate(value) {
  return Number(value.toFixed(7));
}
