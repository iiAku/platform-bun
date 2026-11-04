// The chart the README leads its benchmarks with: platform-bun on Bun against
// platform-node on Node and on Bun, on every workload of both benchmarks,
// drawn from the runs' raw.json.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chartData,
  layoutChart,
  renderChart,
  THEMES,
} from "../../benchmark/chart.mjs";
import {
  controllersRun,
  nestRun,
  nestSummary,
} from "../support/benchmark-runs";

// Whether a document is well-formed XML as the chart writes it: every element
// closed in order, attributes quoted, and no markup character left raw in text
function wellFormed(xml: string) {
  const tag = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<&]*")*)\s*(\/?)>/y;
  const open: string[] = [];
  let index = 0;
  for (;;) {
    const next = xml.indexOf("<", index);
    const text = xml.slice(index, next === -1 ? xml.length : next);
    if (/&(?!(amp|lt|gt|quot);)/.test(text)) return false;
    if (next === -1) return open.length === 0;
    tag.lastIndex = next;
    const match = tag.exec(xml);
    if (!match) return false;
    const [, closing, name, , empty] = match;
    if (closing) {
      if (open.pop() !== name) return false;
    } else if (!empty) open.push(name);
    index = tag.lastIndex;
  }
}

const controllers = controllersRun({
  bun: [179_034, 166_208, 132_000],
  "node-node": [141_094, 134_694, 101_843],
  "node-bun": [142_784, 145_779, 115_270],
  "raw-bun": [206_246, 197_030, 164_365],
});
const nest = nestRun([
  nestSummary("nest-bun", "bun", 198_231),
  nestSummary("nest-node", "node", 180_428),
  nestSummary("nest-node", "bun", 160_087),
  nestSummary("bun", "bun", 333_952),
]);

test("the chart compares platform-bun on Bun with platform-node on Node and on Bun on every workload of both benchmarks", () => {
  const { groups } = chartData(controllers, nest);
  expect(groups).toEqual([
    {
      section: "Controllers benchmark",
      label: "GET /",
      values: [179_034, 141_094, 142_784],
    },
    {
      section: "Controllers benchmark",
      label: "GET /users/42",
      values: [166_208, 134_694, 145_779],
    },
    {
      section: "Controllers benchmark",
      label: "POST /echo",
      values: [132_000, 101_843, 115_270],
    },
    {
      section: "Nest's benchmark",
      label: "GET /",
      values: [198_231, 180_428, 160_087],
    },
  ]);
});

test("the chart sums up platform-bun's lead over each platform-node target as its range over the workloads", () => {
  expect(chartData(controllers, nest).leads).toEqual([
    { against: "platform-node on Node", range: "+10% to +30%" },
    { against: "platform-node on Bun", range: "+14% to +25%" },
  ]);
});

test("each benchmark on the chart says how it was run, from its own run, and the chart which runtimes and machine ran them", () => {
  const wrk = {
    ...nest,
    environment: {
      ...nest.environment,
      runtimes: {
        ...nest.environment.runtimes,
        loadGenerator: { name: "wrk", version: "wrk 4.2.0", path: "/wrk" },
      },
    },
  };
  const data = chartData(controllers, wrk);
  expect(data.details).toEqual({
    "Controllers benchmark":
      "autocannon · 100 connections · median of 3 rounds",
    "Nest's benchmark":
      "wrk · 100 connections · pipelining 10 · median of 3 rounds",
  });
  expect(data.note).toBe(
    "Node v26.13.0 · Bun 1.4.4 · Test CPU · server and load generator on one machine",
  );
});

test("a run without one of the three targets cannot be charted", () => {
  const partial = nestRun([nestSummary("nest-bun", "bun", 198_231)]);
  expect(() => chartData(controllers, partial)).toThrow(
    "platform-node on Node",
  );
});

test("an incomplete controllers run cannot be charted, as its report gives no lead", () => {
  const incomplete = {
    ...controllers,
    metadata: { ...controllers.metadata, completed: false },
  };
  expect(() => chartData(incomplete, nest)).toThrow("incomplete");
});

test("a target with no positive rate cannot be charted", () => {
  const stalled = nestRun([
    nestSummary("nest-bun", "bun", 198_231),
    nestSummary("nest-node", "node", 0),
    nestSummary("nest-node", "bun", 160_087),
  ]);
  expect(() => chartData(controllers, stalled)).toThrow(
    "platform-node on Node",
  );
  const unmeasured = nestRun([
    nestSummary("nest-bun", "bun", Number.NaN),
    nestSummary("nest-node", "node", 180_428),
    nestSummary("nest-node", "bun", 160_087),
  ]);
  expect(() => chartData(controllers, unmeasured)).toThrow(
    "platform-bun on Bun",
  );
});

