/**
 * 定时任务：每天固定时刻跑一次（巩固、清理等）
 */

function dayKey(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * @param {object} options
 * @param {Array<{name: string, at: string, run: Function}>} options.jobs  at 形如 "03:30"
 */
export function createScheduler({
  jobs = [], logger = null, clock = () => new Date(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval, intervalMs = 60000,
} = {}) {
  const lastRun = new Map();
  let timer = null;

  function due(now) {
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const current = `${hh}:${mm}`;
    return jobs.filter((job) => job.at === current && lastRun.get(job.name) !== dayKey(now));
  }

  async function tick(now = clock()) {
    const list = due(now);
    const results = [];
    for (const job of list) {
      lastRun.set(job.name, dayKey(now));
      try {
        const value = await job.run({ now });
        results.push({ name: job.name, ok: true, value });
        logger?.info?.('定时任务完成', { job: job.name });
      } catch (error) {
        results.push({ name: job.name, ok: false, error: String(error?.message ?? error) });
        logger?.error?.('定时任务失败', { job: job.name, reason: error?.message ?? String(error) });
      }
    }
    return results;
  }

  return {
    tick,
    jobs,
    start() {
      if (timer) return;
      timer = setIntervalFn(() => { tick().catch(() => {}); }, intervalMs);
      timer?.unref?.();
      logger?.info?.('定时任务已启动', { jobs: jobs.map((j) => `${j.name}@${j.at}`) });
    },
    stop() {
      if (timer) clearIntervalFn(timer);
      timer = null;
    },
    lastRun: (name) => lastRun.get(name) ?? null,
  };
}
