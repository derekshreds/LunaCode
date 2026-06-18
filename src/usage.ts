import * as vscode from "vscode";
import { DailyPoint, ModelPoint, UsageReport } from "./webview/protocol";

export interface UsageEvent {
  ts: number;
  model: string;
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
}

export interface CodeEvent {
  ts: number;
  model: string;
  added: number;
  removed: number;
}

const KEY = "lunacode.usage.events";
const CODE_KEY = "lunacode.usage.code";
const MAX_EVENTS = 20000;
const PRUNE_DAYS = 120;

/**
 * Persists per-turn token/cost usage AND per-edit code-line counts in global
 * state (across all workspaces) so the analytics window can report spend and
 * lines written over the last 30/60/90 days, broken down by model.
 */
export class UsageStore {
  constructor(private memento: vscode.Memento) {}

  private readEvents(): UsageEvent[] {
    return this.memento.get<UsageEvent[]>(KEY, []);
  }
  private readCode(): CodeEvent[] {
    return this.memento.get<CodeEvent[]>(CODE_KEY, []);
  }

  async record(ev: UsageEvent): Promise<void> {
    if (!ev.cost && !ev.prompt && !ev.completion) return;
    await this.append(KEY, this.readEvents(), ev);
  }

  async recordCode(ev: CodeEvent): Promise<void> {
    if (!ev.added && !ev.removed) return;
    await this.append(CODE_KEY, this.readCode(), ev);
  }

  private async append<T extends { ts: number }>(key: string, list: T[], ev: T): Promise<void> {
    const cutoff = Date.now() - PRUNE_DAYS * 86400000;
    let next = list.filter((e) => e.ts >= cutoff);
    next.push(ev);
    if (next.length > MAX_EVENTS) next = next.slice(next.length - MAX_EVENTS);
    await this.memento.update(key, next);
  }

  async clear(): Promise<void> {
    await this.memento.update(KEY, []);
    await this.memento.update(CODE_KEY, []);
  }

  aggregate(days: number): UsageReport {
    const now = Date.now();
    const cutoff = now - days * 86400000;
    const events = this.readEvents().filter((e) => e.ts >= cutoff);
    const codeEvents = this.readCode().filter((e) => e.ts >= cutoff);

    let totalCost = 0,
      totalPrompt = 0,
      totalCompletion = 0,
      totalCached = 0,
      totalLinesAdded = 0,
      totalLinesRemoved = 0;
    const dayMap = new Map<string, DailyPoint>();
    const modelMap = new Map<string, ModelPoint>();

    const day = (ts: number): DailyPoint => {
      const key = dateKey(ts);
      let d = dayMap.get(key);
      if (!d) {
        d = {
          date: key,
          cost: 0,
          prompt: 0,
          completion: 0,
          cached: 0,
          linesAdded: 0,
          linesRemoved: 0,
          models: {},
        };
        dayMap.set(key, d);
      }
      return d;
    };
    const dayModel = (d: DailyPoint, model: string) => {
      const m = d.models[model] ?? { cost: 0, tokens: 0, added: 0, removed: 0 };
      d.models[model] = m;
      return m;
    };
    const model = (name: string): ModelPoint => {
      let m = modelMap.get(name);
      if (!m) {
        m = { model: name, cost: 0, tokens: 0, count: 0, linesAdded: 0, linesRemoved: 0 };
        modelMap.set(name, m);
      }
      return m;
    };

    for (const e of events) {
      totalCost += e.cost || 0;
      totalPrompt += e.prompt || 0;
      totalCompletion += e.completion || 0;
      totalCached += e.cached || 0;
      const d = day(e.ts);
      d.cost += e.cost || 0;
      d.prompt += e.prompt || 0;
      d.completion += e.completion || 0;
      d.cached += e.cached || 0;
      const dm = dayModel(d, e.model);
      dm.cost += e.cost || 0;
      dm.tokens += (e.prompt || 0) + (e.completion || 0);
      const m = model(e.model);
      m.cost += e.cost || 0;
      m.tokens += (e.prompt || 0) + (e.completion || 0);
      m.count += 1;
    }

    for (const e of codeEvents) {
      totalLinesAdded += e.added || 0;
      totalLinesRemoved += e.removed || 0;
      const d = day(e.ts);
      d.linesAdded += e.added || 0;
      d.linesRemoved += e.removed || 0;
      const dm = dayModel(d, e.model);
      dm.added += e.added || 0;
      dm.removed += e.removed || 0;
      const m = model(e.model);
      m.linesAdded += e.added || 0;
      m.linesRemoved += e.removed || 0;
    }

    // Fill every day in the window so the chart has a continuous x-axis.
    const daily: DailyPoint[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const key = dateKey(now - i * 86400000);
      daily.push(
        dayMap.get(key) ?? {
          date: key,
          cost: 0,
          prompt: 0,
          completion: 0,
          cached: 0,
          linesAdded: 0,
          linesRemoved: 0,
          models: {},
        }
      );
    }

    const byModel = [...modelMap.values()].sort((a, b) => b.cost - a.cost);

    return {
      days,
      totalCost,
      totalPrompt,
      totalCompletion,
      totalCached,
      totalLinesAdded,
      totalLinesRemoved,
      turns: events.length,
      daily,
      byModel,
    };
  }
}

function dateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
