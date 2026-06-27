import MiniSearch, { type SearchResult } from "minisearch";

export interface AddressRecord {
  id: number;
  fulladdress: string;
  normalized: string;
  normalizedBase: string;
  display: string;
  addnum: number | null;
  roadname: string;
  fullroadname: string;
  community: string;
  state: string;
  zipcode: string;
  lng: number;
  lat: number;
  insideCityLimits: boolean;
  searchText: string;
}

export interface RankedAddress {
  record: AddressRecord;
  score: number;
  miniSearchScore: number;
}

export interface AddressSearchIndex {
  addresses: AddressRecord[];
  byId: Map<number, AddressRecord>;
  exactByFull: Map<string, AddressRecord[]>;
  exactByBase: Map<string, AddressRecord[]>;
  search: MiniSearch<AddressRecord>;
}

const MISSOULA_ZIPS = new Set(["59801", "59802", "59803", "59804", "59808"]);
const FILLER_TOKENS = new Set([
  "UNIT",
  "APT",
  "APARTMENT",
  "SUITE",
  "STE",
  "TRAILER",
  "LOT",
  "BUILDING",
  "BLDG",
]);

const TOKEN_EQUIVALENTS: Record<string, string> = {
  N: "NORTH",
  S: "SOUTH",
  E: "EAST",
  W: "WEST",
  NO: "NORTH",
  SO: "SOUTH",
  NORTH: "NORTH",
  SOUTH: "SOUTH",
  EAST: "EAST",
  WEST: "WEST",
  ST: "STREET",
  "ST.": "STREET",
  STREET: "STREET",
  AV: "AVENUE",
  AVE: "AVENUE",
  "AVE.": "AVENUE",
  AVENUE: "AVENUE",
  RD: "ROAD",
  "RD.": "ROAD",
  ROAD: "ROAD",
  DR: "DRIVE",
  "DR.": "DRIVE",
  DRIVE: "DRIVE",
  LN: "LANE",
  "LN.": "LANE",
  LANE: "LANE",
  TRL: "TRAIL",
  "TRL.": "TRAIL",
  TRAIL: "TRAIL",
  CT: "COURT",
  "CT.": "COURT",
  COURT: "COURT",
  CIR: "CIRCLE",
  "CIR.": "CIRCLE",
  CIRCLE: "CIRCLE",
  HWY: "HIGHWAY",
  "HWY.": "HIGHWAY",
  HIGHWAY: "HIGHWAY",
  BLVD: "BOULEVARD",
  "BLVD.": "BOULEVARD",
  BOULEVARD: "BOULEVARD",
  PKWY: "PARKWAY",
  "PKWY.": "PARKWAY",
  PARKWAY: "PARKWAY",
  PL: "PLACE",
  "PL.": "PLACE",
  PLACE: "PLACE",
  TER: "TERRACE",
  "TER.": "TERRACE",
  TERRACE: "TERRACE",
  APT: "UNIT",
  APARTMENT: "UNIT",
  STE: "SUITE",
  BLDG: "BUILDING",
};

