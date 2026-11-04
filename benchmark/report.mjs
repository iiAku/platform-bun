// The report of a run of the controllers benchmark (benchmark/run.ts),
// rendered from what the run keeps in its raw.json, so that a report can be
// rendered again from its data.
import { environmentMarkdown, shellPath } from "./environment.mjs";
import {
  controllersTargetLabel,
  controllersTargetRank,
  isControllersAdapter,
} from "./labels.mjs";

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}
function format(value, decimals = 0) {
  return value.toLocaleString("en-US", { maximumFractionDigits: decimals });
}
// How much more (or less) a serves than b, with a true minus sign
function change(a, b) {
  const percent = ((a - b) / b) * 100;
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
}
function sum(rows, count) {
  return rows.reduce((total, row) => total + (count(row) ?? 0), 0);
}

/** The median requests/s of each target and route over a run's valid trials, by `target:route` */
export function controllersMedians({ trials }) {
  const rates = new Map();
  for (const trial of trials) {
    if (!trial.valid) continue;
    const key = `${trial.target}:${trial.scenario}`;
    if (!rates.has(key)) rates.set(key, []);
    rates.get(key).push(trial.result.requests.average);
  }
  return new Map([...rates].map(([key, values]) => [key, median(values)]));
}

/** The report of a run, from its raw.json: `{ metadata, scenarios, trials }` */
export function renderControllersReport({ metadata, scenarios, trials }) {
  const { settings, environment } = metadata;
  const oha = settings.generator === "oha";
  const label = controllersTargetLabel;
  const targets = [...settings.targets].sort(
    (a, b) => controllersTargetRank(a) - controllersTargetRank(b),
  );
  const medians = controllersMedians({ trials });
  const details = [];
  for (const target of targets)
    for (const scenario of scenarios) {
      const rows = trials.filter(
        (trial) =>
          trial.valid &&
          trial.target === target &&
          trial.scenario === scenario.name,
      );
      if (!rows.length) continue;
      const requests = rows.map((row) => row.result.requests.average);
      details.push(
        `| ${label(target)} | ${scenario.method} \`${scenario.path}\` | ${format(median(requests))} | ${format(Math.min(...requests))}–${format(Math.max(...requests))} | ${format(median(rows.map((row) => row.result.latency.p99)), 2)} | ${sum(rows, (row) => row.result.errors)} / ${sum(rows, (row) => row.result.non2xx)} / ${oha ? "not checked" : sum(rows, (row) => row.result.mismatches)} |`,
      );
    }
  const routes = scenarios.map((s) => `${s.method} \`${s.path}\``);
  const header = [
    `| Target | ${routes.join(" | ")} |`,
    `|---|${routes.map(() => "---:").join("|")}|`,
  ];
  const measured = targets.filter((target) =>
    scenarios.some((s) => medians.has(`${target}:${s.name}`)),
  );
  const rates = measured.map(
    (target) =>
      `| ${label(target)} | ${scenarios
        .map((s) => {
          const value = medians.get(`${target}:${s.name}`);
          return value === undefined ? "n/a" : format(value);
        })
        .join(" | ")} |`,
  );
  const rivals = measured.filter(
    (target) => target !== "bun" && isControllersAdapter(target),
  );
  const leads =
    metadata.completed && measured.includes("bun")
      ? rivals.map(
          (target) =>
            `| ${label(target)} | ${scenarios
              .map((s) => {
                const ours = medians.get(`bun:${s.name}`);
                const theirs = medians.get(`${target}:${s.name}`);
                return ours && theirs ? change(ours, theirs) : "n/a";
              })
              .join(" | ")} |`,
        )
      : [];
  const total = settings.rounds * settings.targets.length * scenarios.length;
  const generator = oha
    ? "oha in a separate process, waiting at the end of a run for the requests in flight"
    : `${settings.workers} Node autocannon load workers in a separate process`;
  const lines = [
    "# Controllers benchmark: platform-bun against platform-node",
    "",
    `Real Nest ${environment.packages["@nestjs/core"]} controllers answer every Nest request, on every adapter with the same routes, methods, payloads and response bodies; no static route responses or application bypasses are used. Run on ${metadata.generatedAt.slice(0, 10)} at ${metadata.generatedAt.slice(11, 16)} UTC: ${trials.length} of ${total} measured trials completed (${metadata.completed ? "complete" : "incomplete"}). ${settings.connections} connections, pipelining ${settings.pipelining}, ${generator}. Each target ran ${settings.rounds} round${settings.rounds === 1 ? "" : "s"} of a ${settings.warmup} s warm-up then ${settings.duration} s measured per route, the target order rotating between rounds and the servers running one at a time; the figures are medians over the rounds.`,
    "",
    "## Requests per second",
    "",
    ...header,
    ...rates,
    "",
  ];
  if (leads.length)
    lines.push(
      "platform-bun on Bun against the other Nest adapters:",
      "",
      ...header,
      ...leads,
      "",
    );
  lines.push(
    "## Details",
    "",
    "| Target | Route | Median req/s | Min–max req/s | Median p99 ms | Errors / non-2xx / body mismatches |",
    "|---|---|---:|---:|---:|---:|",
    ...details,
    "",
    ...environmentMarkdown(environment),
    `- Runtimes the servers reported: ${measured
      .filter((target) => metadata.runtimes?.[target] !== undefined)
      .map((target) => `${label(target)}: ${metadata.runtimes[target]}`)
      .join("; ")}.`,
    "",
    "## Limits",
    "",
    "These are local HTTP/1.1 loopback microbenchmarks, with client and server sharing this machine. They measure these three workloads, not production application performance. Background load, CPU scheduling, runtime warm-up and the load generator can affect results. Min–max across rounds is shown; no statistical significance is claimed. POST returns Nest’s default 201. Express uses its default text/html media type for the returned string; the other adapters use text/plain, as in the original PR workload. `Bun.serve()` alone, if measured, is a transport ceiling with no Nest pipeline and is not an equivalent application baseline.",
    "",
    `Every scenario is checked for status, exact body and media type before warm-up. ${oha ? "oha does not check response bodies during load; non-2xx answers and transport errors, timeouts among them, invalidate a trial." : "Autocannon checks exact response bodies during load; non-2xx, transport errors, timeouts and mismatches invalidate a trial. p99 measurements have whole-millisecond precision."} All raw histograms, counters, trial order, timings, preflight response headers, server CPU samples (Linux) and host metadata are in \`raw.json\`.`,
    "",
    "## Reproduce",
    "",
    "```sh",
    "bun install --frozen-lockfile",
    "bun run build",
    `bun benchmark/run.ts --duration ${settings.duration} --warmup ${settings.warmup} --rounds ${settings.rounds} --connections ${settings.connections} --workers ${settings.workers} --targets ${settings.targets.join(",")} --node ${shellPath(settings.node)} --bun ${shellPath(settings.bun)}${oha ? ` --generator oha --oha ${shellPath(settings.oha)}` : ""}`,
    "```",
    "",
  );
  if (metadata.warnings?.length)
    lines.push(
      "Warnings:",
      "",
      ...metadata.warnings.map((warning) => `- ${warning}`),
      "",
    );
  return lines.join("\n");
}
