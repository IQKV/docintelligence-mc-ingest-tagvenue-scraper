import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanText,
  detectCurrency,
  parseNumericValueFromString,
  parsePercent,
  parseMinutes,
  parseDistanceMilesOrKm,
  normalizeCountryCode,
  fullAddressFromPostalAddress,
  slugify,
  uniqueStrings,
  truncate,
  classifyAmenities,
  classifyRestrictions,
  parseCapacityConfigs,
  parseCuisines,
  inferVenueTypes,
} from "../src/utils/normalize.js";

test("detectCurrency resolves symbols and ISO codes", () => {
  assert.equal(detectCurrency("from £10 per person"), "GBP");
  assert.equal(detectCurrency("€45 per person"), "EUR");
  assert.equal(detectCurrency("100 EUR per day"), "EUR");
  assert.equal(detectCurrency("no price here"), null);
});

test("parseNumericValueFromString keeps the largest number", () => {
  assert.equal(parseNumericValueFromString("from £10 per person"), 10);
  assert.equal(parseNumericValueFromString("£1,200 minimum"), 1200);
  assert.equal(parseNumericValueFromString("no digits"), null);
});

test("parsePercent normalises to a 0..1 ratio", () => {
  assert.equal(parsePercent("99.91%"), 0.9991);
  assert.equal(parsePercent("0.5"), 0.5);
});

test("parseMinutes understands minute and hour wording", () => {
  assert.equal(parseMinutes("39 min"), 39);
  assert.equal(parseMinutes("within 2 hours"), 120);
});

test("parseDistanceMilesOrKm converts km to miles", () => {
  assert.equal(parseDistanceMilesOrKm("0.5 miles"), 0.5);
  assert.equal(parseDistanceMilesOrKm("1 km"), 0.62);
});

test("normalizeCountryCode folds UK into GB and rejects junk", () => {
  assert.equal(normalizeCountryCode("UK"), "GB");
  assert.equal(normalizeCountryCode("gb"), "GB");
  assert.equal(normalizeCountryCode("United Kingdom"), null);
});

test("small string helpers behave", () => {
  assert.equal(cleanText("  a   b "), "a b");
  assert.equal(cleanText("   "), null);
  assert.equal(slugify("New York"), "new-york");
  assert.deepEqual(uniqueStrings(["a", "A", "b"]), ["a", "b"]);
  assert.equal(truncate("abcdef", 3), "abc…");
});

test("fullAddressFromPostalAddress joins the present parts", () => {
  assert.equal(
    fullAddressFromPostalAddress({
      streetAddress: "171-173 Bermondsey Street",
      addressLocality: "London",
      postalCode: "SE1 3UW",
      addressCountry: "GB",
    }),
    "171-173 Bermondsey Street, London, SE1 3UW, GB",
  );
  assert.equal(fullAddressFromPostalAddress(null), null);
});

test("classifyAmenities buckets AV, logistics and catering features", () => {
  const buckets = classifyAmenities(["Wi-Fi", "Projector", "Flatscreen TV", "Air conditioner"]);
  assert.equal(buckets.av_tech.wifi, true);
  assert.equal(buckets.av_tech.projector, true);
  assert.equal(buckets.av_tech.screens, 1);
  assert.equal(buckets.av_tech.flatscreen_tv, true);
  assert.equal(buckets.logistics.air_conditioning, true);
  assert.equal(buckets.raw.length, 4);
});

test("classifyRestrictions maps rules to canonical phrases", () => {
  assert.deepEqual(classifyRestrictions(["No smoking in the building"]), [
    "No smoking in the building",
  ]);
  assert.deepEqual(classifyRestrictions(["Something unrelated"]), []);
});

test("parseCapacityConfigs maps labelled rows to configuration keys", () => {
  const capacity = parseCapacityConfigs({
    maximumAttendeeCapacity: 90,
    additionalProps: { Standing: "90", Banquet: "60", Theatre: "40" },
    specRows: [{ key: "Minimum attendees", value: "30" }],
  });
  assert.equal(capacity.max_total, 90);
  assert.equal(capacity.configurations.standing, 90);
  assert.equal(capacity.configurations.banquet, 60);
  assert.equal(capacity.configurations.theater, 40);
  assert.equal(capacity.min_attendees_per_event, 30);
});

test("parseCuisines and inferVenueTypes read free text", () => {
  assert.deepEqual(parseCuisines(["Asian cuisine", "Vegan options"]).sort(), ["asian", "vegan"]);
  assert.deepEqual(inferVenueTypes({ ldTypes: ["EventVenue"], ldName: "Boutique Hotel Blue" }), [
    "hotel",
  ]);
});