// Address normalization: make typed text and source addresses comparable for search.
export function normalizeAddress(value: string): string {
  return value
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

// Search index builder: exact lookup maps plus MiniSearch fuzzy/prefix search.
export function buildAddressSearchIndex(addresses: AddressRecord[]): AddressSearchIndex {
  const byId = new Map<number, AddressRecord>();
  const exactByFull = new Map<string, AddressRecord[]>();
  const exactByBase = new Map<string, AddressRecord[]>();

  for (const address of addresses) {
    byId.set(address.id, address);
    addToLookup(exactByFull, address.normalized, address);
    addToLookup(exactByBase, address.normalizedBase, address);
  }

  const search = new MiniSearch<AddressRecord>({
    idField: "id",
    fields: ["normalized", "normalizedBase", "display", "fullroadname", "roadname", "community", "zipcode", "searchText"],
    storeFields: ["id"],
    searchOptions: {
      boost: {
        normalized: 5,
        normalizedBase: 4,
        fullroadname: 3,
        roadname: 2,
        display: 2,
        community: 0.8,
        zipcode: 0.8,
      },
      fuzzy: 0.18,
      prefix: true,
    },
  });

  search.addAll(addresses);

  return {
    addresses,
    byId,
    exactByFull,
    exactByBase,
    search,
  };
}

// Exact address match: try full address first, then base address without unit/subaddress detail.
export function findExactCandidates(index: AddressSearchIndex, rawQuery: string): AddressRecord[] {
  const normalized = normalizeAddress(rawQuery);
  return index.exactByFull.get(normalized) ?? index.exactByBase.get(normalized) ?? [];
}

// Fuzzy address search: use MiniSearch results, then apply local ranking rules.
export function searchAddresses(index: AddressSearchIndex, rawQuery: string, limit = 8): RankedAddress[] {
  const normalized = normalizeAddress(rawQuery);

  if (normalized.length < 2) {
    return [];
  }

  const results = index.search.search(normalized, {
    combineWith: "AND",
    fuzzy: normalized.length > 7 ? 0.18 : false,
    prefix: true,
  });

  return results
    .map((result) => {
      const record = index.byId.get(Number(result.id));

      if (!record) {
        return null;
      }

      return {
        record,
        score: rankAddress(rawQuery, normalized, record, result),
        miniSearchScore: result.score,
      };
    })
    .filter((result): result is RankedAddress => Boolean(result))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// Confident match test: only auto-select when the top result is clearly strong enough.
export function isConfidentMatch(rawQuery: string, matches: RankedAddress[]): boolean {
  if (matches.length === 0) {
    return false;
  }

  const [top, runnerUp] = matches;
  const normalized = normalizeAddress(rawQuery);

  if (top.record.normalized === normalized || top.record.normalizedBase === normalized) {
    return true;
  }

  if (runnerUp && top.score - runnerUp.score < 2.25) {
    return false;
  }

  const queryNumber = extractAddressNumber(normalized);
  const hasMatchingNumber = queryNumber !== null && top.record.addnum === queryNumber;
  const roadOverlap = countRoadTokenOverlap(normalized, top.record);

  return hasMatchingNumber && roadOverlap >= 1 && top.score >= 8;
}

function addToLookup(map: Map<string, AddressRecord[]>, key: string, address: AddressRecord): void {
  if (!key) {
    return;
  }

  const existing = map.get(key);

  if (existing) {
    existing.push(address);
    return;
  }

  map.set(key, [address]);
}

// Address ranking: boost exact address number, road overlap, Missoula community, and local ZIPs.
function rankAddress(
  rawQuery: string,
  normalizedQuery: string,
  record: AddressRecord,
  result: SearchResult
): number {
  let score = result.score;
  const queryNumber = extractAddressNumber(normalizedQuery);

  if (record.normalized === normalizedQuery) {
    score += 20;
  }

  if (record.normalizedBase === normalizedQuery) {
    score += 16;
  }

  if (queryNumber !== null && record.addnum === queryNumber) {
    score += 7;
  }

  score += countRoadTokenOverlap(normalizedQuery, record) * 1.75;

  if (record.community === "MISSOULA") {
    score += 1.4;
  }

  if (MISSOULA_ZIPS.has(record.zipcode)) {
    score += 0.7;
  }

  if (record.lng && record.lat) {
    score += 0.25;
  }

  if (record.addnum === 0 && !/^\s*0\b/.test(rawQuery)) {
    score -= 1.5;
  }

  return score;
}

function extractAddressNumber(normalizedQuery: string): number | null {
  const match = normalizedQuery.match(/^\d+/);
  return match ? Number(match[0]) : null;
}

function countRoadTokenOverlap(normalizedQuery: string, record: AddressRecord): number {
  const queryTokens = normalizedQuery
    .split(/\s+/)
    .filter((token) => token && Number.isNaN(Number(token)) && !FILLER_TOKENS.has(token));

  if (queryTokens.length === 0) {
    return 0;
  }

  const recordTokens = new Set(record.normalizedBase.split(/\s+/));
  return queryTokens.reduce((total, token) => total + (recordTokens.has(token) ? 1 : 0), 0);
}
