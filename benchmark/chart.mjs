// The chart the README leads its benchmarks with: the requests per second of
// platform-bun on Bun against platform-node on Node and on Bun, on every
// workload of both benchmarks, drawn from the runs' raw.json as one SVG file
// per color scheme:
//   node benchmark/chart.mjs [--controllers DIR] [--nest DIR] [--output DIR]
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatorName } from "./environment.mjs";
import { controllersMedians } from "./report.mjs";

export const SERIES = [
  { label: "platform-bun on Bun", controllers: "bun", nest: "nest-bun@bun" },
  {
    label: "platform-node on Node",
    controllers: "node-node",
    nest: "nest-node@node",
  },
  {
    label: "platform-node on Bun",
    controllers: "node-bun",
    nest: "nest-node@bun",
  },
];

// platform-bun in the accent, the platform-node baselines in two grays. Run
// through the dataviz palette validator: the three pass its lightness band,
// CVD and normal-vision separation in both schemes; the grays read gray by
// design, and the lighter one is under 3:1 against the surface, which the
// value on every bar and the README's table relieve.
export const THEMES = {
  light: {
    surface: "#fcfcfb",
    border: "#e1e0d9",
    primary: "#0b0b0b",
    secondary: "#52514e",
    series: ["#2a78d6", "#6f6e69", "#a8a79f"],
  },
  dark: {
    surface: "#1a1a19",
    border: "#2c2c2a",
    primary: "#f0efec",
    secondary: "#c3c2b7",
    series: ["#3987e5", "#96958e", "#62615c"],
  },
};

const WIDTH = 720;
const PAD = 24;
// The left column holds the workloads; the right margin, the longest value
const LABELS = 150;
const VALUES = 64;
const BAR = 14;
const GAP = 3;
const GROUP_GAP = 16;
// The title, platform-bun's leads and the legend come first
const LEADS = 62;
const LINE = 18;
const LEGEND = 108;
const TOP = 138;
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

