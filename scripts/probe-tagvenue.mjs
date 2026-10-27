import axios from "axios";
import * as cheerio from "cheerio";

async function probe(url, label) {
  console.log("\n==== PROBE: " + label + " ====");
  console.log("URL: " + url);
  try {
    const { data, status, headers } = await axios.get(url, {
      timeout: 15000,
      headers: {
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      maxRedirects: 5,
    });
    console.log(
      "STATUS: " +
        status +
        " content-type=" +
        headers["content-type"] +
        " len=" +
        (data?.length || 0),
    );
    if (url.includes("robots") || url.includes("sitemap")) {
      console.log("--- 1500 CHARS ---");
      console.log(String(data).slice(0, 1500));
      console.log("-----------------");
    } else {
      const $ = cheerio.load(data);
      const ld = $('script[type="application/ld+json"]')
        .map((i, el) => $(el).html())
        .get();
      console.log("JSON-LD COUNT: " + ld.length);
      if (ld.length) {
        const first = ld[0];
        try {
          console.log(
            "JSON-LD[0] (first 1200 chars):",
            JSON.stringify(JSON.parse(first), null, 2).slice(0, 1200),
          );
        } catch {
          console.log("JSON-LD[0] raw first 800:", String(first).slice(0, 800));
        }
        if (ld.length > 1) {
          console.log("TOTAL ld blocks:", ld.length);
          for (let i = 1; i < Math.min(ld.length, 3); i++) {
            try {
              const parsed = JSON.parse(ld[i]);
              console.log(
                `JSON-LD[${i}] @type=`,
                parsed["@type"] ?? "(none)",
                "first 400=",
                JSON.stringify(parsed).slice(0, 400),
              );
            } catch {}
          }
        }
      }
      console.log("title: " + $("title").first().text().slice(0, 140));
      console.log(
        "feature-like nodes:  " +
          $('[class*="feature"], [data-testid*="feature"], [class*="amenity"]').length,
      );
      console.log(
        "spec/spec-table-like:  " +
          $(
            '.spec-table, [class*="spec"], [data-testid*="spec"], [class*="room-detail"] table, [class*="information"] table',
          ).length,
      );
      // nearest station heuristic
      const station =
        $('[class*="station"], [class*="nearest"], [data-testid*="station"]')
          .first()
          .text()
          .trim()
          .slice(0, 140) || null;
      console.log("nearest station hint: " + (station ?? "(none found)"));
      // host/manager section heuristic
      const host =
        $('[class*="host"], [class*="manager"], [class*="owner"]')
          .first()
          .text()
          .trim()
          .slice(0, 200) || null;
      console.log("host/manager hint: " + (host ?? "(none found)"));
    }
  } catch (err) {
    console.log("FAILED: " + (err.status || err.code || err.message || String(err).slice(0, 200)));
    if (err.response) {
      console.log(
        "resp status=" +
          err.response.status +
          " body=" +
          String(err.response.data || "").slice(0, 400),
      );
    } else {
      console.log(err.message);
    }
  }
}

await probe("https://www.tagvenue.com/robots.txt", "robots");
await probe("https://www.tagvenue.com/sitemap.xml", "sitemap-index");
await probe("https://www.tagvenue.com/sitemap-rooms", "sitemap-rooms (flat urlset)");
await probe(
  "https://www.tagvenue.com/rooms/london/25426/the-last-talisman/mala-madre-events-space",
  "detail-rooms-25426",
);
