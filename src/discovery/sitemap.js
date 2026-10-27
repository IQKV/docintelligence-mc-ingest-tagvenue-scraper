/**
 * sitemap.js — URL discovery for the Tagvenue scraper.
 *
 * Discovery pipeline (sitemap mode):
 *
 *   1. robots.txt  → look for a Sitemap: directive pointing to a venues sitemap
 *                    (the live robots.txt declares none, so this rarely fires)
 *   2. /sitemap.xml (sitemapindex) → find the venues group entry
 *   3. venues group URL → normally a flat <urlset> with ~10k venue URLs. A
 *                        <sitemapindex> listing paginated pages is still handled
 *                        (sitemap-venues-1, sitemap-venues-2, …) in case the
 *                        group is split up later.
 *   4. extract <loc> entries, apply the lastmod filter
 *   5. robots.txt allow-check on every collected URL
 *
 * All steps degrade gracefully: if a step fails the next fallback is tried.
 * Non-2xx responses count as failures — a 404 must never look like an empty
 * sitemap, which would silently yield zero URLs.
 */

import {
  SITEMAP_INDEX_URL,
  DEFAULT_VENUES_SITEMAP_URL,
  VENUES_SITEMAP_RE,
  SITEMAP_MAX_PAGES_DEFAULT,
  VENUE_URL_RE,
  parseVenueUrl,
} from "../providers/tagvenue/selectors.js";
import { uniqueStrings, slugify } from "../utils/normalize.js";
import { readLinesSafe } from "../output/json-writer.js";
import { venueRecordExists } from "../output/venue-store.js";

// ─── XML helpers ─────────────────────────────────────────────────────────────

/**
 * Extract all <loc> text values from an XML string.
 * Uses a plain regex — intentionally avoids a full XML parser for 5 MB sitemaps.
 */
function extractLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}

/**
 * Extract all <lastmod> text values from an XML string (parallel array to locs).
 */
function extractLastmods(xml) {
  const out = [];
  const re = /<lastmod>\s*([^<]+)\s*<\/lastmod>/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Build an array of { loc, lastmod } objects from a <sitemapindex> or <urlset>.
 */
function extractEntries(xml) {
  const locs = extractLocs(xml);
  const lastmods = extractLastmods(xml);
  return locs.map((loc, i) => ({ loc, lastmod: lastmods[i] ?? null }));
}

/**
 * Return true when the XML root element is <sitemapindex> rather than <urlset>.
 */
function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || "").slice(0, 2000));
}

/**
 * Return the newest lastmod string found in a list of entries, or null.
 */
