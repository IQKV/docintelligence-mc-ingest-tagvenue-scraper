import test from "node:test";
import assert from "node:assert/strict";
import {
  parseVenueUrl,
  VENUE_URL_RE,
  parsePhotoUrl,
  pickPhotoVariants,
  findFirstLdByType,
  findAllLdByType,
  ldAdditionalPropertyMap,
  ldBlocksFromHtml,
} from "../src/providers/tagvenue/selectors.js";

const VENUE_URL = "https://www.tagvenue.com/venues/london/11896/the-last-talisman";

const ROOM_URL =
  "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space";

test("parseVenueUrl extracts city, venue id and slug", () => {
  const parsed = parseVenueUrl(VENUE_URL);
  assert.equal(parsed.city, "london");
  assert.equal(parsed.venue_id, 11896);
  assert.equal(parsed.venue_slug, "the-last-talisman");
});

test("parseVenueUrl strips query string and fragment", () => {
  assert.equal(parseVenueUrl(`${VENUE_URL}?page=2#gallery`).url, VENUE_URL);
});

test("parseVenueUrl rejects non-venue URLs", () => {
  assert.equal(parseVenueUrl(ROOM_URL), null);
  assert.equal(VENUE_URL_RE.test(ROOM_URL), false);
});

test("parsePhotoUrl derives a variant-stable asset file name", () => {
  const photo = parsePhotoUrl(
    "https://www.tagvenue.com/resize/14/2f/fit-900-600;7-the-royal-horseguards-venue.jpg",
  );
  assert.equal(photo.file, "7-the-royal-horseguards-venue.jpg");
  assert.equal(photo.transform, "fit-900-600");
  assert.equal(
    photo.url,
    "https://www.tagvenue.com/resize/14/2f/fit-900-600;7-the-royal-horseguards-venue.jpg",
  );
});

test("parsePhotoUrl absolutises relative photo paths and ignores site chrome", () => {
  assert.equal(
    parsePhotoUrl("/resize/ab/cd/widen-1680-noupsize;5-gladstone-library-room.jpg").url,
    "https://www.tagvenue.com/resize/ab/cd/widen-1680-noupsize;5-gladstone-library-room.jpg",
  );
  assert.equal(parsePhotoUrl("https://static.tagvenue.com/img/logo.png"), null);
});

test("pickPhotoVariants keeps one entry per photo, preferring the widest variant", () => {
  const assets = pickPhotoVariants([
    "https://www.tagvenue.com/resize/14/2f/fit-900-600;7-the-royal-horseguards-venue.jpg",
    "https://www.tagvenue.com/resize/14/2f/widen-1680-noupsize;7-the-royal-horseguards-venue.jpg",
    "https://www.tagvenue.com/resize/ab/cd/fit-600-400;5-gladstone-library-room.jpg",
    "https://static.tagvenue.com/img/logo.png",
  ]);
  assert.deepEqual(
    assets.map((a) => [a.file, a.transform]),
    [
      ["7-the-royal-horseguards-venue.jpg", "widen-1680-noupsize"],
      ["5-gladstone-library-room.jpg", "fit-600-400"],
    ],
  );
});

test("ldBlocksFromHtml parses every ld+json block", () => {
  const html = `<script type="application/ld+json">{"@type":"Place","name":"A"}</script>
    <script type="application/ld+json">[{"@type":"Review"},{"@type":"Review"}]</script>`;
  const blocks = ldBlocksFromHtml(html);
  assert.equal(blocks.length, 3);
  assert.equal(findFirstLdByType(blocks, "Place").name, "A");
  assert.equal(findAllLdByType(blocks, "Review").length, 2);
});

test("ldBlocksFromHtml ignores malformed JSON", () => {
  assert.deepEqual(ldBlocksFromHtml('<script type="application/ld+json">{oops</script>'), []);
});

test("ldAdditionalPropertyMap flattens name/value pairs", () => {
  const map = ldAdditionalPropertyMap({
    additionalProperty: [
      { name: "Standing", value: "90" },
      { name: "Banquet", value: "60" },
    ],
  });
  assert.deepEqual(map, { Standing: "90", Banquet: "60" });
});
