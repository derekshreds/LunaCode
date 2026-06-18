import { UsageStore, UsageEvent } from "../src/usage";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error("  ✗ " + msg);
    failures++;
  } else {
    console.log("  ✓ " + msg);
  }
}

// In-memory Memento stand-in.
function fakeMemento(): any {
  const store = new Map<string, any>();
  return {
    get: (k: string, d?: any) => (store.has(k) ? store.get(k) : d),
    update: (k: string, v: any) => {
      if (v === undefined) store.delete(k);
      else store.set(k, v);
      return Promise.resolve();
    },
  };
}

const DAY = 86400000;
const now = Date.now();

async function main() {
  console.log("UsageStore aggregation:");
  const store = new UsageStore(fakeMemento());

  const events: UsageEvent[] = [
    { ts: now - 1 * DAY, model: "anthropic/claude-sonnet-4.5", prompt: 1000, completion: 200, cached: 800, cost: 0.01 },
    { ts: now - 1 * DAY, model: "openai/gpt-5", prompt: 500, completion: 100, cached: 0, cost: 0.02 },
    { ts: now - 5 * DAY, model: "anthropic/claude-sonnet-4.5", prompt: 2000, completion: 400, cached: 1500, cost: 0.03 },
    { ts: now - 45 * DAY, model: "openai/gpt-5", prompt: 9999, completion: 9999, cost: 5.0, cached: 0 },
  ];
  for (const e of events) await store.record(e);

  // Code-line events (attributed to a model).
  await store.recordCode({ ts: now - 1 * DAY, model: "anthropic/claude-sonnet-4.5", added: 120, removed: 30 });
  await store.recordCode({ ts: now - 5 * DAY, model: "openai/gpt-5", added: 40, removed: 0 });

  const r30 = store.aggregate(30);
  assert(Math.abs(r30.totalCost - 0.06) < 1e-9, `30d total cost excludes the 45-day-old event (got ${r30.totalCost})`);
  assert(r30.turns === 3, `30d turn count = 3 (got ${r30.turns})`);
  assert(r30.daily.length === 30, `30d daily series has 30 points (got ${r30.daily.length})`);
  assert(r30.byModel[0].model === "anthropic/claude-sonnet-4.5", "top model by cost is sonnet (0.04 > 0.02)");
  assert(r30.totalCached === 2300, `cached tokens summed (got ${r30.totalCached})`);

  // Per-day per-model breakdown (for stacked charts): the 1-day-ago bucket has
  // both sonnet and gpt-5 with their own costs.
  const dayWithBoth = r30.daily.find(
    (d) => d.models["anthropic/claude-sonnet-4.5"] && d.models["openai/gpt-5"]
  );
  assert(!!dayWithBoth, "a day carries a per-model breakdown for stacking");
  if (dayWithBoth) {
    const sum =
      dayWithBoth.models["anthropic/claude-sonnet-4.5"].cost +
      dayWithBoth.models["openai/gpt-5"].cost;
    assert(Math.abs(sum - dayWithBoth.cost) < 1e-9, "per-model day costs sum to the day total");
  }

  // Lines written aggregation + per-model attribution.
  assert(r30.totalLinesAdded === 160, `30d total lines added (got ${r30.totalLinesAdded})`);
  assert(r30.totalLinesRemoved === 30, `30d total lines removed (got ${r30.totalLinesRemoved})`);
  const sonnet = r30.byModel.find((m) => m.model === "anthropic/claude-sonnet-4.5");
  assert(sonnet?.linesAdded === 120, `sonnet lines added attributed (got ${sonnet?.linesAdded})`);
  const gpt = r30.byModel.find((m) => m.model === "openai/gpt-5");
  assert(gpt?.linesAdded === 40, `gpt-5 lines added attributed (got ${gpt?.linesAdded})`);

  const r90 = store.aggregate(90);
  assert(Math.abs(r90.totalCost - 5.06) < 1e-9, `90d includes the 45-day event (got ${r90.totalCost})`);

  // Daily series should place today's window end last and be chronological.
  const dates = r30.daily.map((d) => d.date);
  const sorted = [...dates].sort();
  assert(JSON.stringify(dates) === JSON.stringify(sorted), "daily series is chronological");

  if (failures) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll usage aggregation checks pass. ✓");
}

main();
