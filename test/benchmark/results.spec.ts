// The committed runs and what is published from them: each report is what its
// raw.json renders, the chart is what the runs draw, and the README states
// their figures, so that none of them drifts from the data.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chartData, renderChart } from "../../benchmark/chart.mjs";
import { renderNestReport } from "../../benchmark/nest/report.mjs";
import { renderControllersReport } from "../../benchmark/report.mjs";

const RESULTS = join(import.meta.dir, "../../benchmark/results");
const run = async (name: string) =>
  JSON.parse(await readFile(join(RESULTS, name, "raw.json"), "utf8"));
const charted = async () =>
  chartData(await run("controllers-autocannon"), await run("nest-autocannon"));

test.each([
  "controllers-autocannon",
  "controllers-oha",
  "nest-autocannon",
  "nest-wrk",
])("the committed report of %s is what its raw data renders", async (name) => {
  const raw = await run(name);
  const rendered = Array.isArray(raw.summaries)
    ? renderNestReport(raw)
    : renderControllersReport(raw);
  expect(await readFile(join(RESULTS, name, "report.md"), "utf8")).toBe(
    rendered,
  );
});

test("the committed chart is what the committed autocannon runs draw, in both color schemes", async () => {
  const data = await charted();
  for (const scheme of ["light", "dark"] as const)
    expect(await readFile(join(RESULTS, `chart-${scheme}.svg`), "utf8")).toBe(
      renderChart(data, scheme),
    );
});

test("the README states the chart's figures and platform-bun's leads as the committed runs give them", async () => {
  const readme = await readFile(
    join(import.meta.dir, "../../README.md"),
    "utf8",
  );
  const { groups } = await charted();
  const alt = readme.match(
    /<img src="benchmark\/results\/chart-light\.svg"[^>]* alt="([^"]*)"/,
  )?.[1];
  for (const group of groups)
    for (const value of group.values)
      expect(alt).toContain(Math.round(value).toLocaleString("en-US"));
  // One row per platform-node target, one column per workload
  const lead = (ours: number, theirs: number) => {
    const percent = ((ours - theirs) / theirs) * 100;
    return `${percent < 0 ? "−" : "+"}${Math.abs(percent).toFixed(1)}%`;
  };
  for (const [index, name] of [
    [1, "platform-node on Node"],
    [2, "platform-node on Bun"],
  ] as const)
    expect(readme).toContain(
      `| ${name} | ${groups.map((group) => lead(group.values[0], group.values[index])).join(" | ")} |`,
    );
});
