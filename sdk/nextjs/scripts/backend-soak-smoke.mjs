import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { fixtureObject } from "./fixture-values.mjs";
/** @typedef {import("./backend-sessions-smoke.mjs").BackendCase & {Integration: typeof import("../../ssr/dist/context.js").Integration, PostgresSessionStore: typeof import("../../ssr/dist/postgres.js").PostgresSessionStore}} SoakFixture */
/** @typedef {{elapsedSeconds: number, rssBytes: number, poolTotal: number, poolIdle: number, poolWaiting: number}} ResourceSample */
/** @param {SoakFixture} fixture @param {number} seconds */
export function runSustainedLoad(fixture, seconds) {
  return new SustainedLoad(fixture, seconds).run();
}
class SustainedLoad {
  /** @type {number[]} */ latencies = [];
  /** @type {ResourceSample[]} */ samples = [];
  start = 0;
  until = 0;
  operations = 0;
  maxWaiting = 0;
  maxConnections = 0;
  /** @param {SoakFixture} fixture @param {number} seconds */
  constructor(fixture, seconds) {
    this.fixture = fixture;
    this.seconds = seconds;
  }
  async run() {
    assert(this.seconds >= 60, "A soak must run for at least 60 seconds");
    const peer = await sharedPeer(this.fixture);
    this.start = performance.now();
    this.until = this.start + this.seconds * 1000;
    this.sample();
    const pollIntervalInMs = 1000,
      timer = setInterval(() => this.sample(), pollIntervalInMs);
    try {
      await Promise.all(Array.from({ length: 16 }, (_, worker) => this.worker(peer, worker)));
    } finally {
      clearInterval(timer);
    }
    this.sample();
    return await this.report();
  }
  sample() {
    const pool = this.fixture.pool;
    this.samples.push({
      elapsedSeconds: Math.round((performance.now() - this.start) / 1000),
      rssBytes: process.memoryUsage().rss,
      poolTotal: pool.totalCount,
      poolIdle: pool.idleCount,
      poolWaiting: pool.waitingCount,
    });
    this.maxWaiting = Math.max(this.maxWaiting, pool.waitingCount);
    this.maxConnections = Math.max(this.maxConnections, pool.totalCount);
  }
  /** @param {import("../../ssr/dist/context.js").Integration<unknown>} peer @param {number} worker */
  async worker(peer, worker) {
    const { a, b, integration, request } = this.fixture;
    const jar = worker % 2 !== 0 ? a : b,
      expected = worker % 2 !== 0 ? "alice-private" : "bob-private";
    while (performance.now() < this.until) {
      const began = performance.now();
      // The write path exercises advisory lock acquisition and release for every read.
      // oxlint-disable-next-line no-await-in-loop -- Keep each bounded load worker ordered until its preceding request settles.
      const result = await (worker % 3 !== 0 ? integration : peer).write(
        jar,
        request(),
        (context) => context.client.from("next_notes").select().execute(),
      );
      assert.equal(result.error, null);
      assert.deepEqual(
        result.data.map((row) => row.body),
        [expected],
      );
      const elapsed = performance.now() - began;
      assert(elapsed < 5000, "Request exceeded the session store deadline");
      this.operations++;
      // Keep the original bounded reservoir after the first ten thousand operations.
      if (this.latencies.length < 10000 || this.operations % 100 === 0)
        this.latencies.push(elapsed);
      if (this.latencies.length > 20000) this.latencies.shift();
    }
  }
  async report() {
    const sorted = this.latencies.toSorted((a, b) => a - b);
    assert(this.operations >= this.seconds, "Insufficient sustained progress");
    await releasedPool(this.fixture.pool);
    const rssGrowth = rssGrowthAfterWarmup(this.samples);
    assert(rssGrowth < 128 * 1024 * 1024, "RSS grew more than 128 MiB after warmup");
    return {
      seconds: (performance.now() - this.start) / 1000,
      workers: 16,
      poolMax: 4,
      operations: this.operations,
      operationsPerSecond: this.operations / this.seconds,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      p99Ms: sorted[Math.floor(sorted.length * 0.99)],
      maxWaiting: this.maxWaiting,
      maxConnections: this.maxConnections,
      rssGrowthBytesAfterWarmup: rssGrowth,
      samples: this.samples,
      retainedAdvisoryLocks: 0,
      errors: 0,
    };
  }
}
/** @param {ResourceSample[]} samples */
function rssGrowthAfterWarmup(samples) {
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  /** @param {ResourceSample[]} values */
  const peak = (values) => Math.max(...values.map((value) => value.rssBytes));
  return peak(samples.slice(-quarter)) - peak(samples.slice(quarter, 2 * quarter));
}
/** @param {import("pg").Pool} pool */
async function releasedPool(pool) {
  assert(pool.totalCount <= 4);
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.idleCount, pool.totalCount);
  const locks = await pool.query(
    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname=current_database())",
  );
  assert.equal(fixtureObject(locks.rows[0]).count, "0", "Advisory locks retained after load");
  assert.equal(
    fixtureObject((await pool.query("SELECT count(*) FROM public.next_notes")).rows[0]).count,
    "2",
  );
}
/** @param {SoakFixture} fixture */
async function sharedPeer({ Integration, PostgresSessionStore, pool, port, origin, keys, a }) {
  const sibling = await Integration.create({
    url: `http://127.0.0.1:${port}`,
    appOrigin: origin,
    keys: [randomBytes(32).toString("base64url")],
    store: new PostgresSessionStore(pool),
    allowInsecureDevelopment: true,
  });
  const wrongKey = await sibling.read(a, (context) =>
    context.client.from("next_notes").select().execute(),
  );
  assert.equal(wrongKey.error, null);
  assert.deepEqual(wrongKey.data, []);
  return await Integration.create({
    url: `http://127.0.0.1:${port}`,
    appOrigin: origin,
    keys,
    store: new PostgresSessionStore(pool),
    allowInsecureDevelopment: true,
  });
}
