import axios from "axios";

async function buildProxyAgent(proxyUrl) {
  const p = String(proxyUrl || "").trim();
  if (!p) return { httpAgent: undefined, httpsAgent: undefined };
  // Optional: prefer hpagent if installed.
  try {
    const mod = await import("hpagent");
    return {
      httpAgent: new mod.HttpProxyAgent({ proxy: p }),
      httpsAgent: new mod.HttpsProxyAgent({
        proxy: p,
        keepAlive: true,
        maxSockets: 10,
        maxFreeSockets: 5,
      }),
    };
  } catch {
    // hpagent not installed → fall back to https-proxy-agent if present, else throw
    try {
      // @ts-ignore optional dependency: only installed when a proxy is configured
      const mod = await import("https-proxy-agent");
      const Ctor = mod.HttpsProxyAgent || mod.default;
      const agent = new Ctor(p);
      return { httpAgent: agent, httpsAgent: agent };
    } catch {
      throw new Error(
        'TV_PROXY requires either "hpagent" or "https-proxy-agent" installed. ' +
          "Run `pnpm add hpagent` or remove proxy config.",
      );
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   proxy?: string | null,
 *   accept?: string,
 *   extraHeaders?: Record<string, string>,
 * }} [options]
 */
export function createHttpFetcher({
  userAgent,
  timeoutMs = 15_000,
  retries = 3,
  proxy = null,
  accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  extraHeaders = {},
} = {}) {
  const agentPromise = buildProxyAgent(proxy);

  async function get(url, options = {}) {
    const agents = await agentPromise;
    const attempt = async (attemptN) => {
      try {
        const instance = axios.create({
          timeout: options.timeoutMs ?? timeoutMs,
          maxRedirects: 5,
          headers: {
            "User-Agent": userAgent,
            Accept: options.accept ?? accept,
            "Accept-Encoding": "gzip, deflate, br",
            "Accept-Language": "en-GB,en;q=0.9",
            ...extraHeaders,
            ...(options.headers ?? {}),
          },
          responseType: (options.responseType ?? options.isBinary) ? "arraybuffer" : "text",
          validateStatus: (s) => s >= 200 && s < 500, // treat 4xx as non-retryable
          ...agents,
        });
        const res = await instance.get(url, { signal: options.signal });
        if ([408, 429, 500, 502, 503, 504].includes(res.status)) {
          const err = Object.assign(new Error(`HTTP ${res.status} for ${url}`), {
            status: res.status,
            retryable: true,
          });
          throw err;
        }
        return res;
      } catch (err) {
        if (
          err.retryable ||
          /timeout|socket|econnreset|econnrefused|enotfound|etimedout|certificate|epipe/i.test(
            err.code || err.message || "",
          )
        ) {
          if (attemptN < (options.retries ?? retries)) {
            const backoff = 2 ** attemptN * 1000 + Math.floor(Math.random() * 1000);
            await sleep(backoff);
            return attempt(attemptN + 1);
          }
        }
        throw err;
      }
    };
    return attempt(0);
  }

  return {
    async text(url, options) {
      const res = await get(url, options);
      return {
        url: res.request?.res?.responseUrl ?? url,
        status: res.status,
        headers: res.headers,
        body: typeof res.data === "string" ? res.data : Buffer.from(res.data).toString("utf8"),
      };
    },
    async buffer(url, options) {
      const res = await get(url, { ...options, responseType: "arraybuffer", isBinary: true });
      return {
        url: res.request?.res?.responseUrl ?? url,
        status: res.status,
        headers: res.headers,
        buffer: Buffer.from(res.data),
      };
    },
    async xml(url, options) {
      return this.text(url, {
        ...options,
        accept: "application/xml,text/xml,application/xhtml+xml;q=0.9,*/*;q=0.1",
      });
    },
  };
}
