import robotsParser from "robots-parser";

export function createRobotsChecker({ http, sitemapBase = "https://www.tagvenue.com" } = {}) {
  let cached = null;
  let cachedAt = 0;
  const TTL_MS = 12 * 60 * 60 * 1000; // 12h TTL

  async function getParser() {
    const now = Date.now();
    if (cached && now - cachedAt < TTL_MS) return cached;
    const url = `${sitemapBase.replace(/\/$/, "")}/robots.txt`;
    let body = "";
    try {
      const res = await http.text(url, { timeoutMs: 10_000, retries: 2 });
      body = res.body;
    } catch {
      body = "User-agent: *\nAllow: /";
    }
    cached = robotsParser(url, body);
    cachedAt = now;
    return cached;
  }

  return {
    async isAllowed(url, ua) {
      const parser = await getParser();
      return parser.isAllowed(url, ua) !== false;
    },
    async getSitemaps() {
      const parser = await getParser();
      return parser.getSitemaps?.() ?? [];
    },
    async getCrawlDelay(ua) {
      const parser = await getParser();
      return parser.getCrawlDelay?.(ua) ?? 0;
    },
  };
}