const format = (value) =>
  Math.round(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
// Text in an element: only & and < would end it, or read as markup
const escape = (text) =>
  String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const round = (n) => Math.round(n * 10) / 10;

// A rate the chart can draw, and divide by: measured and positive
function rate(value, series, workload) {
  if (!(value > 0 && Number.isFinite(value)))
    throw new Error(
      `The runs have no positive rate for ${series.label} on ${workload}`,
    );
  return value;
}

// How much more (or less) a serves than b, in whole percent, with its sign
function change(a, b) {
  const percent = Math.round(((a - b) / b) * 100);
  return `${percent < 0 ? "−" : "+"}${Math.abs(percent)}%`;
}

const distinct = (values) => [...new Set(values)].join(" and ");

/** The chart's workloads, each with the three targets' requests/s, from the two runs' raw.json */
export function chartData(controllers, nest) {
  // The chart, like the run's report, gives no lead from an incomplete run
  if (!controllers.metadata.completed)
    throw new Error(
      "The controllers run is incomplete: neither its report nor the chart gives a lead from it",
    );
  const medians = controllersMedians(controllers);
  const groups = controllers.scenarios.map((scenario) => {
    const label = `${scenario.method} ${scenario.path}`;
    return {
      section: "Controllers benchmark",
      label,
      values: SERIES.map((series) =>
        rate(
          medians.get(`${series.controllers}:${scenario.name}`),
          series,
          label,
        ),
      ),
    };
  });
  // Nest's runner reports a target's failures rather than stopping; the chart
  // draws only targets that met none
  const summaries = new Map(nest.summaries.map((s) => [s.target, s]));
  groups.push({
    section: "Nest's benchmark",
    label: "GET /",
    values: SERIES.map((series) => {
      const summary = summaries.get(series.nest);
      if (summary && summary.errors + summary.timeouts + summary.non2xx > 0)
        throw new Error(
          `${series.label} met errors, timeouts or error answers in Nest's benchmark`,
        );
      return rate(summary?.requestsPerSecAvg, series, "Nest's benchmark");
    }),
  });
  // platform-bun's lead over each platform-node target, from its least to its most
  const leads = SERIES.slice(1).map((series, index) => {
    const percents = groups.map(
      (group) =>
        (group.values[0] - group.values[index + 1]) / group.values[index + 1],
    );
    const low = Math.min(...percents);
    const high = Math.max(...percents);
    return {
      against: series.label,
      range: `${change(1 + low, 1)} to ${change(1 + high, 1)}`,
    };
  });
  const { settings, environment } = controllers.metadata;
  const runs = [environment, nest.environment];
  return {
    groups,
    leads,
    details: {
      "Controllers benchmark": `${generatorName(environment)} · ${settings.connections} connections · median of ${settings.rounds} rounds`,
      "Nest's benchmark": `${generatorName(nest.environment)} · ${nest.args.connections} connections · pipelining ${nest.args.pipelining} · median of ${nest.args.rounds} rounds`,
    },
    note: `Node ${distinct(runs.map((run) => run.runtimes.node.version))} · Bun ${distinct(runs.map((run) => run.runtimes.bun.version))} · ${distinct(runs.map((run) => run.host.cpu))} · server and load generator on one machine`,
  };
}

// The step a scale rounds up to: half a power of ten
function scaleFor(max) {
  const step = 10 ** Math.floor(Math.log10(max)) / 2;
  return Math.ceil(max / step) * step;
}

/** Where every bar, workload and section goes; one scale for all */
export function layoutChart(groups) {
  const x = PAD + LABELS;
  const span = WIDTH - PAD - VALUES - x;
  const scaleMax = scaleFor(Math.max(...groups.flatMap((g) => g.values)));
  const bars = [];
  const labels = [];
  const sections = [];
  let y = TOP;
  let section;
  for (const group of groups) {
    if (group.section !== section) {
      section = group.section;
      if (sections.length) y += 8;
      sections.push({ text: section, y });
      y += 22;
    }
    const height = group.values.length * BAR + (group.values.length - 1) * GAP;
    labels.push({ text: group.label, y: y + height / 2 });
    group.values.forEach((value, series) => {
      bars.push({
        x,
        y: y + series * (BAR + GAP),
        width: (value / scaleMax) * span,
        height: BAR,
        value,
        series,
        group: group.label,
        section: group.section,
      });
    });
    y += height + GROUP_GAP;
  }
  return { bars, labels, sections, scaleMax, height: y + 28 };
}

// A bar squared at the baseline with a 4 px rounded end
function barPath({ x, y, width, height }) {
  const r = Math.min(4, width / 2, height / 2);
  return `M${round(x)} ${round(y)}h${round(width - r)}a${r} ${r} 0 0 1 ${r} ${r}v${round(height - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${r}h${round(-(width - r))}z`;
}

/** Every value in words, for the image's description */
function describeChart({ groups }) {
  return groups
    .map(
      (group) =>
        `${group.section}, ${group.label}: ${group.values
          .map((value, index) => `${SERIES[index].label} ${format(value)}`)
          .join(", ")}.`,
    )
    .join(" ");
}

/** The chart as an SVG document, for the `light` or `dark` color scheme */
export function renderChart(data, scheme) {
  const theme = THEMES[scheme];
  const { bars, labels, sections, height } = layoutChart(data.groups);
  const text = (x, y, content, attributes = "") =>
    `<text x="${round(x)}" y="${round(y)}"${attributes}>${escape(content)}</text>`;
  const span = (content, attributes = "") =>
    `<tspan${attributes}>${escape(content)}</tspan>`;
  const leads = data.leads.map(
    (lead, index) =>
      `<text x="${PAD}" y="${LEADS + index * LINE}" font-size="13" fill="${theme.primary}">${span(`${SERIES[0].label} against ${lead.against}:`)}${span(lead.range, ' dx="5" font-weight="600"')}</text>`,
  );
  // The legend's entries, at widths that fit their names
  let legendX = PAD;
  const legend = SERIES.map((series, index) => {
    const entry = `<rect x="${legendX}" y="${LEGEND - 10}" width="12" height="12" rx="3" fill="${theme.series[index]}"/>${text(legendX + 18, LEGEND, series.label, ` fill="${theme.primary}"`)}`;
    legendX += 18 + series.label.length * 7 + 28;
    return entry;
  });
  const marks = bars.map((bar) => {
    const accent = bar.series === 0;
    return `<path d="${barPath(bar)}" fill="${theme.series[bar.series]}"><title>${escape(`${SERIES[bar.series].label}, ${bar.section}, ${bar.group}: ${format(bar.value)} requests/s`)}</title></path>${text(bar.x + bar.width + 6, bar.y + bar.height / 2, format(bar.value), ` dy="0.35em" fill="${accent ? theme.primary : theme.secondary}"${accent ? ' font-weight="600"' : ""}`)}`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="title desc" font-family="${FONT}" font-size="12">
<title id="title">Requests per second: platform-bun on Bun against platform-node on Node and on Bun</title>
<desc id="desc">${escape(describeChart(data))}</desc>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12" fill="${theme.surface}" stroke="${theme.border}"/>
${text(PAD, 38, "Requests per second, higher is better", ` font-size="17" font-weight="600" fill="${theme.primary}"`)}
${leads.join("\n")}
${legend.join("\n")}
${sections.map((section) => `<text x="${PAD}" y="${section.y + 12}" fill="${theme.secondary}">${span(section.text, ' font-weight="600"')}${span(data.details[section.text], ' dx="10"')}</text>`).join("\n")}
${labels.map((label) => text(PAD, label.y, label.text, ` dy="0.35em" font-size="13" fill="${theme.primary}"`)).join("\n")}
${marks.join("\n")}
${text(PAD, height - 18, data.note, ` font-size="11" fill="${theme.secondary}"`)}
</svg>
`;
}

// As a command: both color schemes, from the default runs or those given
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index === -1 ? fallback : process.argv[index + 1];
  };
  const results = join(dirname(fileURLToPath(import.meta.url)), "results");
  const read = async (directory) =>
    JSON.parse(await readFile(join(directory, "raw.json"), "utf8"));
  const data = chartData(
    await read(option("controllers", join(results, "controllers-autocannon"))),
    await read(option("nest", join(results, "nest-autocannon"))),
  );
  const output = option("output", results);
  for (const scheme of ["light", "dark"]) {
    const file = join(output, `chart-${scheme}.svg`);
    await writeFile(file, renderChart(data, scheme));
    process.stdout.write(`${file}\n`);
  }
}
