import {
  cleanText,
  parseFloatOrNull,
  parseIntOrNull,
  detectCurrency,
  parseNumericValueFromString,
  normalizeCountryCode,
  cityFromLocality,
  fullAddressFromPostalAddress,
  parseDistanceMilesOrKm,
  parseMinutes,
  parsePercent,
  inferVenueTypes,
  classifyAmenities,
  classifyRestrictions,
  parseCapacityConfigs,
  parseCuisines,
  extractTimeFromText,
  truncate,
} from "../../utils/normalize.js";
import { pickPhotoVariants } from "./selectors.js";

// Schema version matches Shortlisty canonical metadata schema.
const SCHEMA_VERSION = 1;

// Canonical metadata is a flat row list so downstream code can render or filter any
// section without knowing its shape: {group, field, value}. A section's nested keys
// become dot-paths (capacity -> "configurations.banquet"); a list section repeats one
// row per element. Absent (null) leaves emit no row. `value` keeps its native JSON
// type; the field's type and vocabulary live in the shared UI spec, not in the data.
function toMetadataItems(sections) {
  const items = [];
  for (const [group, section] of Object.entries(sections)) {
    if (section == null) continue;
    if (Array.isArray(section)) {
      for (const value of section) if (value != null) items.push({ group, field: group, value });
    } else if (typeof section === "object") {
      for (const [field, value] of leafRows(section)) items.push({ group, field, value });
    } else {
      items.push({ group, field: group, value: section });
    }
  }
  return items;
}

function leafRows(object, prefix = "") {
  const rows = [];
  for (const [key, value] of Object.entries(object)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const element of value) if (element != null) rows.push([field, element]);
    } else if (typeof value === "object") {
      rows.push(...leafRows(value, field));
    } else {
      rows.push([field, value]);
    }
  }
  return rows;
}