test("a target that met errors, timeouts or error answers in Nest's benchmark cannot be charted", () => {
  const failing = nestRun([
    nestSummary("nest-bun", "bun", 198_231),
    nestSummary("nest-node", "node", 180_428),
    { ...nestSummary("nest-node", "bun", 160_087), timeouts: 3 },
  ]);
  expect(() => chartData(controllers, failing)).toThrow("platform-node on Bun");
});

test("every bar grows from one baseline, its length proportional to its requests per second on one scale for both benchmarks", () => {
  const { bars, scaleMax } = layoutChart(chartData(controllers, nest).groups);
  expect(bars).toHaveLength(12);
  expect(new Set(bars.map((bar) => bar.x)).size).toBe(1);
  expect(scaleMax).toBeGreaterThanOrEqual(198_231);
  const perRequest = bars[0].width / bars[0].value;
  for (const bar of bars)
    expect(bar.width / bar.value).toBeCloseTo(perRequest, 9);
  // No bar overlaps the next one
  const tops = bars.map((bar) => bar.y).sort((a, b) => a - b);
  for (let index = 1; index < tops.length; index++)
    expect(tops[index] - tops[index - 1]).toBeGreaterThanOrEqual(
      bars[0].height,
    );
});

test("the chart labels every bar with its value, names the three targets in its legend and shows platform-bun's lead and how each benchmark ran, in both color schemes", () => {
  const data = chartData(controllers, nest);
  for (const scheme of ["light", "dark"] as const) {
    const svg = renderChart(data, scheme);
    expect(wellFormed(svg)).toBe(true);
    for (const workload of ["GET /", "GET /users/42", "POST /echo"])
      expect(svg).toContain(`>${workload}</text>`);
    // platform-bun's values stand out from the platform-node targets'
    expect(svg).toContain(
      `fill="${THEMES[scheme].primary}" font-weight="600">179,034</text>`,
    );
    expect(svg).toContain(`fill="${THEMES[scheme].secondary}">141,094</text>`);
    for (const value of ["179,034", "141,094", "142,784", "198,231"])
      expect(svg).toContain(`>${value}</text>`);
    // The legend pairs each target's color with its name
    for (const [index, name] of [
      "platform-bun on Bun",
      "platform-node on Node",
      "platform-node on Bun",
    ].entries())
      expect(svg).toMatch(
        new RegExp(
          `<rect [^>]*fill="${THEMES[scheme].series[index]}"/><text [^>]*>${name}</text>`,
        ),
      );
    expect(svg).toContain(">+10% to +30%</tspan>");
    expect(svg).toContain(
      ">autocannon · 100 connections · pipelining 10 · median of 3 rounds</tspan>",
    );
    expect(svg).toContain(
      ">Controllers benchmark, GET /: platform-bun on Bun 179,034, platform-node on Node 141,094, platform-node on Bun 142,784.",
    );
    expect(svg).toContain('role="img"');
  }
  expect(renderChart(data, "light")).not.toBe(renderChart(data, "dark"));
});

test("a workload whose name holds markup characters keeps the chart a well-formed document", () => {
  const marked = {
    ...controllers,
    scenarios: controllers.scenarios.map((scenario, index) =>
      index === 0 ? { ...scenario, path: "/a<b>&c" } : scenario,
    ),
  };
  const svg = renderChart(chartData(marked, nest), "light");
  expect(wellFormed(svg)).toBe(true);
  expect(svg).toContain(">GET /a&lt;b>&amp;c</text>");
});

test("the chart's command draws both color schemes from the runs it is given", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chart-"));
  try {
    for (const [name, run] of [
      ["controllers", controllers],
      ["nest", nest],
    ] as const) {
      await mkdir(join(directory, name));
      await writeFile(join(directory, name, "raw.json"), JSON.stringify(run));
    }
    const command = Bun.spawnSync([
      Bun.which("node")!,
      join(import.meta.dir, "../../benchmark/chart.mjs"),
      "--controllers",
      join(directory, "controllers"),
      "--nest",
      join(directory, "nest"),
      "--output",
      directory,
    ]);
    expect(command.exitCode).toBe(0);
    const data = chartData(controllers, nest);
    for (const scheme of ["light", "dark"] as const)
      expect(
        await readFile(join(directory, `chart-${scheme}.svg`), "utf8"),
      ).toBe(renderChart(data, scheme));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
