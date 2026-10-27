import robotsParser from "robots-parser";

/**
 * @param {{
 *   http?: { text: (url: string, options?: object) => Promise<{ body: string }> },
 *   sitemapBase?: string,
 * }} [options]
 */
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
    // robots-parser ships a d.ts that is not NodeNext/interop clean: the default export is typed
    // as the module namespace, while the runtime value is the parser factory function.
    // @ts-ignore
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
