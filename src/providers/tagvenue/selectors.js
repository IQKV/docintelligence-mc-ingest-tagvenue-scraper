import * as cheerio from 'cheerio';
import path from 'node:path';

export const BASE_URL = 'https://www.tagvenue.com';
export const SITEMAP_INDEX_URL = `${BASE_URL}/sitemap.xml`;

// Tagvenue uses paginated sitemaps: sitemap-rooms-1.xml, sitemap-rooms-2.xml, …
// The bare path without a number is treated as the index for that group.
export const DEFAULT_ROOMS_SITEMAP_INDEX_URL = `${BASE_URL}/sitemap-rooms.xml`;
// Kept for backwards-compat (pre-pagination fallback — redirects to first page on the live site).
export const DEFAULT_ROOMS_SITEMAP_URL = `${BASE_URL}/sitemap-rooms.xml`;
export const DEFAULT_VENUES_SITEMAP_URL = `${BASE_URL}/sitemap-venues.xml`;

// Pattern that matches any rooms-sitemap URL (index or numbered page):
//   sitemap-rooms.xml  |  sitemap-rooms-1.xml  |  sitemap-rooms-23.xml
export const ROOMS_SITEMAP_RE = /sitemap-rooms(?:-\d+)?\.xml/i;

// Maximum number of paginated rooms-sitemap pages to fetch when no explicit cap is set.
// Tagvenue has ~20 pages as of 2024; 100 is a safe ceiling.
export const SITEMAP_MAX_PAGES_DEFAULT = 100;

// JSON-LD paths (schema.org) — see probe result: first ld block is EventVenue/Restaurant
export const LD_SELECTOR = 'script[type="application/ld+json"]';

// DOM selectors (heuristic — based on 115 feature-like + 89 spec-like nodes observed on detail page)
// They're organized as buckets; each bucket has many selectors so we're robust to class renames.
export const DOM_SELECTORS = {
  title: ['title'],
  h1_name: ['h1', 'h1[class*="room-title"]', '[data-testid*="room-name"]', '[class*="room-detail__title"]'],
  description_long: [
    '[class*="description"] p',
    '[data-testid*="description"]',
    '[class*="room-description"]',
    '[class*="about"] p',
    'meta[name="description"]@content',
  ],
  // Nearest station / transport
  nearest_station_name: [
    '[class*="station"] strong',
    '[class*="station"] b',
    '[class*="nearest"] strong',
    '[data-testid*="station"]',
    '[aria-label*="station"]',
  ],
  nearest_station_distance: [
    '[class*="station"] [class*="distance"]',
    '[class*="station"] span:last-child',
    '[class*="nearest"] [class*="miles"], [class*="nearest"] [class*="meters"]',
  ],
  // Host / Manager
  host_name: [
    '[class*="host"] [class*="name"]',
    '[class*="manager"] [class*="name"]',
    '[class*="owner"] [class*="name"]',
    '[class*="host"] h3',
    '[class*="host"] strong',
  ],
  host_response_minutes: [
    '[class*="response"] [class*="time"]',
    '[class*="response-time"]',
    '[data-testid*="response-time"]',
    '[class*="host"] [class*="minutes"]',
  ],
  host_response_rate: [
    '[class*="response-rate"]',
    '[data-testid*="response-rate"]',
    '[class*="host"] [class*="rate"]',
  ],
  // Features / amenities / specs tables (89 spec-like elements)
  tables_all: ['[class*="spec"] table', '[class*="detail"] table', '[class*="information"] table', 'table'],
  features_unstructured: [
    '[class*="feature"] li',
    '[class*="amenity"] li',
    '[class*="facility"] li',
    '[class*="room-feature"]',
    '[data-testid*="feature"]',
    '[data-testid*="amenity"]',
    'li[aria-label*="Wi-Fi"], li[aria-label*="wifi"]',
  ],
  restrictions_unstructured: [
    '[class*="rule"] li',
    '[class*="restriction"] li',
    '[class*="policy"] li',
    '[data-testid*="rule"]',
    '[data-testid*="restriction"]',
  ],
  // Photos gallery
  gallery_imgs: [
    '[class*="gallery"] img',
    '[class*="carousel"] img',
    '[class*="photos"] img',
    '[data-testid*="photo-gallery"] img',
  ],
  // Reviews aggregate (besides JSON-LD)
  reviews_rating_value: [
    '[class*="rating"] [class*="value"]',
    '[data-testid*="rating-value"]',
    '[itemprop="ratingValue"]@content',
  ],
  reviews_count: [
    '[class*="review"] [class*="count"]',
    '[data-testid*="review-count"]',
    '[itemprop="reviewCount"]@content',
  ],
  reviews_items: [
    '[class*="review-list"] [class*="review-item"]',
    '[class*="reviews"] [class*="review"]',
    '[itemtype*="Review"]',
  ],
  // Price / pricing widget (JS rendered — SSR often only shows hint text; save raw text)
  price_hint_text: [
    '[class*="price"] strong',
    '[class*="pricing"] [class*="starting"]',
    '[class*="room-price"]',
    '[data-testid*="price"]',
    'meta[property="og:price:amount"]@content',
  ],
  price_minimum_spend: [
    '[class*="minimum"] [class*="spend"]',
    '[data-testid*="minimum-spend"]',
    '[class*="pricing"] [class*="from"]',
  ],
};

