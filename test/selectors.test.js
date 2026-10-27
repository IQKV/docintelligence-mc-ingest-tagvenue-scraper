import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRoomUrl,
  parseVenueUrl,
  ROOM_URL_RE,
  findFirstLdByType,
  findAllLdByType,
  ldAdditionalPropertyMap,
  ldBlocksFromHtml,
} from "../src/providers/tagvenue/selectors.js";

const ROOM_URL =
  "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space";

test("parseRoomUrl extracts city, room id and slugs", () => {
  const parsed = parseRoomUrl(ROOM_URL);
  assert.equal(parsed.city, "london");
  assert.equal(parsed.room_id, 25426);
  assert.equal(parsed.venue_slug, "the-last-talisman");
  assert.equal(parsed.room_slug, "mala-madre-events-space");
});

test("parseRoomUrl strips query string and fragment", () => {
  assert.equal(parseRoomUrl(`${ROOM_URL}?page=2#gallery`).url, ROOM_URL);
});

test("parseRoomUrl rejects non-room URLs", () => {
  assert.equal(
    parseRoomUrl("https://www.tagvenue.com/venues/london/11896/the-last-talisman"),
    null,
  );
  assert.equal(ROOM_URL_RE.test("https://www.tagvenue.com/venues/london/11896/x"), false);
});

test("parseVenueUrl extracts venue id and city", () => {
  const parsed = parseVenueUrl("https://www.tagvenue.com/venues/london/11896/the-last-talisman");
  assert.equal(parsed.venue_id, 11896);
  assert.equal(parsed.city, "london");
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
