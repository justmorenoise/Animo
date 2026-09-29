import { AssetStore } from "@/app/AssetStore";
import { perf } from "@/app/perf";
import { createImageItem } from "@/core/doc/defaults";
import type { ImageItem, Project } from "@/core/doc/types";
import { checkBudgets, type Budget, type BudgetResult } from "@/core/perf/stats";
import { buildExport } from "@/io/export/ExportBundle";
import { deserializeProject, serializeProject } from "@/io/project/ProjectFile";
import { BENCH_PRESETS, buildBenchProject, describeBench } from "./benchStructure";

/**
 * Timings of the work that can hold the page up, on a document of a chosen
 * size. Development only (`main.ts` loads it under `import.meta.env.DEV`):
 * run `await animoBench.run()` in the console, or read `animoBench.budgets`.
 */
export interface BenchOptions {
  preset: keyof typeof BENCH_PRESETS;
  images: number;
  /** Side of each square image, in pixels. */
  size: number;
  /** How many times each scenario is timed. */
  repeat: number;
}

export const DEFAULT_BENCH: BenchOptions = { preset: "medium", images: 40, size: 1024, repeat: 5 };

/** What the editor promises to stay under on a document of the default size. */
export const BUDGETS: Budget[] = [
  { label: "project.deserialize", ms: 3000, stat: "median" },
  { label: "project.serialize", ms: 500, stat: "median" },
  { label: "export.skeleton", ms: 50, stat: "median" },
  { label: "export.build", ms: 4000, stat: "max" },
];

/** Time the page could not answer input during a scenario: the long tasks
 *  (over 50 ms) the browser reports, which is what a user feels as lag. */
export interface Blocked {
  scenario: string;
  wall: number;
  /** Sum of the long tasks. */
  blocked: number;
  /** The longest single stall. */
  longest: number;
  tasks: number;
}

export interface BenchReport {
  options: BenchOptions;
  document: { items: number; nodes: number; keys: number; bytes: number };
  rows: Array<Record<string, number | string>>;
  blocked: Blocked[];
  budgets: BudgetResult[];
}

async function withBlocked(scenario: string, into: Blocked[], fn: () => Promise<unknown>): Promise<void> {
  const tasks: number[] = [];
  const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) tasks.push(e.duration); });
  observer.observe({ type: "longtask", buffered: false });
  const start = performance.now();
  await fn();
  // The observer reports in batches; give it a turn to deliver.
  await new Promise((r) => setTimeout(r, 120));
  tasks.push(...observer.takeRecords().map((e) => e.duration));
  observer.disconnect();
  into.push({
    scenario, wall: Math.round(performance.now() - start),
    blocked: Math.round(tasks.reduce((a, b) => a + b, 0)),
    longest: Math.round(Math.max(0, ...tasks)), tasks: tasks.length,
  });
}

/** A repeatable pseudo-random source, so a picture is the same on every run. */
function random(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Art with a transparent margin and enough detail that the PNG is not tiny. */
async function sprite(size: number, seed: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const rnd = random(seed + 1);
  const margin = Math.floor(size * 0.2);
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = `hsla(${Math.floor(rnd() * 360)}, 70%, 55%, ${0.4 + rnd() * 0.6})`;
    const w = 8 + rnd() * size * 0.3, h = 8 + rnd() * size * 0.3;
    ctx.fillRect(margin + rnd() * (size - 2 * margin - w), margin + rnd() * (size - 2 * margin - h), w, h);
  }
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
}

async function makeImages(assets: AssetStore, count: number, size: number): Promise<ImageItem[]> {
  const items: ImageItem[] = [];
  for (let i = 0; i < count; i++) {
    const asset = await assets.addFromBlob(await sprite(size, i), `art${i}`);
    items.push(createImageItem(`art${i}`, asset.id, asset.width, asset.height));
  }
  return items;
}

async function times(n: number, fn: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < n; i++) await fn();
}

/** A document freshly read from bytes: new `Asset` objects, so nothing is cached. */
async function reopen(data: ArrayBuffer): Promise<{ project: Project; assets: AssetStore }> {
  const assets = new AssetStore();
  const { project } = await deserializeProject(data, assets);
  return { project, assets };
}

export async function runBench(options: Partial<BenchOptions> = {}): Promise<BenchReport> {
  const o = { ...DEFAULT_BENCH, ...options };
  const assets = new AssetStore();
  const images = await makeImages(assets, o.images, o.size);
  const project = buildBenchProject(BENCH_PRESETS[o.preset]!, images);
  const blob = await serializeProject(project, assets);
  const data = await blob.arrayBuffer();
  perf.clear();

  const blocked: Blocked[] = [];
  await withBlocked("save (indented)", blocked, () =>
    times(o.repeat, async () => { await serializeProject(project, assets); }));
  perf.clear("project.serialize");
  await withBlocked("autosave (compact)", blocked, () =>
    times(o.repeat, async () => { await serializeProject(project, assets, { pretty: false }); }));
  await withBlocked("open (deserialise)", blocked, () =>
    times(o.repeat, async () => { await reopen(data); }));
  // Cold: every run reads the file again, so no trim or page is cached.
  await withBlocked("preview build, cold", blocked, () => times(o.repeat, async () => {
    const fresh = await reopen(data);
    await buildExport(fresh.project, fresh.assets);
  }));
  // Warm: the same document built again.
  const warm = await reopen(data);
  await buildExport(warm.project, warm.assets);
  await withBlocked("preview build, warm", blocked, () =>
    times(o.repeat, async () => { await buildExport(warm.project, warm.assets); }));

  const summaries = perf.summaries();
  return {
    options: o,
    document: { ...describeBench(project), bytes: blob.size },
    rows: perf.report(),
    blocked,
    budgets: checkBudgets(summaries, BUDGETS),
  };
}