// <loc> URL regex for rooms sitemap:
// /rooms/<city-or-district>/<room_id:int>/<venue-slug>/<room-slug>
export const ROOM_URL_RE =
  /^https?:\/\/(www\.)?tagvenue\.com\/rooms\/(?<city>[^/]+)\/(?<room_id>\d+)\/(?<venue_slug>[^/]+)(\/(?<room_slug>[^/?#]+))?/;

export function parseRoomUrl(url) {
  const m = String(url || '').match(ROOM_URL_RE);
  if (!m) return null;
  const g = m.groups || {};
  return {
    url: String(url).split('#')[0].split('?')[0],
    city: g.city || null,
    room_id: parseInt(g.room_id, 10),
    venue_slug: g.venue_slug || null,
    room_slug: g.room_slug || null,
  };
}

// Venue URL pattern: for enrichment cross-linking
export const VENUE_URL_RE =
  /^https?:\/\/(www\.)?tagvenue\.com\/venue[s]?\/(?<city>[^/]+)\/(?<venue_id>\d+)\/(?<venue_slug>[^/?#]+)/;

export function parseVenueUrl(url) {
  const m = String(url || '').match(VENUE_URL_RE);
  if (!m) return null;
  const g = m.groups || {};
  return {
    url: String(url).split('#')[0].split('?')[0],
    city: g.city || null,
    venue_id: parseInt(g.venue_id, 10),
    venue_slug: g.venue_slug || null,
  };
}

export function cheerioAttrOrText($, selectors) {
  for (const raw of selectors) {
    const [selector, attr] = raw.split('@');
    const nodes = $(selector);
    if (!nodes.length) continue;
    if (attr) {
      const v = nodes.first().attr(attr);
      if (v != null && String(v).trim() !== '') return v.trim();
    } else {
      const v = nodes.first().text();
      if (v != null && String(v).trim() !== '') return v.trim();
    }
  }
  return null;
}

export function cheerioAllText($, selectors, opts = {}) {
  const seen = new Set();
  const limit = opts.limit ?? 500;
  const dedupe = opts.dedupe ?? true;
  const result = [];
  for (const selector of selectors) {
    if (selector.includes('@')) continue;
    try {
      $(selector).each((_i, el) => {
        if (result.length >= limit) return false;
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!text) return true;
        if (dedupe) {
          const k = text.toLowerCase();
          if (seen.has(k)) return true;
          seen.add(k);
        }
        result.push(text);
        return true;
      });
    } catch {}
    if (result.length >= limit) break;
  }
  return result;
}

export function cheerioTableRows($, tableSelectors) {
  // Returns [{key: <th text>, value: <td text>}]
  const rows = [];
  for (const sel of tableSelectors) {
    try {
      $(sel).each((_i, table) => {
        $('tr', table).each((_j, tr) => {
          const th = $('th', tr).first().text().replace(/\s+/g, ' ').trim();
          const td = $('td', tr).first().text().replace(/\s+/g, ' ').trim();
          if (th && td) rows.push({ key: th, value: td });
        });
      });
    } catch {}
  }
  return rows;
}

export function extractImageSrcset($, selectors) {
  const out = [];
  for (const sel of selectors) {
    try {
      $(sel).each((_i, img) => {
        const src = $(img).attr('src') || $(img).attr('data-src') || $(img).attr('data-lazy-src');
        if (src) out.push(src);
      });
    } catch {}
  }
  return [...new Set(out)];
}

export function basenameFromUrl(url, ext = '') {
  try {
    const p = new URL(url).pathname;
    return path.basename(p, ext);
  } catch {
    return '';
  }
}

export function ldBlocksFromHtml(html) {
  const $ = cheerio.load(html);
  const arr = [];
  $(LD_SELECTOR).each((_i, el) => {
    const raw = $(el).html() || '';
    if (!raw.trim()) return;
    try {
      const parsed = JSON.parse(raw.trim());
      if (Array.isArray(parsed)) arr.push(...parsed);
      else arr.push(parsed);
    } catch {
      // Try relaxed parse: sometimes multiple JSON objects inside one <script> (unlikely but possible)
      try {
        // Best-effort: find JSON objects with @context or @type
        const re = /\{[\s\S]*?"@(context|type)"[\s\S]*?\}/g;
        let m;
        while ((m = re.exec(raw)) !== null) {
          try { arr.push(JSON.parse(m[0])); } catch {}
        }
      } catch {}
    }
  });
  return arr;
}

export function findFirstLdByType(blocks, typeLike) {
  const wantType = String(typeLike).toLowerCase();
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const types = Array.isArray(b['@type']) ? b['@type'] : [b['@type']];
    if (types.some((t) => String(t).toLowerCase().includes(wantType))) return b;
  }
  return null;
}

export function findAllLdByType(blocks, typeLike) {
  const wantType = String(typeLike).toLowerCase();
  const out = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const types = Array.isArray(b['@type']) ? b['@type'] : [b['@type']];
    if (types.some((t) => String(t).toLowerCase().includes(wantType))) out.push(b);
  }
  return out;
}

export function ldAdditionalPropertyMap(ld) {
  // additionalProperty: [{name, value}]
  const out = {};
  const arr = Array.isArray(ld?.additionalProperty) ? ld.additionalProperty : [];
  for (const item of arr) {
    if (!item || item.name == null) continue;
    out[String(item.name).trim()] = item.value;
  }
  return out;
}
