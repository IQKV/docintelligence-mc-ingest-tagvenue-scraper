import * as cheerio from "cheerio";
import {
  BASE_URL,
  DOM_SELECTORS,
  cheerioAttrOrText,
  cheerioAllText,
  cheerioTableRows,
  ldBlocksFromHtml,
  findFirstLdByType,
  findAllLdByType,
  ldAdditionalPropertyMap,
  parseRoomUrl,
  extractImageSrcset,
} from "./selectors.js";

const NOOP = () => {};

/**
 * @param {{
 *   url: string,
 *   html: string,
 *   logger?: {
 *     debug?: (msg: string, meta?: Record<string, unknown>) => void,
 *     info?: (msg: string, meta?: Record<string, unknown>) => void,
 *     warn?: (msg: string, meta?: Record<string, unknown>) => void,
 *   },
 * }} args
 */
export function extractTagvenueRecord({
  url,
  html,
  logger = { debug: NOOP, info: NOOP, warn: NOOP },
}) {
  const startedAt = Date.now();
  const parsed = parseRoomUrl(url);
  const fallbackUrl = parsed?.url || String(url).split("?")[0].split("#")[0];

  const $ = cheerio.load(html, { xmlMode: false });

  // 1. JSON-LD primary extraction
  const ldBlocks = ldBlocksFromHtml(html);
  const placeLd =
    findFirstLdByType(ldBlocks, "EventVenue") ||
    findFirstLdByType(ldBlocks, "LodgingBusiness") ||
    findFirstLdByType(ldBlocks, "Place");
  const breadcrumb = findFirstLdByType(ldBlocks, "BreadcrumbList");
  const reviewLds = findAllLdByType(ldBlocks, "Review");

  const addProps = placeLd ? ldAdditionalPropertyMap(placeLd) : {};
  // 2. DOM heuristic extraction
  const titleRaw = cheerioAttrOrText($, DOM_SELECTORS.title) || null;
  const h1Name = cheerioAttrOrText($, DOM_SELECTORS.h1_name) || null;
  const descriptionRaw = cheerioAttrOrText($, DOM_SELECTORS.description_long) || null;
  const nearestStationName = cheerioAttrOrText($, DOM_SELECTORS.nearest_station_name);
  const nearestStationDistance = cheerioAttrOrText($, DOM_SELECTORS.nearest_station_distance);
  const hostName = cheerioAttrOrText($, DOM_SELECTORS.host_name);
  const hostResponseMinutes = cheerioAttrOrText($, DOM_SELECTORS.host_response_minutes);
  const hostResponseRate = cheerioAttrOrText($, DOM_SELECTORS.host_response_rate);
  const specTableRows = cheerioTableRows($, DOM_SELECTORS.tables_all);
  const featuresList = cheerioAllText($, DOM_SELECTORS.features_unstructured, { limit: 500 });
  const restrictionsList = cheerioAllText($, DOM_SELECTORS.restrictions_unstructured, {
    limit: 200,
  });
  const galleryImgs = extractImageSrcset($, DOM_SELECTORS.gallery_imgs);
  const priceHintText = cheerioAttrOrText($, DOM_SELECTORS.price_hint_text);
  const priceMinimumSpend = cheerioAttrOrText($, DOM_SELECTORS.price_minimum_spend);
  const reviewsAggregateValue = cheerioAttrOrText($, DOM_SELECTORS.reviews_rating_value);
  const reviewsAggregateCount = cheerioAttrOrText($, DOM_SELECTORS.reviews_count);

  // Reviews list (up to 15)
  const reviewsDom = [];
  try {
    const reviewSel = DOM_SELECTORS.reviews_items;
    for (const sel of reviewSel) {
      $(sel)
        .slice(0, 15)
        .each((_i, el) => {
          const author =
            $('[class*="author"], [itemprop="author"], [class*="name"]', el)
              .first()
              .text()
              .replace(/\s+/g, " ")
              .trim() || null;
          const dateRaw = $('[class*="date"], [itemprop="datePublished"]@content', el)
            .first()
            .toString();
          const ratingVal = parseFloat(
            $('[itemprop="ratingValue"]@content, [class*="rating-value"]', el).first().toString(),
          );
          const text =
            $('[class*="body"], [itemprop="reviewBody"]', el)
              .first()
              .text()
              .replace(/\s+/g, " ")
              .trim() || null;
          reviewsDom.push({
            author,
            dateRaw,
            ratingVal: Number.isFinite(ratingVal) ? ratingVal : null,
            text,
          });
        });
    }
  } catch {}

  // Combine JSON-LD review list with DOM review list (dedup by author+date+rating)
  const reviews = [];
  const reviewSeen = new Set();
  const addReview = (r) => {
    const key = `${r.author || ""}|${r.dateRaw || ""}|${r.rating ?? ""}`.toLowerCase();
    if (!r.text && !r.author) return;
    if (reviewSeen.has(key)) return;
    reviewSeen.add(key);
    reviews.push(r);
  };
  for (const r of reviewLds.slice(0, 15)) {
    const author = typeof r.author === "string" ? r.author : r.author?.name || null;
    addReview({
      author,
      dateRaw: r.datePublished || null,
      rating:
        typeof r.reviewRating === "number" ? r.reviewRating : (r.reviewRating?.ratingValue ?? null),
      text: r.reviewBody || r.description || null,
    });
  }
  for (const r of reviewsDom.slice(0, 15)) {
    addReview({
      author: r.author,
      dateRaw: r.dateRaw,
      rating: r.ratingVal,
      text: r.text,
    });
  }

  const ldReviews = placeLd?.aggregateRating || null;

  const result = {
    _scrape: {
      url: fallbackUrl,
      fetched_at: new Date(startedAt).toISOString(),
      duration_ms: Date.now() - startedAt,
      http_status: 200,
      fetcher: "http",
      fetcher_version: "0.1.0",
      has_json_ld: !!placeLd,
      json_ld_blocks: ldBlocks.length,
      features_list_count: featuresList.length,
      restrictions_list_count: restrictionsList.length,
      spec_table_rows_count: specTableRows.length,
      gallery_img_count: galleryImgs.length,
      reviews_count_dom: reviewsDom.length,
      reviews_count_ld: reviewLds.length,
    },
    parsed_url: parsed,
    // --- source-level extracted primitives (before normalization) ---
    // JSON-LD
    ld: placeLd
      ? {
          "@type": placeLd["@type"] ?? null,
          "@id": placeLd["@id"] ?? null,
          name: placeLd.name ?? null,
          description: placeLd.description ?? null,
          url: placeLd.url ?? null,
          image: placeLd.image ?? null,
          hasMap: placeLd.hasMap ?? null,
          priceRange: placeLd.priceRange ?? null,
          maximumAttendeeCapacity:
            typeof placeLd.maximumAttendeeCapacity === "number"
              ? placeLd.maximumAttendeeCapacity
              : parseIntOrNull(placeLd.maximumAttendeeCapacity),
          address: placeLd.address ?? null,
          geo: placeLd.geo ?? null,
          aggregateRating: placeLd.aggregateRating ?? null,
          openingHoursSpecification: placeLd.openingHoursSpecification ?? null,
          additionalProperty: addProps,
        }
      : null,
    breadcrumb: breadcrumb
      ? {
          items: Array.isArray(breadcrumb.itemListElement)
            ? breadcrumb.itemListElement.map((x) => ({
                position: Number.isFinite(x.position) ? x.position : null,
                name: x.name ?? null,
                item: typeof x.item === "string" ? x.item : (x.item?.id ?? null),
              }))
            : [],
        }
      : null,
    // DOM
    dom: {
      title: titleRaw,
      h1_name: h1Name,
      description: descriptionRaw,
      nearest_station_name: nearestStationName,
      nearest_station_distance: nearestStationDistance,
      host_name: hostName,
      host_response_minutes_raw: hostResponseMinutes,
      host_response_rate_raw: hostResponseRate,
      spec_table_rows: specTableRows.slice(0, 200),
      features_list: featuresList,
      restrictions_list: restrictionsList,
      gallery_images: galleryImgs.slice(0, 200),
      price_hint_text: priceHintText,
      price_minimum_spend_text: priceMinimumSpend,
      reviews_aggregate_value_raw: reviewsAggregateValue,
      reviews_aggregate_count_raw: reviewsAggregateCount,
      reviews,
      ld_aggregate_rating: ldReviews
        ? {
            rating_value:
              typeof ldReviews.ratingValue === "number"
                ? ldReviews.ratingValue
                : parseFloat(ldReviews.ratingValue || "") || null,
            review_count:
              typeof ldReviews.reviewCount === "number"
                ? ldReviews.reviewCount
                : parseIntOrNull(ldReviews.reviewCount),
            worst: ldReviews.worstRating ?? null,
            best: ldReviews.bestRating ?? null,
          }
        : null,
    },
  };

  // Confidence score from coverage
  let score = 0.3;
  if (result.ld) score += 0.3;
  if (result.ld?.address?.streetAddress && result.ld?.geo?.latitude) score += 0.1;
  if (typeof result.ld?.maximumAttendeeCapacity === "number") score += 0.05;
  if (specTableRows.length >= 5) score += 0.05;
  if (featuresList.length >= 10) score += 0.05;
  if (galleryImgs.length >= 3) score += 0.03;
  if (hostName) score += 0.03;
  if (reviewsDom.length > 0 || reviewLds.length > 0 || ldReviews) score += 0.04;
  result._scrape.confidence = Math.min(1, score);

  logger.debug?.("extracted record", {
    roomId: parsed?.room_id ?? null,
    confidence: result._scrape.confidence,
    ld: !!result.ld,
    features: featuresList.length,
  });

  return result;
}

function parseIntOrNull(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
