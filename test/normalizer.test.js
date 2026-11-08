import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTagvenueRecord } from "../src/providers/tagvenue/extractor.js";
import {
  normalizeTagvenueToCanonical,
  CANONICAL_SCHEMA_VERSION,
} from "../src/providers/tagvenue/normalizer.js";

const VENUE_URL = "https://www.tagvenue.com/venues/london/11896/the-last-talisman";

const HTML = readFileSync(new URL("./fixtures/tagvenue-venue.html", import.meta.url), "utf8");

const NOW = new Date("2026-01-01T00:00:00.000Z");

function normalize() {
  return normalizeTagvenueToCanonical(extractTagvenueRecord({ url: VENUE_URL, html: HTML }), NOW);
}

function fieldValue(meta, group, field) {
  return meta.items.find((row) => row.group === group && row.field === field)?.value;
}

function fieldValues(meta, group, field) {
  return meta.items.filter((row) => row.group === group && row.field === field).map((r) => r.value);
}

test("normalizer emits the canonical identity envelope", () => {
  const entry = normalize();
  assert.equal(entry._schema_version, CANONICAL_SCHEMA_VERSION);
  assert.equal(entry.external_id, "tagvenue:venue:11896");
  assert.equal(entry.external_source, "tagvenue");
  assert.equal(entry.source, "web_scrape");
  assert.equal(entry.source_url, VENUE_URL);
  assert.deepEqual(entry.tagvenue_ids, {
    venue_id: 11896,
    venue_slug: "the-last-talisman",
    city_slug: "london",
  });
});

test("normalizer maps name, aliases and address", () => {
  const entry = normalize();
  assert.equal(entry.name, "The Last Talisman");
  assert.deepEqual(entry.aliases, ["Rooms & Event Spaces at The Last Talisman"]);
  assert.equal(entry.address, "171-173 Bermondsey Street, London, SE1 3UW, GB");
  assert.equal(entry.city, "London");
  assert.equal(entry.country_code, "GB");
  assert.equal(entry.postal_code, "SE1 3UW");
  assert.deepEqual(entry.location, { lat: 51.499067, lng: -0.0808991 });
});

test("normalizer emits flat {group, field, value} metadata rows", () => {
  const meta = normalize().metadata;
  assert.equal(meta._schema_version, CANONICAL_SCHEMA_VERSION);
  // Absent and false leaves emit no row, so every row carries a real value.
  assert.ok(
    meta.items.every((row) => typeof row.group === "string" && row.field && row.value != null),
  );
  // Nested keys flatten to a dot path; list sections repeat one row per element.
  assert.ok(
    meta.items.some((row) => row.group === "capacity" && row.field === "configurations.banquet"),
  );
  assert.ok(meta.items.filter((row) => row.group === "amenities").length > 1);
});

test("normalizer maps capacity, pricing and venue type into metadata rows", () => {
  const meta = normalize().metadata;
  assert.equal(fieldValue(meta, "capacity", "max_total"), 90);
  assert.equal(fieldValue(meta, "capacity", "configurations.standing"), 90);
  assert.equal(fieldValue(meta, "capacity", "configurations.banquet"), 60);
  assert.equal(fieldValue(meta, "capacity", "configurations.theater"), 40);
  assert.equal(fieldValue(meta, "pricing", "currency"), "GBP");
  assert.equal(fieldValue(meta, "pricing", "price_method"), "Per person");
  assert.equal(fieldValue(meta, "pricing", "minimum_spend"), 1000);
  assert.match(fieldValue(meta, "pricing", "price_range_hint"), /£10/);
  assert.ok(fieldValues(meta, "venue_type", "venue_type").includes("Restaurant"));
  assert.equal(fieldValue(meta, "av_tech", "wifi"), true);
  assert.equal(fieldValue(meta, "av_tech", "projector"), true);
  assert.equal(fieldValue(meta, "logistics", "air_conditioning"), true);
  assert.equal(fieldValue(meta, "logistics", "natural_light"), true);
  assert.equal(fieldValue(meta, "catering", "policy"), "In-house catering only");
  assert.deepEqual(fieldValues(meta, "catering", "cuisines_available"), ["british"]);
  assert.equal(fieldValue(meta, "logistics", "parking_available"), true);
  assert.equal(fieldValue(meta, "logistics", "alcohol_licence"), true);
});

test("normalizer turns unavailable features into canonical restrictions", () => {
  const meta = normalize().metadata;
  // "Unavailable: X" lines are translated, never also appended verbatim.
  assert.deepEqual(fieldValues(meta, "restrictions", "restrictions"), [
    "Outside catering is not allowed",
    "Accommodation not available",
    "No promoted and ticketed events allowed",
    "BYO alcohol not allowed",
  ]);
  // Capacity labels ("Up to 300 standing") belong to `capacity`, not `amenities`.
  assert.ok(!fieldValues(meta, "amenities", "amenities").some((a) => /^up to\b/i.test(a)));
});

test("normalizer lists one asset per photo, keyed by a predictable file name", () => {
  const entry = normalize();
  assert.equal(entry.photos.count, 2);
  assert.deepEqual(
    entry.photos.gallery.map((a) => a.file),
    ["11896-the-last-talisman-venue.jpg", "5-gladstone-library-room.jpg"],
  );
  assert.equal(entry.photos.gallery[0].transform, "widen-1680-noupsize");
  assert.equal(
    entry.photos.gallery[1].url,
    "https://www.tagvenue.com/resize/ab/cd/widen-1680-noupsize;5-gladstone-library-room.jpg",
  );
  assert.equal(entry.photos.main_image.file, "11896-the-last-talisman-venue.jpg");
});

test("normalizer maps rating, station and contacts", () => {
  const entry = normalize();
  assert.equal(entry.rating.value, 4.7);
  assert.equal(entry.rating.review_count, 588);
  assert.equal(entry.rating.source, "tagvenue");
  assert.deepEqual(entry.nearest_station, { name: "London Bridge Station", distance_miles: 0.5 });
  assert.deepEqual(fieldValues(entry.metadata, "contacts", "contacts"), [
    { name: "Dovile S.", role: "Venue Manager" },
  ]);
  assert.equal(entry.company.manager_name, "Dovile S.");
});

test("normalizer maps reviews and provenance", () => {
  const entry = normalize();
  assert.equal(entry.reviews.length, 1);
  assert.equal(entry.reviews[0].author, "Luisa P.");
  assert.equal(entry.reviews[0].date, "2025-09-09");
  assert.equal(entry.reviews[0].rating, 4.8);
  assert.equal(entry.reviews[0].text, "Amazing space!");
  assert.equal(entry.scrape_run.at, NOW.toISOString());
  assert.equal(entry.scrape_run.fetcher, "http");
  assert.equal(entry.scrape_run.coverage.has_json_ld, true);
  assert.equal(entry.scrape_run.coverage.gallery_count, 2);
  assert.equal(entry.confidence, 0.9);
});
