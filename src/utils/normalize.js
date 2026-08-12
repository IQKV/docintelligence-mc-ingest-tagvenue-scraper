// --- Text / string ---
export function cleanText(v) {
  if (v == null) return null;
  let s = String(v);
  // fix common mojibake from mis-decoded UTF-8 (e.g. Â£ → £, â‚¬ → €)
  s = s.replace(/\u00c2\u00a3/g, '£').replace(/\u00e2\u201a\u00ac/g, '€');
  // collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s === '' ? null : s;
}

export function parseFloatOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^\d.\-eE]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseIntOrNull(v, radix = 10) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), radix);
  return Number.isFinite(n) ? n : null;
}

export function uniqueStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    if (x == null) continue;
    const s = String(x).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export function truncate(s, maxLen = 2000) {
  if (s == null) return null;
  const str = String(s);
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

// --- Currency / price ---
const CURRENCY_SYMBOL_TO_CODE = {
  '£': 'GBP',
  '€': 'EUR',
  '$': 'USD',
  '¥': 'JPY',
  '₹': 'INR',
  '₽': 'RUB',
  '₩': 'KRW',
  '₱': 'PHP',
  'S$': 'SGD',
  'CA$': 'CAD',
  'A$': 'AUD',
  'NZ$': 'NZD',
  'HK$': 'HKD',
};

export function detectCurrency(priceString) {
  const s = String(priceString || '');
  // first try symbol multi-char
  for (const sym of ['S$', 'CA$', 'A$', 'NZ$', 'HK$']) {
    if (s.includes(sym)) return CURRENCY_SYMBOL_TO_CODE[sym];
  }
  for (const sym of Object.keys(CURRENCY_SYMBOL_TO_CODE).filter((k) => k.length === 1)) {
    if (s.includes(sym)) return CURRENCY_SYMBOL_TO_CODE[sym];
  }
  // Try ISO 3-char code: GBP EUR USD
  const m = s.toUpperCase().match(/\b(GBP|EUR|USD|JPY|INR|RUB|KRW|SGD|CAD|AUD|NZD|HKD|PHP|CHF|PLN|CZK|HUF|RON|SEK|NOK|DKK|BRL|MXN|ZAR)\b/);
  if (m) return m[1];
  return null;
}

export function parseNumericValueFromString(s) {
  if (s == null) return null;
  const matches = String(s).match(/(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/g);
  if (!matches) return null;
  let best = null;
  for (const m of matches) {
    const normalized = m.replace(/[,\s](?=\d{3})/g, '');
    const n = parseFloat(normalized);
    if (!Number.isFinite(n)) continue;
    if (best == null || n > best) best = n;
  }
  return best;
}

// --- Geography / country ---
const ISO_COUNTRY_MAP = {
  GB: 'United Kingdom',
  UK: 'GB',
  IE: 'Ireland',
  AU: 'Australia',
  NZ: 'New Zealand',
  SG: 'Singapore',
  CA: 'Canada',
  US: 'United States',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  IT: 'Italy',
  NL: 'Netherlands',
  BE: 'Belgium',
  CH: 'Switzerland',
  PT: 'Portugal',
  GR: 'Greece',
  SE: 'Sweden',
  NO: 'Norway',
  DK: 'Denmark',
  FI: 'Finland',
  PL: 'Poland',
  CZ: 'Czechia',
  HU: 'Hungary',
  RO: 'Romania',
  AT: 'Austria',
  LU: 'Luxembourg',
  BR: 'Brazil',
  MX: 'Mexico',
  AR: 'Argentina',
  CL: 'Chile',
  PE: 'Peru',
  ZA: 'South Africa',
  AE: 'UAE',
  SA: 'Saudi Arabia',
  QA: 'Qatar',
  KW: 'Kuwait',
  IN: 'India',
  JP: 'Japan',
  KR: 'South Korea',
  HK: 'Hong Kong',
  TW: 'Taiwan',
  MY: 'Malaysia',
  TH: 'Thailand',
  PH: 'Philippines',
  ID: 'Indonesia',
  VN: 'Vietnam',
};

export function normalizeCountryCode(code) {
  if (!code) return null;
  const c = String(code).toUpperCase().trim();
  if (ISO_COUNTRY_MAP[c]) {
    // Reverse UK → GB alias
    return c === 'UK' ? 'GB' : c;
  }
  return c.length === 2 ? c : null;
}

export function cityFromLocality(locality, fallbackParsedCity) {
  return cleanText(locality) || cleanText(fallbackParsedCity) || null;
}

export function fullAddressFromPostalAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const parts = [
    cleanText(addr.streetAddress),
    cleanText(addr.addressLocality),
    cleanText(addr.addressRegion),
    cleanText(addr.postalCode),
    cleanText(addr.addressCountry),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function parseDistanceMilesOrKm(s) {
  if (s == null) return null;
  const str = String(s).toLowerCase();
  const num = parseNumericValueFromString(str);
  if (num == null) return null;
  if (str.includes('km') || str.includes('kilomet')) return +(num * 0.621371).toFixed(2);
  // assume miles for tags like "0.5 mi", "0.5 mile", "0.5 miles"; default miles if none
  return +num.toFixed(2);
}

export function parseMinutes(s) {
  if (s == null) return null;
  const str = String(s);
  // "39 min" / "39 minutes" / "within 1 hour"
  const hour = /(\d+)\s*(h|hour|hr)/i.exec(str);
  if (hour) return parseInt(hour[1], 10) * 60;
  const n = parseIntOrNull(str);
  return n;
}

export function parsePercent(s) {
  if (s == null) return null;
  const n = parseFloatOrNull(String(s).replace('%', ''));
  if (n == null) return null;
  return n > 1 ? +(n / 100).toFixed(4) : +n.toFixed(4);
}

// --- Category / venue_type inference ---
const VENUE_TYPE_KEYWORDS = [
  // (keywords-in-description-or-type, canonical venue_type)
  { k: ['restaurant', 'dining', 'brasserie', 'bistro', 'gastropub', 'cafe', 'coffee'], v: 'restaurant_private_event_space' },
  { k: ['hotel', 'boutique hotel'], v: 'hotel' },
  { k: ['bar', 'pub', 'cocktail bar', 'rooftop bar', 'lounge bar'], v: 'bar_lounge' },
  { k: ['rooftop'], v: 'rooftop' },
  { k: ['gallery', 'art gallery'], v: 'gallery' },
  { k: ['warehouse', 'industrial'], v: 'warehouse_industrial' },
  { k: ['studio'], v: 'studio' },
  { k: ['garden', 'courtyard', 'terrace', 'outdoor'], v: 'outdoor_garden_terrace' },
  { k: ['town hall', 'townhall', 'guildhall', 'assembly hall'], v: 'town_hall_community_centre' },
  { k: ['conference centre', 'conference center', 'conference suite'], v: 'conference_centre' },
  { k: ['stadium', 'arena', 'sports hall'], v: 'stadium_arena' },
  { k: ['museum'], v: 'museum' },
  { k: ['theatre', 'theater', 'cinema'], v: 'theatre_cinema' },
  { k: ['yacht', 'boat', 'ship', 'barge', 'river cruise'], v: 'boat_yacht' },
  { k: ['marquee', 'tipi', 'tent', 'barn'], v: 'marquee_tipi_barn' },
  { k: ['park', 'zoo', 'botanical'], v: 'park_zoo_gardens' },
  { k: ['chapel', 'church'], v: 'place_of_worship' },
  { k: ['private member', 'members club'], v: 'private_members_club' },
  { k: ['nightclub', 'club venue', 'club'], v: 'nightclub' },
  { k: ['house', 'mansion', 'estate', 'hall'], v: 'historic_house_estate' },
  { k: ['beach', 'coastal'], v: 'beach_coastal' },
];

export function inferVenueTypes({ ldTypes = [], ldName = '', ldDescription = '', features = [], breadcrumbNames = [] }) {
  const bag = [
    ...(Array.isArray(ldTypes) ? ldTypes.map(String) : []),
    ldName || '',
    ldDescription || '',
    ...(features || []),
    ...(breadcrumbNames || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const out = [];
  for (const rule of VENUE_TYPE_KEYWORDS) {
    if (rule.k.some((kw) => bag.includes(kw)) && !out.includes(rule.v)) out.push(rule.v);
  }
  return out;
}

// --- Amenities classification buckets ---
const AMENITIES_RULES = [
  { re: /\b(wi-?fi|wifi|internet|broadband)\b/i, key: 'wifi' },
  { re: /\b(projector|projection)\b/i, key: 'projector' },
  { re: /\b(built.?in.?av|integrated av|in.?built audio|audio visual|a\/v equipment)\b/i, key: 'built_in_av' },
  { re: /\b(screen|screens|flat.?screen|tv|led wall|plasma|hdmi|monitor)\b/i, key: 'screens' },
  { re: /\b(speaker|pa system|public address|sound system|microphone|mic|audio)\b/i, key: 'speakers' },
  { re: /\b(whiteboard|white board|marker board)\b/i, key: 'whiteboard' },
  { re: /\b(flipchart|flip chart)\b/i, key: 'flipchart' },
  { re: /\b(conference call|video conference|teams|zoom|polycom)\b/i, key: 'conference_call' },
  { re: /\b(air.?condition|aircon|a\/c|ac |climate control|cooling|heating)\b/i, key: 'air_conditioning' },
  { re: /\b(natural light|daylight|natural daylight|windows)\b/i, key: 'natural_light' },
  { re: /\b(private bar)\b/i, key: 'private_bar' },
  { re: /\b(private entrance|separate entrance)\b/i, key: 'private_entrance' },
  { re: /\b(private restroom|private toilet|en-suite bathroom|private bathroom|private wc)\b/i, key: 'private_toilets' },
  { re: /\b(parking|car park|on-site parking|parking available|valet parking|car valet)\b/i, key: 'parking_available' },
  { re: /\b(street parking|paid parking|public parking|nearby parking)\b/i, key: 'paid_parking_nearby' },
  { re: /\b(storage|cloakroom)\b/i, key: 'storage_space' },
  { re: /\b(quiet room|quiet space|breakout space|break out)\b/i, key: 'quiet_space' },
  { re: /\b(noise restriction|music ends|sound limit|noise limit|noise curfew)\b/i, key: 'noise_restriction_after' },
  { re: /\b(alcohol license|alcohol licence|bar extension|until\s*\d\d:\d\d.*alcohol)\b/i, key: 'alcohol_licence' },
  { re: /\b(alcohol license.*?until|alcohol licence.*?until|alcohol until)\b/i, key: 'alcohol_licence_until' },
  { re: /\b(live music|play own music|dj permitted|music allowed|music policy)?(?!not)\b/i, key: 'play_own_music_allowed' },
  { re: /\b(dj allowed|own dj|bring your own dj|byo dj)\b/i, key: 'byo_dj_allowed' },
  { re: /\b(bring your own alcohol|byo alcohol|byob|corkage)\b/i, key: 'byo_alcohol_allowed' },
  { re: /\b(external cater|outside cater|bring own cater|outside food)\b/i, key: 'external_catering_allowed' },
  { re: /\b(in.?house cater|on.?site cater|own cater|catering provided|catering in.?house)\b/i, key: 'in_house_catering' },
  { re: /\bkosher/i, key: 'kosher_available' },
  { re: /\bhalal/i, key: 'halal_available' },
  { re: /\bvegan\b/i, key: 'vegan_available' },
  { re: /\bvegetarian\b/i, key: 'vegetarian_available' },
  { re: /\bgluten free|gluten-free\b/i, key: 'gluten_free_available' },
  { re: /\b(ada|disabl|wheelchair|access ramps?|ramp)\b/i, key: 'wheelchair_accessible' },
  { re: /\b(accessible toilet|disabled toilet|adapted toilet|disabled restroom)\b/i, key: 'accessible_restrooms' },
  { re: /\blift\b|\belevator\b/i, key: 'elevator_access' },
  { re: /\bground floor\b|\blevel access\b|\bstreet level\b/i, key: 'ground_level' },
  { re: /\b(step free|flat access)\b/i, key: 'step_free' },
  { re: /\bdisabled parking\b/i, key: 'disabled_parking' },
  { re: /\bcargo lift\b|\bfreight elevator\b/i, key: 'cargo_lift' },
];

const RESTRICTIONS_RULES = [
  { re: /\bno smoking\b|\bnon[- ]smoking\b/i, v: 'No smoking in the building' },
  { re: /\bno (outside|external|exterior) catering\b|\boutside catering not allowed\b|\bexternal catering not permitted\b/i, v: 'Outside catering is not allowed' },
  { re: /\b(no byo alcohol|byo alcohol not allowed|no byob|corkage not permitted|no corkage)\b/i, v: 'BYO alcohol not allowed' },
  { re: /\b(no (public|promoted|ticketed) events|no club nights|no promoted events|no ticketed events)\b/i, v: 'No promoted and ticketed events allowed' },
  { re: /\bno (dj|own dj|bring your own dj|byo dj)\b|\bdj not allowed\b/i, v: 'Bring your own DJ not allowed' },
  { re: /\bno (wedd|marriage|ceremony)\b|\bnot (approved|licensed|suitable) for wedd|\bno wedd licen|\bno marriage licence\b/i, v: 'No wedding licence' },
  { re: /\bno (confetti|rice|strobe|naked flame|candle|helium|balloon|smoke)\b/i, v: 'Certain decorations prohibited' },
  { re: /\bno pets\b|\bno animals\b/i, v: 'No pets allowed' },
  { re: /\bno minors\b|\bno children\b|\bover 18\b|\b18\+\b|\bage 18\b/i, v: 'Age restriction 18+' },
];

export function classifyAmenities(list) {
  const buckets = {
    av_tech: {},
    logistics: {},
    accessibility: {},
    catering: {},
    music_and_sound: {},
    raw: [],
  };
  const lowerList = (list || []).map((x) => String(x));
  for (const line of lowerList) {
    const t = line.trim();
    if (!t) continue;
    buckets.raw.push(t);
    for (const rule of AMENITIES_RULES) {
      if (!rule.re.test(t)) continue;
      switch (rule.key) {
        case 'wifi': buckets.av_tech.wifi = true; break;
        case 'projector': buckets.av_tech.projector = true; break;
        case 'built_in_av': buckets.av_tech.built_in_av = true; break;
        case 'screens':
          buckets.av_tech.screens = (buckets.av_tech.screens || 0) + 1;
          buckets.av_tech.flatscreen_tv = true;
          break;
        case 'speakers':
          buckets.av_tech.speakers = true;
          buckets.av_tech.pa_system = true;
          break;
        case 'whiteboard': buckets.av_tech.whiteboard = true; break;
        case 'flipchart': buckets.av_tech.flipchart = true; break;
        case 'conference_call': buckets.av_tech.conference_call = true; break;
        case 'air_conditioning': buckets.logistics.air_conditioning = true; break;
        case 'natural_light': buckets.logistics.natural_light = true; break;
        case 'private_bar': buckets.logistics.private_bar = true; break;
        case 'private_entrance': buckets.logistics.private_entrance = true; break;
        case 'private_toilets': buckets.logistics.private_toilets = true; break;
        case 'parking_available': buckets.logistics.parking_available = true; break;
        case 'paid_parking_nearby': buckets.logistics.paid_parking_nearby = true; break;
        case 'storage_space': buckets.logistics.storage_space = true; break;
        case 'quiet_space': buckets.logistics.quiet_space = true; break;
        case 'noise_restriction_after': {
          const time = extractTimeFromText(t);
          buckets.logistics.noise_restriction_after = time || buckets.logistics.noise_restriction_after || null;
          break;
        }
        case 'alcohol_licence': buckets.logistics.alcohol_licence = true; break;
        case 'alcohol_licence_until': {
          const time = extractTimeFromText(t);
          buckets.logistics.alcohol_licence_until = time || buckets.logistics.alcohol_licence_until || null;
          break;
        }
        case 'play_own_music_allowed': buckets.music_and_sound.play_own_music_allowed = true; break;
        case 'byo_dj_allowed': buckets.music_and_sound.byo_dj_allowed = true; break;
        case 'byo_alcohol_allowed': buckets.catering.byo_alcohol_allowed = true; break;
        case 'external_catering_allowed': buckets.catering.external_catering_allowed = true; break;
        case 'in_house_catering': buckets.catering.in_house_available = true; break;
        case 'kosher_available': buckets.catering.kosher_available = true; break;
        case 'halal_available': buckets.catering.halal_available = true; break;
        case 'vegan_available': buckets.catering.vegan_available = true; break;
        case 'vegetarian_available': buckets.catering.vegetarian_available = true; break;
        case 'gluten_free_available': buckets.catering.gluten_free_available = true; break;
        case 'wheelchair_accessible': buckets.accessibility.wheelchair_accessible = true; break;
        case 'accessible_restrooms': buckets.accessibility.accessible_restrooms = true; break;
        case 'elevator_access': buckets.accessibility.elevator_access = true; break;
        case 'ground_level': buckets.accessibility.ground_level = true; break;
        case 'step_free': buckets.accessibility.step_free = true; break;
        case 'disabled_parking': buckets.accessibility.disabled_parking = true; break;
        case 'cargo_lift': buckets.accessibility.cargo_lift = true; break;
      }
    }
  }
  return buckets;
}

export function classifyRestrictions(list) {
  const out = [];
  const seen = new Set();
  for (const line of list || []) {
    const t = String(line).trim();
    if (!t) continue;
    for (const rule of RESTRICTIONS_RULES) {
      if (!rule.re.test(t)) continue;
      if (!seen.has(rule.v)) {
        seen.add(rule.v);
        out.push(rule.v);
      }
    }
  }
  return out;
}

// --- Helpers ---
function extractTimeFromText(s) {
  // Accepts "until 23:00", "alcohol licence until 01:30", "music ends 23:00" etc.
  const m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(String(s));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// --- Capacity configs from additionalProperty + maxCapacity
const CAPACITY_LABELS = [
  { re: /standing|cocktail\s*style|reception|drinks\s*reception|drinks\s*only/i, key: 'standing' },
  { re: /banquet|dining|sit[\s-]*down\s*dinner|seated\s*dinner|formal\s*dinner|dinner/i, key: 'banquet' },
  { re: /theatre|theater|auditorium|presentation|lecture/i, key: 'theater' },
  { re: /classroom|school\s*room|training|workshop/i, key: 'classroom' },
  { re: /conference|board\s*meeting|boardroom|cabaret/i, key: 'conference' },
  { re: /boardroom|board\s*room/i, key: 'boardroom' },
  { re: /cocktail(?!.*standing)/i, key: 'cocktail' },
  { re: /minimum|minimum\s*attendees|min\s*attendees|min\s*people/i, key: 'min_total' },
];

export function parseCapacityConfigs({ maximumAttendeeCapacity, additionalProps = {}, specRows = [] }) {
  const rows = Object.entries(additionalProps).map(([key, value]) => ({ key: String(key), value: String(value) }));
  for (const r of specRows) rows.push({ key: r.key, value: r.value });
  const configurations = {};
  let minTotal = null;
  for (const { key, value } of rows) {
    const labelText = `${key} ${value}`;
    const number = parseNumericValueFromString(value) ?? parseNumericValueFromString(key);
    if (number == null) continue;
    let matched = null;
    for (const rule of CAPACITY_LABELS) {
      if (rule.re.test(labelText)) { matched = rule.key; break; }
    }
    if (matched === 'min_total') {
      minTotal = number;
    } else if (matched) {
      configurations[matched] = Math.round(number);
    }
  }
  return {
    max_total: typeof maximumAttendeeCapacity === 'number' ? Math.max(
      maximumAttendeeCapacity,
      ...Object.values(configurations),
      0,
    ) : Math.max(0, ...Object.values(configurations)) || null,
    configurations,
    min_attendees_per_event: minTotal,
  };
}

export function parseCuisines(list) {
  const text = (list || []).join(' ').toLowerCase();
  const known = ['asian', 'european', 'indian', 'italian', 'french', 'mediterranean', 'mexican', 'japanese', 'chinese', 'thai', 'american', 'british', 'middle eastern', 'african', 'caribbean', 'vegan', 'vegetarian', 'gluten-free'];
  return known.filter((c) => text.includes(c));
}

export { extractTimeFromText };
