import fs from "node:fs";
import { createLogger } from "./output/logger.js";
import { createHttpFetcher } from "./fetchers/http.js";
import { createRobotsChecker } from "./fetchers/robots.js";
import { discoverUrls } from "./discovery/sitemap.js";
import { extractTagvenueRecord } from "./providers/tagvenue/extractor.js";
import { normalizeTagvenueToCanonical } from "./providers/tagvenue/normalizer.js";
import { createConcurrencyQueue } from "./utils/concurrency.js";
import { createRateLimiter } from "./utils/rate-limit.js";
import { writeJsonAtomic } from "./output/json-writer.js";

// Minimum bytes a real Tagvenue room detail page should have.
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

  logger.info("mc-ingest-tagvenue-scraper starting", {
    mode: config.mode,
    city: config.city ?? null,
    country: config.country ?? null,
    limit: config.limit,
    outputPath: config.outputPath,
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
  // in-flight, write partial results, and exit cleanly instead of crashing.
  let aborted = false;
  const abortController = new AbortController();

  function handleShutdownSignal(signal) {
    if (aborted) return;
    aborted = true;
    logger.warn(`${signal} received — draining in-flight requests, will write partial results…`);
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

  logger.info(`discovery returned ${discovered.length} room URL(s)`);

  // ── Dry-run branch ───────────────────────────────────────────────────────────
  if (config.dryRun) {
    logger.info("dry-run mode — skipping detail pass, writing URL list");
    const dryRunOutput = buildOutputEnvelope({
      config,
      startedAt,
      finishedAt: now(),
      discovered,
      records: [],
      failures: [],
      dryRun: true,
      dryRunUrls: discovered.map((url, idx) => ({ index: idx + 1, url })),
    });
    const write = writeJsonAtomic({
      outputDir: config.outputDir,
      outputFile: config.outputFile,
      data: dryRunOutput,
    });
    logger.info("dry-run output written", {
      outputPath: write.outputPath,
      bytes: write.sizeBytes,
    });
    removeShutdownHandlers();
    return {
      status: "dry-run",
      discovered,
      records: [],
      failures: [],
      outputPath: write.outputPath,
    };
  }

  // ── Empty-discovery branch ───────────────────────────────────────────────────
  if (!discovered.length) {
    logger.warn("no URLs found; writing empty output");
    const emptyOutput = buildOutputEnvelope({
      config,
      startedAt,
      finishedAt: now(),
      discovered: [],
      records: [],
      failures: [],
      dryRun: false,
    });
    const write = writeJsonAtomic({
      outputDir: config.outputDir,
      outputFile: config.outputFile,
      data: emptyOutput,
    });
    removeShutdownHandlers();
    return {
      status: "empty-discovery",
      discovered: [],
      records: [],
      failures: [],
      outputPath: write.outputPath,
    };
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

  // Pre-allocate result slots to preserve input order in the output.
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

      itemLogger.info("ok", {
        name: (normalized.name || "").slice(0, 60),
        confidence: normalized.confidence,
        size: html.length,
        ms: fetchMs,
      });

      return { ok: true, url: res.url || url, normalized };
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

  // Separate ok records from failures, preserving input order.
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
  const totalMs = finishedAt - startedAt;

  const output = buildOutputEnvelope({
    config,
    startedAt,
    finishedAt,
    discovered,
    records,
    failures,
    dryRun: false,
  });

  const writeResult = writeJsonAtomic({
    outputDir: config.outputDir,
    outputFile: config.outputFile,
    data: output,
  });

  logger.info("detail extraction complete", {
    duration_ms: totalMs,
    discovered: discovered.length,
    ok: records.length,
    fail: failures.length,
    ok_rate: output.stats.ok_rate + "%",
    avg_confidence: output.stats.avg_confidence,
    output: writeResult.outputPath,
    bytes: writeResult.sizeBytes,
    aborted,
  });

  removeShutdownHandlers();

  return {
    status: aborted ? "partial" : "ok",
    discovered,
    records,
    failures,
    outputPath: writeResult.outputPath,
    stats: output.stats,
  };

  // ── Signal handler cleanup ──────────────────────────────────────────────────
  function removeShutdownHandlers() {
    process.off("SIGINT", handleShutdownSignal);
    process.off("SIGTERM", handleShutdownSignal);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the canonical output envelope written to disk.
 * Always has the same top-level shape regardless of dry-run / partial / full run.
 */
function buildOutputEnvelope({ config, startedAt, finishedAt, discovered, records, failures, dryRun, dryRunUrls }) {
  const totalMs = finishedAt - startedAt;
  return {
    _schema_version: 1,
    run: {
      at: finishedAt.toISOString(),
      started_at: startedAt.toISOString(),
      duration_ms: totalMs,
      mode: config.mode,
      city: config.city ?? null,
      country: config.country ?? null,
      limit_requested: config.limit || 0,
      limit_effective: discovered.length,
      concurrency: config.concurrency,
      fetcher: "http",
      browser_mode: !!config.browser,
      dry_run: !!dryRun,
    },
    stats: {
      discovered: discovered.length,
      records_ok: records.length,
      records_fail: failures.length,
      ok_rate: discovered.length ? +((records.length / discovered.length) * 100).toFixed(2) : 0,
      avg_confidence:
        records.length
          ? +(records.reduce((a, r) => a + (r.confidence || 0), 0) / records.length).toFixed(3)
          : 0,
      fields_coverage: aggregateCoverage(records),
    },
    failures: failures.slice(0, 500),
    // In dry-run mode, items holds the URL index list instead of canonical records.
    items: dryRun ? (dryRunUrls ?? []) : records,
  };
}

/**
 * Compute per-field presence coverage as percentages across all canonical records.
 * Returns an object where each value is 0–100 (one decimal place).
 */
function aggregateCoverage(records) {
  const total = records.length || 1;
  const c = {
    name: 0,
    address: 0,
    location: 0,
    latlng: 0,
    rating: 0,
    capacity_max: 0,
    capacity_configs: 0,
    amenities_any: 0,
    restrictions_any: 0,
    photos_any: 0,
    price_hint: 0,
    venue_type: 0,
    contacts_any: 0,
    description: 0,
    av_wifi: 0,
  };

  for (const r of records) {
    if (r.name) c.name++;
    if (r.address) c.address++;
    if (r.location) c.location++;
    if (r.location?.lat != null && r.location?.lng != null) c.latlng++;
    if (r.rating) c.rating++;
    if (r.metadata?.capacity?.max_total) c.capacity_max++;
    if (r.metadata?.capacity?.configurations && Object.keys(r.metadata.capacity.configurations).length) c.capacity_configs++;
    if (r.metadata?.amenities?.length) c.amenities_any++;
    if (r.metadata?.restrictions?.length) c.restrictions_any++;
    if (r.photos?.gallery?.length || r.photos?.main_image) c.photos_any++;
    if (r.metadata?.pricing?.price_range_hint) c.price_hint++;
    if (r.metadata?.venue_type?.length) c.venue_type++;
    if (r.metadata?.contacts?.length || r.company) c.contacts_any++;
    if (r.description) c.description++;
    if (r.metadata?.av_tech?.wifi) c.av_wifi++;
  }

  const out = {};
  for (const key of Object.keys(c)) {
    out[key] = +((c[key] / total) * 100).toFixed(1);
  }
  return out;
}
