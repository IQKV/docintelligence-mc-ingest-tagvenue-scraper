import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTagvenueRecord } from "../src/providers/tagvenue/extractor.js";
import {
  normalizeTagvenueToCanonical,
  CANONICAL_SCHEMA_VERSION,
} from "../src/providers/tagvenue/normalizer.js";

const ROOM_URL =
  "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space";

const HTML = readFileSync(new URL("./fixtures/tagvenue-room.html", import.meta.url), "utf8");

const NOW = new Date("2026-01-01T00:00:00.000Z");

function normalize() {
  return normalizeTagvenueToCanonical(extractTagvenueRecord({ url: ROOM_URL, html: HTML }), NOW);
}

test("normalizer emits the canonical identity envelope", () => {
  const entry = normalize();
  assert.equal(entry._schema_version, CANONICAL_SCHEMA_VERSION);
  assert.equal(entry.external_id, "tagvenue:room:25426");
  assert.equal(entry.external_source, "tagvenue");
  assert.equal(entry.source, "web_scrape");
  assert.equal(entry.source_url, ROOM_URL);
});

test("normalizer maps name, aliases, venue and address", () => {
  const entry = normalize();
  assert.equal(entry.name, "Mala Madre Events Space at The Last Talisman");
  assert.deepEqual(entry.aliases, ["Mala Madre Events Space"]);
  assert.equal(entry.venue_name, "The Last Talisman");
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
  assert.match(meta.pricing.price_range_hint, /£10/);
  assert.ok(meta.venue_type.includes("restaurant_private_event_space"));
  assert.equal(meta.av_tech.wifi, true);
  assert.equal(meta.av_tech.projector, true);
  assert.equal(meta.logistics.air_conditioning, true);
  assert.equal(meta.logistics.natural_light, true);
});

test("normalizer maps rating, photos, station and contacts", () => {
  const entry = normalize();
  assert.equal(entry.rating.value, 4.7);
  assert.equal(entry.rating.review_count, 588);
  assert.equal(entry.rating.source, "tagvenue");
  assert.equal(entry.photos.main_image, "https://example.com/main.jpg");
  assert.ok(entry.photos.gallery.includes("https://example.com/main.jpg"));
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
  assert.equal(entry.confidence, 0.82);
});
