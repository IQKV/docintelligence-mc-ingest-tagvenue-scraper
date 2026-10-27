import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./json-writer.js";

// Root folder created under the configured output dir on every start. All
// venues live below it, each in its own record folder.
export const INGEST_ROOT_NAME = "mc-ingest";

// Record folder name: provider prefix + the provider's own venue id. The id is
// stable across runs and unique per venue, so a re-scrape rewrites the very same
// folder instead of adding a dated copy next to it.
export const VENUE_DIR_PREFIX = "tagvenue-";

export const VENUE_RECORD_FILE = "venue.json";
export const ASSETS_DIR_NAME = "assets";

/** `<outputDir>/mc-ingest` — the single tree the scraper owns. */
export function ingestRoot(outputDir) {
  return path.posix.join(String(outputDir ?? ".").replace(/\/+$/, ""), INGEST_ROOT_NAME);
}

/** `tagvenue-<venue_id>` — the per-venue folder name. */
export function venueDirName(venueId) {
  return `${VENUE_DIR_PREFIX}${venueId}`;
}

/** Absolute path of a venue's record folder inside the ingest root. */
export function venueDirFor(rootDir, venueId) {
  return path.posix.join(String(rootDir).replace(/\/+$/, ""), venueDirName(venueId));
}

/** Writes JSON via tmp-file + rename so a crash never leaves a half-written record. */
export function writeJsonFile(filePath, data, pretty = 2) {
  ensureDir(path.posix.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(data, null, pretty);
  fs.writeFileSync(tmpPath, json, "utf8");
  fs.renameSync(tmpPath, filePath);
  return { filePath, sizeBytes: Buffer.byteLength(json, "utf8") };
}

/**
 * Downloads a venue's photo assets into `<venueDir>/assets/<file>`.
 *
 * Asset names come from the photo key (see `pickPhotoVariants`), never from the
 * variant the page happened to cite, so the same photo always maps to the same
 * path. Files already on disk are left alone — that is what stops repeated runs
 * from duplicating assets.
 *
 * @param {{
 *   http: { buffer: (url: string, options?: object) => Promise<{ status: number, buffer: Buffer }> },
 *   venueDir: string,
 *   assets: Array<{ file: string, url: string, transform: string }>,
 *   logger?: { warn?: (msg: string, meta?: Record<string, unknown>) => void } | null,
 *   timeoutMs?: number,
 *   retries?: number,
 *   signal?: AbortSignal | null,
 * }} options
 */
export async function downloadVenueAssets(options) {
  const { http, venueDir, assets, logger = null, timeoutMs, retries, signal } = options;
  const stats = { downloaded: 0, skipped: 0, failed: 0 };
  if (!assets?.length) return stats;

  const assetsDir = ensureDir(path.posix.join(venueDir, ASSETS_DIR_NAME));

  for (const asset of assets) {
    const target = path.posix.join(assetsDir, asset.file);
    if (fs.existsSync(target)) {
      stats.skipped++;
      continue;
    }
    try {
      const res = await http.buffer(asset.url, { timeoutMs, retries, signal });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(target, res.buffer);
      stats.downloaded++;
    } catch (err) {
      stats.failed++;
      logger?.warn?.(`asset download failed: ${asset.file}`, {
        error: String(err?.message ?? err).slice(0, 200),
      });
    }
  }

  return stats;
}
