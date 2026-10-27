import fs from "node:fs";
import path from "node:path";
import { createLogger } from "./output/logger.js";
import { createHttpFetcher } from "./fetchers/http.js";
import { createRobotsChecker } from "./fetchers/robots.js";
import { discoverUrls } from "./discovery/sitemap.js";
import { extractTagvenueRecord } from "./providers/tagvenue/extractor.js";
import { normalizeTagvenueToCanonical } from "./providers/tagvenue/normalizer.js";
import { createConcurrencyQueue } from "./utils/concurrency.js";
import { createRateLimiter } from "./utils/rate-limit.js";
import {
  VENUE_RECORD_FILE,
  downloadVenueAssets,
  ensureIngestRoot,
  venueDirFor,
  venueDirName,
  writeJsonFile,
} from "./output/venue-store.js";

// Minimum bytes a real Tagvenue detail page should have.
// Pages below this threshold are typically captcha walls, empty redirects, or error pages.
// We warn rather than hard-fail — the confidence score will be low and the record is kept.
const MIN_HTML_BYTES = 30_000;

// Keywords that strongly indicate a bot-challenge page even when it's large.
const BOT_CHALLENGE_RE =
  /(<title>[^<]*(?:access denied|just a moment|checking your browser|ddos-guard|403 forbidden)[^<]*<\/title>|cf-mitigated|ray id:|__cf_chl_)/i;

// How often (in processed URLs) to emit an INFO-level progress line.
const PROGRESS_EVERY = 10;