function newestLastmod(entries) {
  let best = null;
  for (const { lastmod } of entries) {
    if (!lastmod) continue;
    if (!best || lastmod > best) best = lastmod;
  }
  return best;
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Resolve the venue URLs to scrape, then apply the city filter, dedup, the
 * skip-existing filter and finally the `--limit` cap.
 *
 * `http` and `robots` are only needed by the `sitemap` and `search` modes;
 * `urls-file` reads a local list and never touches the network.
 *
 * @param {{
 *   mode: string,
 *   config: any,
 *   http?: any,
 *   robots?: any,
 *   logger?: any,
 * }} options
 */
export async function discoverUrls({ mode, http, robots, config, logger }) {
  const startTime = Date.now();
  let urls = [];

  if (mode === "urls-file") {
    if (!config.urlsFile) throw new Error("mode=urls-file requires --urls-file or TV_URLS_FILE");
    urls = readLinesSafe(config.urlsFile);
    logger?.info?.(`discovery (urls-file): read ${urls.length} lines from ${config.urlsFile}`);
  } else if (mode === "search") {
    // search mode requires JS pagination — fall back to sitemap with city filter in MVP.
    logger?.warn?.(
      "mode=search is stubbed in MVP. Falling back to sitemap discovery filtered by city.",
    );
    urls = await sitemapDiscover({ http, robots, config, logger });
  } else {
    // Default: sitemap mode
    urls = await sitemapDiscover({ http, robots, config, logger });
  }

  // Keep only valid /venues/ URLs and strip fragments / query strings.
  const venueUrls = [];
  for (const raw of urls) {
    const u = String(raw || "").trim();
    if (!u) continue;
    if (VENUE_URL_RE.test(u)) venueUrls.push(u.split("#")[0].split("?")[0]);
  }

  // City filter: match against the city slug embedded in the venue URL path.
  if (config.city) {
    const want = slugify(config.city);
    const before = venueUrls.length;
    const filtered = venueUrls.filter((u) => {
      const parsed = parseVenueUrl(u);
      if (!parsed) return false;
      const slug = slugify(parsed.city);
      return slug.includes(want) || want.includes(slug);
    });
    logger?.info?.(`city filter (${config.city}) reduced ${before} → ${filtered.length}`);
    venueUrls.length = 0;
    venueUrls.push(...filtered);
  }

  // Dedup.
  const deduped = uniqueStrings(venueUrls);

  // Skip venues already stored, so a capped run walks further into the catalog
  // instead of re-fetching the head of the list it already has. This has to run
  // before the limit slice: slice-then-skip would keep re-selecting the venues
  // just skipped and never advance.
  let candidates = deduped;
  let skippedExisting = 0;
  if (config.skipExisting) {
    candidates = deduped.filter((u) => {
      const parsed = parseVenueUrl(u);
      return !parsed || !venueRecordExists(config.ingestDir, parsed.venue_id);
    });
    skippedExisting = deduped.length - candidates.length;
  }

  const finalUrls =
    config.limit && config.limit > 0 ? candidates.slice(0, config.limit) : candidates;

  logger?.info?.("discovery complete", {
    mode,
    input_urls: urls.length,
    venue_urls: venueUrls.length,
    deduped: deduped.length,
    skipped_existing: skippedExisting,
    final: finalUrls.length,
    ms: Date.now() - startTime,
  });

  return finalUrls;
}

// ─── Sitemap discovery ────────────────────────────────────────────────────────

/**
 * Full sitemap discovery pipeline:
 *
 *   Step 1 — robots.txt hint
 *   Step 2 — sitemap index (/sitemap.xml)
 *   Step 3 — resolve the venues group (may be sitemapindex or urlset)
 *   Step 4 — paginated pages (sitemap-venues-1 … sitemap-venues-N)
 *   Step 5 — robots.txt allow-check on all collected URLs
 */
async function sitemapDiscover({ http, robots, config, logger }) {
  const sinceDate = parseSinceDate(config.sitemapSince);
  const maxPages = Math.max(1, config.sitemapMaxPages ?? SITEMAP_MAX_PAGES_DEFAULT);

  logger?.info?.("sitemap discovery starting", {
    sinceDate: sinceDate?.toISOString() ?? null,
    maxPages,
  });

  // ── Step 1: robots.txt hint ──────────────────────────────────────────────
  let groupUrl = null;
  try {
    const robotsSitemaps = (await robots?.getSitemaps?.()) ?? [];
    // Prefer an explicit venues sitemap reference in robots.txt
    const robotsHint = robotsSitemaps.find((u) => VENUES_SITEMAP_RE.test(u));
    if (robotsHint) {
      groupUrl = robotsHint;
      logger?.debug?.(`robots.txt provided venues sitemap hint: ${groupUrl}`);
    }
  } catch (err) {
    logger?.debug?.(`robots.txt lookup failed (${err.message ?? err}); continuing`);
  }

  // ── Step 2: sitemap index (/sitemap.xml) ────────────────────────────────
  if (!groupUrl) {
    try {
      const idxRes = await http.xml(SITEMAP_INDEX_URL, { timeoutMs: 20_000, retries: 3 });
      // A 4xx/5xx body is an error page, not a sitemap — surface it instead of
      // parsing it into zero entries.
      if (idxRes.status >= 400) throw new Error(`HTTP ${idxRes.status}`);
      const entries = extractEntries(idxRes.body);
      const venuesEntry = entries.find((e) => VENUES_SITEMAP_RE.test(e.loc));
      if (venuesEntry) {
        groupUrl = venuesEntry.loc;
        logger?.debug?.(`sitemap index resolved venues group: ${groupUrl}`);
      }
    } catch (err) {
      logger?.warn?.(`sitemap index fetch failed (${err.message ?? err}); falling back to default`);
    }
  }

  // ── Step 3: fall back to well-known default ──────────────────────────────
  if (!groupUrl) {
    groupUrl = DEFAULT_VENUES_SITEMAP_URL;
    logger?.info?.(`using default venues sitemap URL: ${groupUrl}`);
  }

  // ── Step 4: resolve the venues group — one or two levels deep ───────────
  //
  // Tagvenue structure (observed on the live site, 2026-10):
  //   /sitemap-venues        → flat <urlset> with ~10k venue detail URLs
  //
  // The paginated shape below is handled too, so the group keeps working if
  // Tagvenue ever splits it:
  //   /sitemap-venues        → <sitemapindex> listing sitemap-venues-1 … -N
  //   /sitemap-venues-1      → <urlset> with <loc> entries for venue pages

  const allLocs = await resolveGroupUrls({
    http,
    rootUrl: groupUrl,
    sitemapRe: VENUES_SITEMAP_RE,
    sinceDate,
    maxPages,
    logger,
  });

  logger?.info?.(`sitemap-venues raw loc entries collected: ${allLocs.length}`);

  // ── Step 5: robots.txt allow-check ──────────────────────────────────────
  const ua = "TagvenueScraper/1.0 (+https://iqkv.com)";
  const allowed = [];
  let blocked = 0;
  for (const u of allLocs) {
    const ok = (await robots?.isAllowed?.(u, ua)) !== false;
    if (ok) {
      allowed.push(u);
    } else {
      blocked++;
    }
  }
  if (blocked > 0) {
    logger?.info?.(`robots.txt blocked ${blocked} URL(s); proceeding with ${allowed.length}`);
  }

  return allowed;
}

// ─── Multi-level sitemap resolution ──────────────────────────────────────────

/**
 * Fetch `rootUrl`, determine whether it is a sitemapindex or a urlset, then:
 *
 *  - urlset   → extract locs directly (the group is a single flat sitemap)
 *  - sitemapindex → enumerate child pages up to `maxPages`, applying `sinceDate`
 *                   early-exit to skip pages whose newest lastmod is older than
 *                   sinceDate (pages are roughly newest-first on Tagvenue).
 *
 * Returns a flat array of all <loc> strings.
 */
async function resolveGroupUrls({ http, rootUrl, sitemapRe, sinceDate, maxPages, logger }) {
  let rootXml;
  try {
    const res = await http.xml(rootUrl, { timeoutMs: 60_000, retries: 3 });
    // http.xml resolves 4xx bodies without throwing, so check the status here:
    // a 404 must fail loudly rather than parse an error page into zero entries.
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    rootXml = res.body;
  } catch (err) {
    throw new Error(`Failed to fetch sitemap root (${rootUrl}): ${err.message ?? err}`);
  }

  if (!isSitemapIndex(rootXml)) {
    // Already a urlset — single flat sitemap (or a numbered page passed directly).
    const entries = extractEntries(rootXml);
    logger?.debug?.(`sitemap group is a urlset with ${entries.length} entries`);
    return filterByLastmod(entries, sinceDate).map((e) => e.loc);
  }

  // It's a sitemapindex — collect all child page URLs.
  const childEntries = extractEntries(rootXml);
  const childUrls = childEntries.map((e) => e.loc).filter((u) => sitemapRe.test(u));

  // If the index itself listed no matching children, maybe it listed them without
  // the standard naming pattern (edge case). Fall back to all child locs.
  const pages = (childUrls.length ? childUrls : childEntries.map((e) => e.loc)).slice(0, maxPages);

  logger?.info?.(
    `sitemapindex lists ${childEntries.length} child(ren); will fetch up to ${pages.length} page(s)`,
  );

  const allLocs = [];
  let pagesSkipped = 0;

  for (let i = 0; i < pages.length; i++) {
    const pageUrl = pages[i];
    let pageXml;
    try {
      const res = await http.xml(pageUrl, { timeoutMs: 60_000, retries: 3 });
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
      pageXml = res.body;
    } catch (err) {
      logger?.warn?.(`sitemap page ${pageUrl} failed (${err.message ?? err}); skipping`);
      continue;
    }

    const entries = extractEntries(pageXml);

    // lastmod early-exit optimisation: if the newest entry on this page is older
    // than sinceDate there is nothing new to collect — and subsequent pages will
    // only be older, so we can stop.
    if (sinceDate) {
      const newest = newestLastmod(entries);
      if (newest && new Date(newest) < sinceDate) {
        logger?.info?.(
          `sitemap page ${i + 1}/${pages.length} newest lastmod (${newest}) is before ` +
            `sinceDate (${sinceDate.toISOString().slice(0, 10)}) — stopping page scan`,
        );
        pagesSkipped = pages.length - i - 1;
        break;
      }
    }

    const filtered = filterByLastmod(entries, sinceDate);
    logger?.debug?.(
      `page ${i + 1}/${pages.length}: ${entries.length} entries, ${filtered.length} pass lastmod filter`,
    );
    allLocs.push(...filtered.map((e) => e.loc));
  }

  if (pagesSkipped > 0) {
    logger?.info?.(`skipped ${pagesSkipped} page(s) due to lastmod early-exit`);
  }

  return allLocs;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a "since" value into a Date.  Accepts:
 *   - ISO date string: "2024-06-01"
 *   - Relative shorthand: "7d", "30d", "2w", "1m"
 *   - null / undefined → returns null (no filter)
 */
function parseSinceDate(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase();

  // Relative: Nd (days), Nw (weeks), Nm (months)
  const rel = /^(\d+)(d|w|m)$/.exec(s);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const ms =
      unit === "d"
        ? n * 86_400_000
        : unit === "w"
          ? n * 7 * 86_400_000
          : /* m */ n * 30 * 86_400_000;
    return new Date(Date.now() - ms);
  }

  // ISO date or datetime
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Filter an entries array to those whose lastmod is >= sinceDate.
 * Entries with no lastmod always pass (we can't prove they're stale).
 */
function filterByLastmod(entries, sinceDate) {
  if (!sinceDate) return entries;
  return entries.filter(({ lastmod }) => {
    if (!lastmod) return true; // unknown lastmod → include
    const d = new Date(lastmod);
    return Number.isFinite(d.getTime()) && d >= sinceDate;
  });
}
