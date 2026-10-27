import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTagvenueRecord } from "../src/providers/tagvenue/extractor.js";

const ROOM_URL =
  "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space";

const HTML = readFileSync(new URL("./fixtures/tagvenue-room.html", import.meta.url), "utf8");

function extract() {
  return extractTagvenueRecord({ url: ROOM_URL, html: HTML });
}

test("extractor reads the schema.org EventVenue block", () => {
  const raw = extract();
  assert.equal(raw.ld["@type"], "EventVenue");
  assert.equal(raw.ld.name, "Mala Madre Events Space at The Last Talisman");
  assert.equal(raw.ld.address.addressLocality, "London");
  assert.equal(raw.ld.geo.latitude, 51.499067);
  assert.equal(raw.ld.maximumAttendeeCapacity, 90);
  assert.deepEqual(raw.ld.additionalProperty, {
    Standing: "90",
    Banquet: "60",
    Theatre: "40",
  });
});

test("extractor reads breadcrumb and aggregate review data", () => {
  const raw = extract();
  assert.equal(raw.breadcrumb.items.length, 5);
  assert.equal(raw.breadcrumb.items[2].name, "Restaurants");
  assert.equal(raw.dom.ld_aggregate_rating.rating_value, 4.7);
  assert.equal(raw.dom.ld_aggregate_rating.review_count, 588);
});

test("extractor reads the DOM fallbacks", () => {
  const raw = extract();
  assert.equal(raw.dom.h1_name, "Mala Madre Events Space at The Last Talisman");
  assert.ok(raw.dom.features_list.includes("Wi-Fi"));
  assert.equal(raw.dom.nearest_station_name, "London Bridge Station");
  assert.equal(raw.dom.nearest_station_distance, "0.5 miles");
  assert.equal(raw.dom.host_name, "Dovile S.");
});

test("extractor merges ld and dom reviews", () => {
  const raw = extract();
  assert.equal(raw.dom.reviews.length, 1);
  assert.equal(raw.dom.reviews[0].author, "Luisa P.");
  assert.equal(raw.dom.reviews[0].rating, 4.8);
  assert.equal(raw.dom.reviews[0].text, "Amazing space!");
});

test("extractor reports scrape metadata and a confidence score", () => {
  const raw = extract();
  assert.equal(raw.parsed_url.room_id, 25426);
  assert.equal(raw._scrape.has_json_ld, true);
  assert.equal(raw._scrape.json_ld_blocks, 3);
  assert.equal(raw._scrape.fetcher, "http");
  assert.ok(raw._scrape.confidence > 0.5, `expected > 0.5, got ${raw._scrape.confidence}`);
});

test("extractor degrades gracefully on an empty document", () => {
  const raw = extractTagvenueRecord({ url: ROOM_URL, html: "<html><body></body></html>" });
  assert.equal(raw.ld, null);
  assert.equal(raw._scrape.has_json_ld, false);
  assert.deepEqual(raw.dom.features_list, []);
  assert.equal(raw.parsed_url.room_id, 25426);
});
