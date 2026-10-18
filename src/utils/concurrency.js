import PQueue from "p-queue";

export function createConcurrencyQueue({ concurrency = 5, logger = null, tag = "queue" } = {}) {
  const q = new PQueue({ concurrency, autoStart: true });
  let started = 0;
  let done = 0;
  let failed = 0;

  const logProgress = (extra = {}) => {
    if (!logger) return;
    logger.debug?.(`${tag} progress`, {
      started,
      done,
      failed,
      pending: q.size,
      running: q.pending,
      ...extra,
    });
  };

  return {
    queue: q,
    add: async (fn, meta = {}) => {
      started++;
      return q.add(async () => {
        try {
          const result = await fn();
          done++;
          logProgress({ ok: 1, meta });
          return result;
        } catch (err) {
          failed++;
          logProgress({ fail: 1, meta, err: String(err.message || err).slice(0, 100) });
          throw err;
        }
      });
    },
    onIdle: () => q.onIdle(),
    stats: () => ({ started, done, failed, pending: q.size, running: q.pending }),
  };
}
