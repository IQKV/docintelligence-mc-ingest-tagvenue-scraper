import pThrottle from 'p-throttle';

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export function jitter(delayMs, jitterMs = 0) {
  const base = Math.max(0, Number(delayMs) || 0);
  const j = Math.max(0, Number(jitterMs) || 0);
  return base + (j > 0 ? Math.floor(Math.random() * j) : 0);
}

export function createRateLimiter({ requestsPerSecond = 3, burstSize = 6, minDelayMs = 0, jitterMs = 0 } = {}) {
  const limitFunc = pThrottle({ limit: Math.max(1, Math.round(burstSize || requestsPerSecond * 2)), interval: 1000 });
  return {
    wrap: (fn) => {
      const throttled = limitFunc(async (...args) => {
        if (minDelayMs > 0 || jitterMs > 0) await sleep(jitter(minDelayMs, jitterMs));
        return fn(...args);
      });
      return throttled;
    },
  };
}
