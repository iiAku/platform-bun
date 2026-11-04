// The report of a run of Nest's benchmark, rendered from what the run keeps
// in its raw.json, so that a report can be rendered again from its data.
import { environmentMarkdown, shellPath } from "../environment.mjs";
import {
  adapterName,
  isNestAdapter,
  nestTargetLabel,
  nestTargetRank,
  serverLabel,
  serverOf,
} from "../labels.mjs";

/** What every server of Nest's benchmark answers GET / with */
export const BODY = "Hello world!";

export const fmt = (n, digits = 0) =>
  Number.isFinite(n)
    ? n.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      })
    : "n/a";

// How much more (or less) a serves than b, with a true minus sign
function change(a, b) {
  if (!b) return "n/a";
  const percent = ((a - b) / b) * 100;
  return `${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(1)}%`;
}

function compare(a, b) {
  return `${change(a.requestsPerSecAvg, b.requestsPerSecAvg)} (${fmt(a.requestsPerSecAvg)} against ${fmt(b.requestsPerSecAvg)} requests/s)`;
}

function comparisons(ordered) {
  const by = new Map(ordered.map((s) => [s.target, s]));
  const adapters = ordered.filter((s) => isNestAdapter(s.framework));
  const sections = [];
  const bun = by.get("nest-bun@bun");
  const others = adapters.filter((s) => s !== bun);
  if (bun && others.length)
    sections.push([
      "platform-bun on Bun against the other Nest adapters:",
      "",
      ...others.map(
        (s) =>
          `- ${nestTargetLabel(s.framework, s.runtime)}: ${compare(bun, s)}`,
      ),
    ]);
  const moved = adapters.filter(
    (s) => s.runtime === "bun" && by.has(`${s.framework}@node`),
  );
  if (moved.length)
    sections.push([
      "Each Nest adapter on Bun against itself on Node:",
      "",
      ...moved.map(
        (s) =>
          `- ${adapterName(s.framework)}: ${compare(s, by.get(`${s.framework}@node`))}`,
      ),
    ]);
  const costs = adapters.filter((s) =>
    by.has(`${serverOf(s.framework)}@${s.runtime}`),
  );
  if (costs.length)
    sections.push([
      "Each Nest adapter against its server without Nest, on the same runtime:",
      "",
      ...costs.map(
        (s) =>
          `- ${nestTargetLabel(s.framework, s.runtime)} against ${serverLabel(serverOf(s.framework), s.runtime)}: ${compare(s, by.get(`${serverOf(s.framework)}@${s.runtime}`))}`,
      ),
    ]);
  return sections.map((lines) => lines.join("\n")).join("\n\n");
}

/** The report of a run, from its raw.json: `{ startedAt, args, environment, summaries }` */
export function renderNestReport({ startedAt, args, environment, summaries }) {
  const wrk = args.generator === "wrk";
  const ordered = [...summaries].sort(
    (a, b) =>
      nestTargetRank(a.framework, a.runtime) -
      nestTargetRank(b.framework, b.runtime),
  );
  const label = (s) => nestTargetLabel(s.framework, s.runtime);
  const cores = (n) => (n === undefined ? "?" : fmt(n, 2));
  const rates = ordered.map(
    (s) =>
      `| ${label(s)} | ${fmt(s.requestsPerSecAvg)} | ${fmt(s.requestsPerSecMin)}–${fmt(s.requestsPerSecMax)} |`,
  );
  const loads = ordered.map(
    (s) =>
      `| ${label(s)} | ${cores(s.serverCpu)} | ${cores(s.serverSoftirqCpu)} | ${fmt(s.generatorCpu, 2)} | ${fmt(s.latencyAvgMs, 2)} | ${fmt(s.latencyP99Ms)} | ${fmt(s.throughputBytesPerSecAvg / 1024 / 1024, 1)} MB/s | ${s.errors} / ${s.timeouts} / ${wrk ? s.httpErrors : s.non2xx} |`,
  );
  const generator = wrk
    ? `wrk with ${args.threads} threads, in a child process: each connection sends its ${args.pipelining} requests as one batch, and its next batch once all ${args.pipelining} responses have arrived, where autocannon sends a request as each response arrives`
    : "autocannon, in the runner process";
  const rounds = `${args.rounds} round${args.rounds === 1 ? "" : "s"}`;
  const compared = comparisons(ordered);
  return `# Nest's benchmark: platform-bun against platform-node

Nest's own benchmark (\`tools/benchmarks\` at commit 59f33793), run on ${startedAt.slice(0, 10)} at ${startedAt.slice(11, 16)} UTC: every server answers GET \`/\` with "${BODY}" (Nest with \`bodyParser: false\` and \`logger: false\`) to ${args.connections} connections with pipelining ${args.pipelining}, one server at a time. The load generator is ${generator}. Each target ran ${rounds} of a ${args.duration} s warm-up then ${args.duration} s measured, the target order rotating between rounds; the figures are medians over the rounds.

## Requests per second

| Target | Median req/s | Min–max req/s |
|---|---:|---:|
${rates.join("\n")}
${compared ? `\n${compared}\n` : ""}
## Server and load generator

| Target | Server CPU cores | Softirq cores on server CPUs | Generator CPU cores | Latency avg ms | p99 ms | Throughput | Errors / timeouts / ${wrk ? "4xx–5xx" : "non-2xx"} |
|---|---:|---:|---:|---:|---:|---:|---:|
${loads.join("\n")}

The targets marked "(no Nest)" are the servers alone, answering with the same body; \`Bun.serve()\` alone is the runtime's ceiling. Server CPU is the server process's own time. Softirq is the kernel's time on the server's CPUs outside any process: on loopback, mostly delivering the server's responses to the load generator and waking it, which a kernel that accounts IRQ time on its own (\`CONFIG_IRQ_TIME_ACCOUNTING\`) books to no process. A single-threaded server is saturated when the two add up to about one core (helper threads, such as a garbage collector's, add a little to the first); when the generator's CPU cores approach one, or the ceiling target is as fast as the adapters, the generator is the limit. This is a loopback microbenchmark on one machine, the load generator sharing it: it ranks adapters on this workload and nothing else.${
    wrk
      ? `

wrk's latency is not reported: under pipelining it times batches rather than requests, and corrects its samples for coordinated omission at the interval of a request, which puts samples below its own minimum (its 90th and 99th percentiles then read 0). wrk counts 4xx and 5xx answers but not redirects; each server's reply is checked, status and body, before its runs.`
      : ""
  }

${environmentMarkdown(environment).join("\n")}

## Reproduce

\`\`\`sh
bun run build
node benchmark/nest/main.mjs --targets ${args.targets.map((t) => t.name).join(",")} --rounds ${args.rounds} --connections ${args.connections} --duration ${args.duration} --pipelining ${args.pipelining} --node ${shellPath(args.node)} --bun ${shellPath(args.bun)}${wrk ? ` --generator wrk --wrk ${shellPath(args.wrk)} --threads ${args.threads}` : ""}
\`\`\`
`;
}
