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

test("normalizer maps capacity, pricing and venue type into metadata", () => {
  const entry = normalize();
  const meta = entry.metadata;
  assert.equal(meta._schema_version, CANONICAL_SCHEMA_VERSION);
  assert.equal(meta.capacity.max_total, 90);
  assert.deepEqual(meta.capacity.configurations, {
    standing: 90,
    banquet: 60,
    theater: 40,
  });
  assert.equal(meta.pricing.currency, "GBP");
  assert.equal(meta.pricing.price_method, "per_person_per_session");
  assert.equal(meta.pricing.minimum_spend, 1000);
  assert.match(meta.pricing.price_range_hint, /£10/);
  assert.ok(meta.venue_type.includes("restaurant_private_event_space"));
  assert.equal(meta.av_tech.wifi, true);
  assert.equal(meta.av_tech.projector, true);
  assert.equal(meta.logistics.air_conditioning, true);
  assert.equal(meta.logistics.natural_light, true);
  assert.equal(meta.catering.policy, "in_house_exclusive");
  assert.deepEqual(meta.catering.cuisines_available, ["british"]);
  assert.equal(meta.logistics.parking_available, true);
  assert.equal(meta.logistics.alcohol_licence, true);
});

test("normalizer turns unavailable features into canonical restrictions", () => {
  const meta = normalize().metadata;
  // "Unavailable: X" lines are translated, never also appended verbatim.
  assert.deepEqual(meta.restrictions, [
    "Outside catering is not allowed",
    "Accommodation not available",
    "No promoted and ticketed events allowed",
    "BYO alcohol not allowed",
  ]);
  // Capacity labels ("Up to 300 standing") belong to `capacity`, not `amenities`.
  assert.ok(!meta.amenities.some((a) => /^up to\b/i.test(a)));
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
  assert.deepEqual(entry.metadata.contacts, [{ name: "Dovile S.", role: "Venue Manager" }]);
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
