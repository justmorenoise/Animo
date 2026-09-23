/**
 * When the "working…" indicator shows, as a pure function of the running
 * tasks and the clock. The widget (`view/widgets/Busy.ts`) only renders it.
 *
 * A task appears once it has run for `delay`: most operations finish well
 * before that and a flash of a progress bar is noise. Once the indicator is
 * up it stays for at least `minShown`, so it never blinks out a frame after
 * appearing.
 */

export interface BusyTask {
  id: number;
  label: string;
  startedAt: number;
  /** 0..1, or null while the task cannot say how far along it is. */
  progress: number | null;
}

export interface BusyTiming {
  delay: number;
  minShown: number;
}

export const BUSY_TIMING: Readonly<BusyTiming> = Object.freeze({ delay: 500, minShown: 400 });

export interface BusyView {
  /** Whether the indicator is on screen. */
  show: boolean;
  /** The tasks it lists: those running for at least `delay`, oldest first. */
  rows: BusyTask[];
  /** When the answer next changes without anything else happening; null: never. */
  wakeAt: number | null;
}

/** `shownSince` is when the indicator appeared, or null while it is hidden. */
export function busyView(
  tasks: readonly BusyTask[], now: number, shownSince: number | null, timing: BusyTiming = BUSY_TIMING,
): BusyView {
  const rows = tasks.filter((t) => now - t.startedAt >= timing.delay)
    .sort((a, b) => a.startedAt - b.startedAt);
  const lingering = shownSince !== null && now - shownSince < timing.minShown;
  const wakes: number[] = tasks
    .filter((t) => now - t.startedAt < timing.delay)
    .map((t) => t.startedAt + timing.delay);
  if (rows.length === 0 && lingering) wakes.push(shownSince + timing.minShown);
  return {
    show: rows.length > 0 || lingering,
    rows,
    wakeAt: wakes.length ? Math.min(...wakes) : null,
  };
}

/** A running task's progress callback: a fraction 0..1, clamped. */
export type ReportProgress = (fraction: number) => void;

/**
 * Something that runs a long task under the indicator. Services take one
 * (ProjectService, the PSD import) so they stay free of the DOM; the default
 * runs the task and shows nothing.
 */
export type RunBusy = <T>(label: string, task: (report: ReportProgress) => Promise<T>) => Promise<T>;

export const runQuietly: RunBusy = (_label, task) => task(() => {});

/** Maps a phase's own 0..1 into its slice [from, to] of the whole task. */
export function phase(report: ReportProgress, from: number, to: number): ReportProgress {
  return (f) => report(from + (to - from) * Math.max(0, Math.min(1, f)));
}