export async function run(config, { fsModule = fs, now = () => new Date() } = {}) {
  const startedAt = now();
  const logger = createLogger({
    level: config.logLevel,
    tag: "run",
    logFile: config.logFile,
    fs: fsModule,
    outputDir: config.outputDir,
  });

  // Everything lands under <outputDir>/mc-ingest/<tagvenue-id>/, so the host only
  // has to mount one directory and the layout is the same on every run. The tree
  // is created world-writable so other containers can read and write it.
  const rootDir = ensureIngestRoot(config.outputDir);

  logger.info("docintelligence-mc-ingest-tagvenue-scraper starting", {
    mode: config.mode,
    city: config.city ?? null,
    country: config.country ?? null,
    limit: config.limit,
    rootDir,
    browser: config.browser,
    dryRun: config.dryRun,
    concurrency: config.concurrency,
    proxy: !!config.proxy,
  });

  if (config.browser) {
    logger.warn(
      "Browser mode (Playwright) requested but HTTP fetcher (SSR) used in MVP. " +
        "Browser support will be enabled in a later release.",
    );
  }

  // ── Infrastructure ──────────────────────────────────────────────────────────
  const http = createHttpFetcher({
    userAgent: config.userAgent,
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    proxy: config.proxy,
  });

  const robots = createRobotsChecker({
    http,
    sitemapBase: "https://www.tagvenue.com",
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────────
  // On SIGINT / SIGTERM we stop accepting new work, flush whatever is already
  // in-flight, and exit cleanly instead of crashing. Venues already written stay
  // on disk, so an interrupted run is safe to repeat.
  let aborted = false;
  const abortController = new AbortController();

  function handleShutdownSignal(signal) {
    if (aborted) return;
    aborted = true;
    logger.warn(`${signal} received — draining in-flight requests…`);
    abortController.abort();
  }

  process.once("SIGINT", () => handleShutdownSignal("SIGINT"));
  process.once("SIGTERM", () => handleShutdownSignal("SIGTERM"));

  // ── Discovery pass ───────────────────────────────────────────────────────────
  let discovered;
  try {
    discovered = await discoverUrls({
      mode: config.mode,
      http,
      robots,
      config,
      logger: logger.child("discovery"),
    });
  } catch (err) {
    logger.error("discovery failed", { error: String(err.message || err) });
    throw err;
  }

  logger.info(`discovery returned ${discovered.length} venue URL(s)`);

  // ── Dry-run branch ───────────────────────────────────────────────────────────
  if (config.dryRun) {
    logger.info("dry-run mode — skipping detail pass, nothing written", {
      urls: discovered.length,
    });
    for (const url of discovered) logger.info(url);
    removeShutdownHandlers();
    return { status: "dry-run", rootDir, discovered, records: [], failures: [] };
  }

  // ── Empty-discovery branch ───────────────────────────────────────────────────
  if (!discovered.length) {
    logger.warn("no URLs found; nothing to store", { rootDir });
    removeShutdownHandlers();
    return { status: "empty-discovery", rootDir, discovered: [], records: [], failures: [] };
  }

  // ── Detail pass ──────────────────────────────────────────────────────────────
  const detailLogger = logger.child("detail");

  const limiter = createRateLimiter({
    requestsPerSecond: 1 / Math.max(0.001, (config.minDelayMs || 600) / 1000),
    burstSize: Math.max(1, config.concurrency),
    minDelayMs: config.minDelayMs || 0,
    jitterMs: config.jitterMs || 0,
  });

  const queue = createConcurrencyQueue({
    concurrency: config.concurrency,
    logger: detailLogger,
    tag: "detail-q",
  });

  const assetTotals = { downloaded: 0, skipped: 0, failed: 0 };
  const resultSlots = new Array(discovered.length).fill(null);
  let processed = 0;

  const throttledWorker = limiter.wrap(async (url, idx) => {
    if (aborted && abortController.signal.aborted) {
      return { ok: false, url, error: "aborted" };
    }

    const itemLogger = detailLogger.child(`#${idx + 1}`);

    try {
      const fetchStarted = Date.now();
      const res = await http.text(url, {
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        signal: abortController.signal,
      });
      const fetchMs = Date.now() - fetchStarted;

      if (res.status !== 200) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { httpStatus: res.status });
      }

      const html = res.body;

      // Size heuristic: warn on thin pages but continue — let confidence score reflect quality.
      if (html.length < MIN_HTML_BYTES) {
        itemLogger.warn(`thin page (${html.length} bytes) — may be a redirect or error page`, {
          url,
        });
      }

      // Bot-challenge detection: if the response looks like a captcha wall, fail fast.
      if (BOT_CHALLENGE_RE.test(html)) {
        throw new Error(`bot-challenge detected (${html.length} bytes)`);
      }

      const raw = extractTagvenueRecord({ url: res.url || url, html, logger: itemLogger });
      raw._scrape.duration_ms = fetchMs;
      raw._scrape.http_status = res.status;

      const normalized = normalizeTagvenueToCanonical(raw, now());

      const venueId = normalized.tagvenue_ids?.venue_id ?? null;
      if (venueId == null) {
        throw new Error("no venue id in URL — cannot derive a venue folder");
      }

      const venueDir = venueDirFor(rootDir, venueId);
      const assets = normalized.photos?.gallery ?? [];
      const assetStats = await downloadVenueAssets({
        http,
        venueDir,
        assets,
        ingestDir: rootDir,
        logger: itemLogger,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        signal: abortController.signal,
      });
      const write = writeJsonFile(
        path.posix.join(venueDir, VENUE_RECORD_FILE),
        normalized,
        2,
        rootDir,
      );

      itemLogger.info("stored", {
        venue: venueDirName(venueId),
        name: (normalized.name || "").slice(0, 60),
        confidence: normalized.confidence,
        assets: `${assetStats.downloaded} new / ${assetStats.skipped} existing / ${assetStats.failed} failed`,
        bytes: write.sizeBytes,
        ms: fetchMs,
      });

      return { ok: true, url: res.url || url, normalized, assetStats };
    } catch (err) {
      if (abortController.signal.aborted && err.name === "CanceledError") {
        return { ok: false, url, error: "aborted" };
      }
      const msg = String(err.message || err).slice(0, 300);
      itemLogger.warn("FAIL: " + msg);
      return { ok: false, url, error: msg };
    }
  });

  // Enqueue all URLs; results land in the pre-allocated slots.
  for (let i = 0; i < discovered.length; i++) {
    if (aborted) break;
    const url = discovered[i];
    const idx = i;

    queue
      .add(() => throttledWorker(url, idx), { url })
      .then((result) => {
        resultSlots[idx] = result;
        processed++;

        if (result?.assetStats) {
          assetTotals.downloaded += result.assetStats.downloaded;
          assetTotals.skipped += result.assetStats.skipped;
          assetTotals.failed += result.assetStats.failed;
        }

        if (processed % PROGRESS_EVERY === 0 || processed === discovered.length) {
          const okSoFar = resultSlots.filter((r) => r?.ok).length;
          logger.info("progress", {
            processed,
            total: discovered.length,
            ok: okSoFar,
            fail: processed - okSoFar,
            pct: +((processed / discovered.length) * 100).toFixed(1),
          });
        }
      })
      .catch((err) => {
        // queue.add re-throws on uncaught errors inside the worker.
        // This should not happen given our inner try/catch, but guard anyway.
        resultSlots[idx] = { ok: false, url, error: String(err.message || err).slice(0, 300) };
        processed++;
      });
  }

  await queue.onIdle();

  // Separate stored venues from failures, preserving input order.
  const records = [];
  const failures = [];

  for (const slot of resultSlots) {
    if (!slot) continue; // aborted before enqueued
    if (slot.ok) {
      records.push(slot.normalized);
    } else if (slot.error !== "aborted") {
      failures.push({ url: slot.url, error: slot.error });
    }
  }

  const finishedAt = now();
  const totalMs = finishedAt.getTime() - startedAt.getTime();

  logger.info("detail extraction complete", {
    duration_ms: totalMs,
    discovered: discovered.length,
    stored: records.length,
    fail: failures.length,
    assets: `${assetTotals.downloaded} new / ${assetTotals.skipped} existing / ${assetTotals.failed} failed`,
    root: rootDir,
    aborted,
  });

  removeShutdownHandlers();

  return {
    status: aborted ? "partial" : "ok",
    rootDir,
    discovered,
    records,
    failures,
    stats: {
      discovered: discovered.length,
      stored: records.length,
      failed: failures.length,
      assets_downloaded: assetTotals.downloaded,
      assets_skipped: assetTotals.skipped,
      assets_failed: assetTotals.failed,
      duration_ms: totalMs,
    },
  };

  // ── Signal handler cleanup ──────────────────────────────────────────────────
  function removeShutdownHandlers() {
    process.off("SIGINT", handleShutdownSignal);
    process.off("SIGTERM", handleShutdownSignal);
  }
}