export function normalizeTagvenueToCanonical(raw, now = new Date()) {
  // raw = extractTagvenueRecord output
  const ld = raw.ld || null;
  const dom = raw.dom || {};
  const parsed = raw.parsed_url || null;
  const scrape = raw._scrape || {};

  const addr = ld?.address || null;
  const geo = ld?.geo || null;
  const aggregate = dom.ld_aggregate_rating || null;

  const rawName =
    cleanText(ld?.name) ||
    cleanText(dom.h1_name) ||
    cleanText(dom.title) ||
    parsed?.venue_slug ||
    null;

  // aliases: [page title with the trailing "… | Tagvenue.com" suffix stripped]
  const aliases = [];
  if (dom.title && dom.title !== rawName) {
    const shorter = dom.title.replace(/\s*[-—–|].*?Tagvenue\.com\s*$/i, "").trim();
    if (shorter && shorter !== rawName) aliases.push(shorter);
  }

  // lat/lng fallback from hasMap query params
  let lat = parseFloatOrNull(geo?.latitude);
  let lng = parseFloatOrNull(geo?.longitude);
  if ((lat == null || lng == null) && ld?.hasMap) {
    const m = /query=([-\d.]+)\s*,\s*([-\d.]+)/.exec(String(ld.hasMap));
    if (m) {
      lat = parseFloatOrNull(m[1]);
      lng = parseFloatOrNull(m[2]);
    }
  }

  const countryCode = normalizeCountryCode(addr?.addressCountry);
  const localityClean = cityFromLocality(addr?.addressLocality, parsed?.city);

  // pricing
  const priceRange = cleanText(ld?.priceRange) || cleanText(dom.price_hint_text) || "";
  const currency = detectCurrency(priceRange) || null;
  const priceNumber = parseNumericValueFromString(priceRange);
  const priceHint = priceRange ? truncate(priceRange, 200) : null;

  let priceMethod = null;
  const pr = priceRange.toLowerCase();
  if (/\bper\s*(person|head|pax|guest|delegate)\b/.test(pr)) priceMethod = "per_person_per_session";
  else if (/\bper\s*(day|hour|session|evening|hire)\b/.test(pr)) priceMethod = "per_session_hire";
  else if (/minimum\s*spend|min\.\s*spend/.test(pr)) priceMethod = "minimum_spend";

  const minSpendNumber = parseNumericValueFromString(dom.price_minimum_spend_text || "");

  // Capacity
  const specRows = dom.spec_table_rows || [];
  const capacity = parseCapacityConfigs({
    maximumAttendeeCapacity: parseIntOrNull(ld?.maximumAttendeeCapacity),
    additionalProps: ld?.additionalProperty || {},
    specRows,
    featureLines: dom.features_list || [],
  });
  // capacity.min_attendees_per_event also additionalProperty if present
  const minAttendeesFromAdd =
    ld?.additionalProperty?.["Minimum attendees"] ?? ld?.additionalProperty?.["Minimum people"];
  if (capacity.min_attendees_per_event == null && minAttendeesFromAdd != null) {
    capacity.min_attendees_per_event = parseIntOrNull(minAttendeesFromAdd);
  }

  // Amenities buckets from features + additionalProperty + spec rows
  const rawFeatures = [
    ...(dom.features_list || []),
    ...specRows.map(({ key, value }) => `${key}: ${value}`),
    ...Object.entries(ld?.additionalProperty || {}).map(([k, v]) => `${k}: ${v}`),
  ];
  const buckets = classifyAmenities(rawFeatures);

  // Restrictions from restrictions_list + spec_rows "Rules"/"Catering policy"/"Policy" keys
  const restrictionLines = [
    ...(dom.restrictions_list || []),
    ...specRows
      .filter((r) =>
        /\b(rule|restriction|policy|catering|alcohol|music|decoration|age|smoking|children|event type)\b/i.test(
          r.key,
        ),
      )
      .map((r) => `${r.key}: ${r.value}`),
  ];
  const restrictions = classifyRestrictions(restrictionLines);
  // Append generic restrictions not caught by regex but present in raw text.
  // Lines a rule already translated (e.g. "Unavailable: BYO alcohol") must not
  // also be appended verbatim, or the canonical + raw wording both show up.
  for (const line of dom.restrictions_list || []) {
    if (restrictions.length >= 20) break;
    if (classifyRestrictions([line]).length) continue;
    const trimmed = truncate(line, 200);
    if (trimmed && !restrictions.includes(trimmed)) restrictions.push(trimmed);
  }

  // Noise restriction after time: fallback to amenities bucket if found
  if (
    !restrictions.some((r) => /noise|music ends|sound limit/i.test(r)) &&
    buckets.logistics.noise_restriction_after
  ) {
    restrictions.push(`Noise restriction after ${buckets.logistics.noise_restriction_after}`);
  }

  // venue_type inference
  const breadcrumbNames = (raw.breadcrumb?.items || []).map((x) => x.name).filter(Boolean);
  const venueTypes = inferVenueTypes({
    ldTypes: Array.isArray(ld?.["@type"]) ? ld["@type"] : [ld?.["@type"]].filter(Boolean),
    ldName: rawName,
    ldDescription: cleanText(ld?.description) || cleanText(dom.description),
    features: dom.features_list || [],
    breadcrumbNames,
  });
  if (venueTypes.length === 0) venueTypes.push("unclassified");

  // Catering
  const inHouse = buckets.catering.in_house_available;
  const ext = buckets.catering.external_catering_allowed;
  let cateringPolicy = "unspecified";
  if (inHouse && !ext) cateringPolicy = "in_house_exclusive";
  else if (ext && !inHouse) cateringPolicy = "external_only";
  else if (inHouse && ext) cateringPolicy = "in_house_plus_external";
  else if (!inHouse && !ext && priceMethod === "minimum_spend")
    cateringPolicy = "in_house_exclusive";
  else cateringPolicy = "external_not_allowed_or_unknown";

  // Licence until: catering.alcohol_licence_until
  const alcoholLicenceUntil =
    buckets.logistics.alcohol_licence_until || (buckets.logistics.alcohol_licence ? null : null);

  // Nearest station
  const stationName = cleanText(dom.nearest_station_name);
  const stationDist = parseDistanceMilesOrKm(dom.nearest_station_distance);

  // Host info
  const hostName = cleanText(dom.host_name);
  const hostRespMinutes = parseMinutes(dom.host_response_minutes_raw);
  const hostRespRate = parsePercent(dom.host_response_rate_raw);

  // Contacts list
  const contacts = [];
  if (hostName) contacts.push({ name: hostName, role: "Venue Manager" });

  // Reviews normalized list
  const reviewsNorm = [];
  for (const r of dom.reviews || []) {
    if (!r.author && !r.text) continue;
    reviewsNorm.push({
      author: cleanText(r.author) || null,
      date: cleanText(r.dateRaw) || null,
      rating:
        typeof r.rating === "number"
          ? r.rating
          : typeof r.ratingVal === "number"
            ? r.ratingVal
            : null,
      text: truncate(cleanText(r.text), 2000),
    });
    if (reviewsNorm.length >= 30) break;
  }

  // Photos: one asset entry per photo, keeping the widest variant available.
  // The `file` name is derived from the photo key, not from the variant, so the
  // asset store lays down the same file for a photo on every run.
  const photoUrls = [
    ...(typeof ld?.image === "string" ? [ld.image] : Array.isArray(ld?.image) ? ld.image : []),
    ...(dom.gallery_images || []),
  ];
  const assets = pickPhotoVariants(photoUrls);

  const company = {};
  if (hostName) company.manager_name = hostName;
  if (hostRespMinutes != null) company.response_time_minutes = hostRespMinutes;
  if (hostRespRate != null) company.response_rate = hostRespRate;

  const nearestStation =
    stationName || stationDist ? { name: stationName, distance_miles: stationDist } : null;

  const tagvenueIds = parsed
    ? {
        venue_id: parsed.venue_id,
        venue_slug: parsed.venue_slug || null,
        city_slug: parsed.city || null,
      }
    : null;

  const metadataFields = {
    capacity,
    venue_type: venueTypes,
    catering: {
      policy: cateringPolicy,
      kosher_available: !!buckets.catering.kosher_available || null,
      halal_available: !!buckets.catering.halal_available || null,
      vegan_available: !!buckets.catering.vegan_available || null,
      vegetarian_available: !!buckets.catering.vegetarian_available || null,
      gluten_free_available: !!buckets.catering.gluten_free_available || null,
      alcohol_licence_until: alcoholLicenceUntil || null,
      byo_alcohol_allowed: !!buckets.catering.byo_alcohol_allowed || null,
      external_catering_allowed: !!ext || null,
      cuisines_available: parseCuisines(dom.features_list || []),
    },
    av_tech: {
      built_in_av: !!buckets.av_tech.built_in_av || null,
      wifi: !!buckets.av_tech.wifi || null,
      projector: !!buckets.av_tech.projector || null,
      screens: buckets.av_tech.screens ?? null,
      speakers: !!buckets.av_tech.speakers || null,
      pa_system: !!buckets.av_tech.pa_system || null,
      flatscreen_tv: !!buckets.av_tech.flatscreen_tv || null,
      whiteboard: !!buckets.av_tech.whiteboard || null,
      flipchart: !!buckets.av_tech.flipchart || null,
      conference_call: !!buckets.av_tech.conference_call || null,
    },
    accessibility: {
      ada_compliant: !!buckets.accessibility.wheelchair_accessible || null,
      elevator_access: !!buckets.accessibility.elevator_access || null,
      accessible_restrooms: !!buckets.accessibility.accessible_restrooms || null,
      wheelchair_stage_access: null,
      wheelchair_accessible: !!buckets.accessibility.wheelchair_accessible || null,
      ground_level: !!buckets.accessibility.ground_level || null,
      disabled_parking: !!buckets.accessibility.disabled_parking || null,
      cargo_lift: !!buckets.accessibility.cargo_lift || null,
      step_free: !!buckets.accessibility.step_free || null,
    },
    logistics: {
      air_conditioning: !!buckets.logistics.air_conditioning || null,
      natural_light: !!buckets.logistics.natural_light || null,
      private_bar: !!buckets.logistics.private_bar || null,
      private_entrance: !!buckets.logistics.private_entrance || null,
      private_toilets: !!buckets.logistics.private_toilets || null,
      parking_available: !!buckets.logistics.parking_available || null,
      paid_parking_nearby: !!buckets.logistics.paid_parking_nearby || null,
      storage_space: !!buckets.logistics.storage_space || null,
      quiet_space: !!buckets.logistics.quiet_space || null,
      noise_restriction_after: buckets.logistics.noise_restriction_after || null,
      alcohol_licence: !!buckets.logistics.alcohol_licence || null,
    },
    // Capacity labels ("Up to 300 standing") live in `capacity`, so keep them
    // out of the amenities list to avoid the same fact appearing twice.
    amenities: buckets.raw.filter((line) => !/^\s*up to\b/i.test(line)).slice(0, 200),
    restrictions: restrictions.slice(0, 50),
    pricing: {
      currency,
      minimum_spend: minSpendNumber ?? priceNumber,
      rental_fee_indicative:
        priceMethod === "per_session_hire" ? (priceNumber ?? minSpendNumber) : null,
      price_range_hint: priceHint,
      price_method: priceMethod,
    },
    music_and_sound: {
      play_own_music_allowed: !!buckets.music_and_sound.play_own_music_allowed || null,
      byo_dj_allowed: !!buckets.music_and_sound.byo_dj_allowed || null,
      noise_restriction_after:
        buckets.logistics.noise_restriction_after ||
        extractTimeFromText(dom.restrictions_list?.join(" ") || "") ||
        null,
    },
    contacts,
  };

  const metadata = {
    _schema_version: SCHEMA_VERSION,
    items: toMetadataItems(metadataFields),
  };

  const entry = {
    _schema_version: SCHEMA_VERSION,
    external_id: parsed
      ? `tagvenue:venue:${parsed.venue_id}`
      : `tagvenue:url:${encodeURIComponent(scrape.url || ld?.url || "")}`,
    external_source: "tagvenue",
    source: "web_scrape",
    name: rawName,
    aliases,
    address: fullAddressFromPostalAddress(addr),
    city: localityClean,
    country_code: countryCode,
    postal_code: cleanText(addr?.postalCode) || null,
    location: lat != null && lng != null ? { lat, lng } : null,
    description: truncate(cleanText(ld?.description) || cleanText(dom.description), 4000),
    nearest_station: nearestStation,
    company: Object.keys(company).length ? company : null,
    tagvenue_ids: tagvenueIds,
    rating: aggregate?.rating_value
      ? {
          value: aggregate.rating_value,
          review_count:
            aggregate.review_count ??
            parseIntOrNull(dom.reviews_aggregate_count_raw) ??
            (reviewsNorm.length || 0),
          source: "tagvenue",
        }
      : null,
    photos: {
      count: assets.length || null,
      main_image: assets[0] ?? null,
      gallery: assets,
    },
    source_url: scrape.url || ld?.url || null,
    metadata,
    reviews: reviewsNorm,
    confidence: typeof scrape.confidence === "number" ? +scrape.confidence.toFixed(2) : 0.55,
    scrape_run: {
      at: now.toISOString(),
      fetcher: scrape.fetcher || "http",
      fetcher_version: scrape.fetcher_version || "0.1.0",
      duration_ms: scrape.duration_ms ?? null,
      http_status: scrape.http_status ?? null,
      coverage: {
        has_json_ld: !!ld,
        features_count: (dom.features_list || []).length,
        restrictions_count: restrictions.length,
        gallery_count: assets.length,
        reviews_count: reviewsNorm.length,
        spec_rows_count: specRows.length,
      },
    },
  };

  return entry;
}

export const CANONICAL_SCHEMA_VERSION = SCHEMA_VERSION;
