import { describe, it, expect } from "vitest";
import { type BusyTask, busyView, phase } from "@/app/busy";

const T = { delay: 500, minShown: 400 };
const task = (id: number, startedAt: number): BusyTask => ({ id, label: `t${id}`, startedAt, progress: null });

describe("busyView", () => {
  it.each([
    // tasks, now, shownSince → show, rows, wakeAt
    { name: "nothing running", tasks: [], now: 0, since: null, show: false, rows: [], wake: null },
    { name: "a fresh task waits for the delay", tasks: [task(1, 0)], now: 100, since: null, show: false, rows: [], wake: 500 },
    { name: "at the delay it shows", tasks: [task(1, 0)], now: 500, since: null, show: true, rows: [1], wake: null },
    { name: "only tasks past the delay are listed, oldest first", tasks: [task(2, 300), task(1, 0)], now: 600, since: 500,
      show: true, rows: [1], wake: 800 },
    { name: "done, but shown for less than minShown: lingers", tasks: [], now: 700, since: 500, show: true, rows: [], wake: 900 },
    { name: "done and shown long enough: hides", tasks: [], now: 900, since: 500, show: false, rows: [], wake: null },
  ])("$name", ({ tasks, now, since, show, rows, wake }) => {
    const v = busyView(tasks, now, since, T);
    expect(v.show).toBe(show);
    expect(v.rows.map((r) => r.id)).toEqual(rows);
    expect(v.wakeAt).toBe(wake);
  });
});

describe("phase", () => {
  it("maps a phase's 0..1 into its slice, clamped", () => {
    const seen: number[] = [];
    const p = phase((f) => seen.push(f), 0.2, 0.6);
    p(0); p(0.5); p(1); p(2); p(-1);
    expect(seen.map((f) => +f.toFixed(3))).toEqual([0.2, 0.4, 0.6, 0.6, 0.2]);
  });
});
