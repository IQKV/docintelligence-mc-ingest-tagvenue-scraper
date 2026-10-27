import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASSETS_DIR_NAME,
  VENUE_RECORD_FILE,
  downloadVenueAssets,
  ingestRoot,
  venueDirFor,
  venueDirName,
  writeJsonFile,
} from "../src/output/venue-store.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "venue-store-"));
}

test("the ingest root and venue folder names are predictable", () => {
  assert.equal(ingestRoot("/data"), "/data/mc-ingest");
  assert.equal(ingestRoot("/data/"), "/data/mc-ingest");
  assert.equal(venueDirName(11896), "tagvenue-11896");
  assert.equal(venueDirFor("/data/mc-ingest", 11896), "/data/mc-ingest/tagvenue-11896");
});

test("writeJsonFile creates the venue folder and overwrites in place", () => {
  const root = tmpRoot();
  const file = path.posix.join(venueDirFor(root, 7), VENUE_RECORD_FILE);

  writeJsonFile(file, { external_id: "tagvenue:venue:7", name: "first" });
  writeJsonFile(file, { external_id: "tagvenue:venue:7", name: "second" });

  assert.deepEqual(fs.readdirSync(path.posix.join(root, "tagvenue-7")), [VENUE_RECORD_FILE]);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).name, "second");
  fs.rmSync(root, { recursive: true, force: true });
});

test("downloadVenueAssets writes each photo once and skips what is already there", async () => {
  const root = tmpRoot();
  const requests = [];
  const http = {
    buffer: async (url) => {
      requests.push(url);
      return { url, status: 200, buffer: Buffer.from(url) };
    },
  };
  const assets = [
    { file: "a.jpg", url: "https://cdn.test/a.jpg", transform: "widen-1680-noupsize" },
    { file: "b.jpg", url: "https://cdn.test/b.jpg", transform: "widen-1680-noupsize" },
  ];
  const venueDir = venueDirFor(root, 7);

  assert.deepEqual(await downloadVenueAssets({ http, venueDir, assets }), {
    downloaded: 2,
    skipped: 0,
    failed: 0,
  });
  assert.deepEqual(fs.readdirSync(path.posix.join(venueDir, ASSETS_DIR_NAME)).sort(), [
    "a.jpg",
    "b.jpg",
  ]);

  // Second run: same names, nothing re-fetched, nothing duplicated.
  assert.deepEqual(await downloadVenueAssets({ http, venueDir, assets }), {
    downloaded: 0,
    skipped: 2,
    failed: 0,
  });
  assert.equal(requests.length, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("downloadVenueAssets counts a failed photo without dropping the venue", async () => {
  const root = tmpRoot();
  const http = { buffer: async (url) => ({ url, status: 404, buffer: Buffer.alloc(0) }) };

  const stats = await downloadVenueAssets({
    http,
    venueDir: venueDirFor(root, 7),
    assets: [{ file: "a.jpg", url: "https://cdn.test/a.jpg", transform: "fit-600-400" }],
  });

  assert.deepEqual(stats, { downloaded: 0, skipped: 0, failed: 1 });
  fs.rmSync(root, { recursive: true, force: true });
});
