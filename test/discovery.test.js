import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverUrls } from "../src/discovery/sitemap.js";
import {
  VENUE_RECORD_FILE,
  ingestRoot,
  venueDirFor,
  writeJsonFile,
} from "../src/output/venue-store.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "discovery-"));
}

function venueUrl(venueId, city = "london") {
  return `https://www.tagvenue.com/venues/${city}/${venueId}/some-venue`;
}

/** Writes a urls-file listing the given venue ids and returns a config for it. */
function configFor(root, venueIds, overrides = {}) {
  const urlsFile = path.join(root, "urls.txt");
  fs.writeFileSync(urlsFile, venueIds.map((id) => venueUrl(id)).join("\n"), "utf8");
  return {
    urlsFile,
    ingestDir: ingestRoot(root),
    city: null,
    limit: 0,
    skipExisting: false,
    ...overrides,
  };
}

function storeVenue(root, venueId) {
  const ingestDir = ingestRoot(root);
  writeJsonFile(path.posix.join(venueDirFor(ingestDir, venueId), VENUE_RECORD_FILE), {
    external_id: `tagvenue:venue:${venueId}`,
  });
}

test("limit slices the head of the list when skip-existing is off", async () => {
  const root = tmpRoot();
  const urls = await discoverUrls({
    mode: "urls-file",
    config: configFor(root, [10, 11, 12], { limit: 2 }),
  });

  assert.deepEqual(urls, [venueUrl(10), venueUrl(11)]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skip-existing filters stored venues out before the limit is applied", async () => {
  const root = tmpRoot();
  storeVenue(root, 10);
  storeVenue(root, 11);

  // 10 and 11 are on disk, so the first two *remaining* venues are 12 and 13.
  // Filter-then-slice gives 12+13; slice-then-filter would give only 12.
  const urls = await discoverUrls({
    mode: "urls-file",
    config: configFor(root, [10, 11, 12, 13, 14], { limit: 2, skipExisting: true }),
  });

  assert.deepEqual(urls, [venueUrl(12), venueUrl(13)]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("skip-existing takes everything left when nothing caps the run", async () => {
  const root = tmpRoot();
  storeVenue(root, 12);

  const urls = await discoverUrls({
    mode: "urls-file",
    config: configFor(root, [10, 11, 12], { limit: 0, skipExisting: true }),
  });

  assert.deepEqual(urls, [venueUrl(10), venueUrl(11)]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a fully stored catalog discovers nothing to do", async () => {
  const root = tmpRoot();
  storeVenue(root, 10);
  storeVenue(root, 11);

  const urls = await discoverUrls({
    mode: "urls-file",
    config: configFor(root, [10, 11], { limit: 500, skipExisting: true }),
  });

  assert.deepEqual(urls, []);
  fs.rmSync(root, { recursive: true, force: true });
});
