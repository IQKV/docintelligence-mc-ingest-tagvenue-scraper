import { SITEMAP_INDEX_URL, DEFAULT_ROOMS_SITEMAP_URL, ROOM_URL_RE, parseRoomUrl } from '../providers/tagvenue/selectors.js';
import { uniqueStrings, slugify } from '../utils/normalize.js';
import { readLinesSafe } from '../output/json-writer.js';

function extractLocStrings(xml) {
  // Fast regex-based extraction (do NOT parse 5MB XML with full parser — overkill for sitemap)
  const out = [];
  const re = /<loc>\s*([^<]+)\s*<\/loc>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) {
    out.push(m[1].trim());
  }
  return out;
}

function extractSitemapIndexEntries(xml) {
  // In sitemapindex, <sitemap><loc>...</loc><lastmod/></sitemap>
  const locs = extractLocStrings(xml);
  const lastmods = [];
  const re = /<lastmod>\s*([^<]+)\s*<\/lastmod>/g;
  let m;
  while ((m = re.exec(String(xml || ''))) !== null) lastmods.push(m[1].trim());
  return locs.map((loc, i) => ({ loc, lastmod: lastmods[i] || null }));
}

export async function discoverUrls({ mode, http, robots, config, logger }) {
  const startTime = Date.now();
  let urls = [];

  if (mode === 'urls-file') {
    if (!config.urlsFile) throw new Error('mode=urls-file requires --urls-file or TV_URLS_FILE');
    urls = readLinesSafe(config.urlsFile);
    logger?.info?.(`discovery (urls-file): read ${urls.length} lines from ${config.urlsFile}`);
  } else if (mode === 'search') {
    // Search mode is stubbed in MVP: it requires JS pagination (Playwright).
    // For MVP, warn user and fall back to sitemap with city filter.
    logger?.warn?.(
      'mode=search is stubbed in MVP. Falling back to sitemap discovery filtered by city.',
    );
    urls = await sitemapDiscover({ http, robots, city: config.city, country: config.country, logger });
  } else {
    // Default: sitemap mode
    urls = await sitemapDiscover({ http, robots, city: config.city, country: config.country, logger });
  }

  // Filter: only valid /rooms/ URLs
  const roomUrls = [];
  for (const raw of urls) {
    const u = String(raw || '').trim();
    if (!u) continue;
    if (ROOM_URL_RE.test(u)) roomUrls.push(u.split('#')[0].split('?')[0]);
  }

  // City filter: parsed_url.city contains slugged city substring (e.g. "london" vs "greater-london")
  if (config.city) {
    const want = slugify(config.city);
    const before = roomUrls.length;
    const filtered = roomUrls.filter((u) => {
      const parsed = parseRoomUrl(u);
      if (!parsed) return false;
      return slugify(parsed.city).includes(want) || want.includes(slugify(parsed.city));
    });
    logger?.info?.(`city filter (${config.city}) reduced ${before} → ${filtered.length}`);
    roomUrls.length = 0;
    roomUrls.push(...filtered);
  }

  // Dedup + limit
  const deduped = uniqueStrings(roomUrls);
  const finalUrls =
    config.limit && config.limit > 0 ? deduped.slice(0, config.limit) : deduped;

  logger?.info?.('discovery complete', {
    mode,
    input_urls: urls.length,
    room_urls: roomUrls.length,
    deduped: deduped.length,
    final: finalUrls.length,
    ms: Date.now() - startTime,
  });

  return finalUrls;
}

async function sitemapDiscover({ http, robots, city, country, logger }) {
  logger?.info?.('sitemap discovery starting');
  // Step 1: fetch sitemap index, locate sitemap-rooms (or fallback default)
  let roomsSitemapUrl = DEFAULT_ROOMS_SITEMAP_URL;
  try {
    const robotsSitemaps = (await robots?.getSitemaps?.()) || [];
    const roomsRobots = robotsSitemaps.find((u) => /sitemap-rooms/i.test(u));
    if (roomsRobots) roomsSitemapUrl = roomsRobots;
  } catch {}
  try {
    const indexRes = await http.xml(SITEMAP_INDEX_URL, { timeoutMs: 15_000, retries: 3 });
    const entries = extractSitemapIndexEntries(indexRes.body);
    const roomsEntry = entries.find((e) => /sitemap-rooms(?![^s]|$)/i.test(e.loc));
    if (roomsEntry) roomsSitemapUrl = roomsEntry.loc;
  } catch (err) {
    logger?.warn?.(`sitemap index download failed (${err.message || err}); using default ${DEFAULT_ROOMS_SITEMAP_URL}`);
  }

  logger?.info?.(`fetching rooms sitemap: ${roomsSitemapUrl}`);
  const roomsRes = await http.xml(roomsSitemapUrl, { timeoutMs: 120_000, retries: 3 });
  const allLocs = extractLocStrings(roomsRes.body);
  logger?.info?.(`sitemap-rooms raw loc entries: ${allLocs.length}`);

  // robots.txt check per URL (lightweight; the cached parser doesn't do HTTP)
  let nAllowed = 0;
  const allowed = [];
  for (const u of allLocs) {
    const ok = (await robots?.isAllowed?.(u, 'TagvenueScraper/1.0 (+https://iqkv.com)')) !== false;
    if (ok) {
      allowed.push(u);
      nAllowed++;
    }
  }
  logger?.info?.(`robots.txt check: allowed ${nAllowed}/${allLocs.length}`);
  return allowed;
}
