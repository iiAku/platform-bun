// The softirq time of the servers' CPUs: on loopback the kernel delivers each
// segment to its reader, and wakes it, in softirq on the sender's CPU, time
// that a kernel accounting IRQ time on its own books to no process.
import { expect, test } from "bun:test";
import { softirqCores } from "../../benchmark/environment.mjs";

// A /proc/stat reading: the all-CPU line, one line per CPU (user nice system
// idle iowait irq softirq steal guest guest_nice, in clock ticks), the rest
const procStat = (perCpu: number[][]) =>
  [
    `cpu  ${perCpu[0]!.map((_, i) => perCpu.reduce((sum, cpu) => sum + cpu[i]!, 0)).join(" ")}`,
    ...perCpu.map((times, cpu) => `cpu${cpu} ${times.join(" ")}`),
    "intr 123456 0 0",
    "ctxt 987654",
    "softirq 5000 10 20 30 40 50 60 70 80 90 100",
  ].join("\n");

const before = procStat([
  [100, 0, 50, 1000, 0, 5, 10, 0, 0, 0],
  [100, 0, 50, 1000, 0, 5, 10, 0, 0, 0],
  [100, 0, 50, 1000, 0, 5, 10, 0, 0, 0],
  [100, 0, 50, 1000, 0, 5, 10, 0, 0, 0],
]);
// Two seconds at 100 ticks per second: CPU n spent 10(n+1) ticks in softirq,
// and other ticks in every other kind of time
const after = procStat([
  [150, 0, 90, 1080, 0, 7, 20, 0, 0, 0],
  [150, 0, 90, 1060, 0, 9, 30, 0, 0, 0],
  [150, 0, 90, 1040, 0, 11, 40, 0, 0, 0],
  [150, 0, 90, 1020, 0, 13, 50, 0, 0, 0],
]);

test("the softirq time of a run's server CPUs counts those CPUs alone, in cores", () => {
  // CPUs 1 and 3: 20 + 40 ticks over 2 s at 100 ticks per second
  expect(softirqCores(before, after, "1,3", 2, 100)).toBeCloseTo(0.3, 10);
  expect(softirqCores(before, after, "0-2", 2, 100)).toBeCloseTo(0.3, 10);
  expect(softirqCores(before, after, "2", 4, 50)).toBeCloseTo(0.15, 10);
});

test("a server without CPUs of its own has no softirq time of its own", () => {
  expect(softirqCores(before, after, undefined, 2, 100)).toBeUndefined();
});

test("a host without /proc/stat readings reports no softirq time", () => {
  expect(softirqCores(undefined, after, "1,3", 2, 100)).toBeUndefined();
  expect(softirqCores(before, undefined, "1,3", 2, 100)).toBeUndefined();
});
