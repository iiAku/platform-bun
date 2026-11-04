import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { describeEnvironment, pinned, portablePath } from "./environment.mjs";
import { renderControllersReport } from "./report.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const project = resolve(directory, "..");
const cli = process.argv.slice(2);
if (cli.includes("--help") || cli.includes("-h")) {
  process.stdout.write(`Usage: bun benchmark/run.ts [options]
  --targets bun,node-bun,node-node,express-bun,fastify-bun[,raw-bun]
  --duration 5       Measured seconds per route, target, round
  --warmup 2         Warm-up seconds per route, target, round
  --rounds 3         Number of measured rounds
  --connections 100  Total concurrent HTTP connections
  --workers 4        Node autocannon worker count (must divide connections)
  --generator autocannon  Load generator: autocannon or oha
  --oha PATH         oha executable (default BENCH_OHA or oha on PATH)
  --node PATH        Node executable (default BENCH_NODE or node on PATH)
  --bun PATH         Bun executable (default BENCH_BUN or current Bun)
  --output PATH      Output directory (default timestamped benchmark/results)
Servers run sequentially. Do not run tests or builds during measurement.
`);
  process.exit(0);
}
const knownOptions = new Set([
  "targets",
  "duration",
  "warmup",
  "rounds",
  "connections",
  "workers",
  "generator",
  "oha",
  "node",
  "bun",
  "output",
]);
for (let index = 0; index < cli.length; index += 2) {
  const key = cli[index];
  if (!key.startsWith("--") || !knownOptions.has(key.slice(2)))
    throw new Error(`Unknown option: ${key}`);
  if (index + 1 >= cli.length || cli[index + 1].startsWith("--"))
    throw new Error(`Missing value for ${key}`);
}
function option(name: string, fallback: string) {
  const index = cli.indexOf(`--${name}`);
  return index === -1 ? fallback : cli[index + 1];
}
function positive(name: string, fallback: number, minimum = 1) {
  const value = Number(option(name, String(fallback)));
  if (!Number.isFinite(value) || value < minimum)
    throw new Error(`--${name} must be at least ${minimum}`);
  return value;
}
const settings = {
  duration: positive("duration", 5),
  warmup: positive("warmup", 2),
  rounds: positive("rounds", 3),
  connections: positive("connections", 100),
  workers: positive(
    "workers",
    cpus().length >= 4 ? 4 : cpus().length >= 2 ? 2 : 1,
  ),
  pipelining: 1,
  generator: option("generator", "autocannon"),
  oha: option("oha", process.env.BENCH_OHA ?? "oha"),
  node: option("node", process.env.BENCH_NODE ?? "node"),
  bun: option("bun", process.env.BENCH_BUN ?? process.execPath),
  targets: option(
    "targets",
    "bun,node-bun,node-node,express-bun,fastify-bun",
  ).split(","),
};
if (!["autocannon", "oha"].includes(settings.generator))
  throw new Error("--generator must be autocannon or oha");
for (const name of ["rounds", "connections", "workers"] as const) {
  if (!Number.isInteger(settings[name]))
    throw new Error(`--${name} must be an integer`);
}
if (settings.connections % settings.workers !== 0)
  throw new Error(
    "--connections must be divisible by --workers so the stated and actual concurrency match",
  );
const supported = new Set([
  "bun",
  "node-bun",
  "node-node",
  "express-bun",
  "fastify-bun",
  "raw-bun",
]);
for (const target of settings.targets)
  if (!supported.has(target)) throw new Error(`Unsupported target ${target}`);
if (new Set(settings.targets).size !== settings.targets.length)
  throw new Error("Targets must be unique");
if (settings.targets.includes("bun")) {
  const sourceFiles = (
    await readdir(join(project, "src"), { recursive: true })
  ).filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts"));
  for (const file of sourceFiles) {
    const outputFile = file.replace(/\.ts$/, ".js");
    try {
      const [sourceStat, outputStat] = await Promise.all([
        stat(join(project, "src", file)),
        stat(join(project, "dist", outputFile)),
      ]);
      if (sourceStat.mtimeMs > outputStat.mtimeMs) throw new Error("stale");
    } catch {
      throw new Error(
        `Missing/stale build for src/${file}; run bun run build before benchmarking`,
      );
    }
  }
}
const stamp = new Date()
  .toISOString()
  .replaceAll(":", "-")
  .replace(/\.\d+Z$/, "Z");
const output = resolve(option("output", join(directory, "results", stamp)));
await mkdir(output, { recursive: true });
const payload = {
  name: "John Doe",
  email: "john@example.com",
  tags: ["a", "b", "c"],
  nested: { x: 1, y: [1, 2, 3] },
};
const scenarios = [
  {
    name: "plaintext",
    method: "GET",
    path: "/",
    status: 200,
    body: undefined,
    expected: "Hello world!",
  },
  {
    name: "json-params",
    method: "GET",
    path: "/users/42",
    status: 200,
    body: undefined,
    expected: JSON.stringify({
      id: "42",
      name: "John Doe",
      email: "john@example.com",
      roles: ["admin", "user"],
    }),
  },
  {
    name: "json-post",
    method: "POST",
    path: "/echo",
    status: 201,
    body: JSON.stringify(payload),
    expected: JSON.stringify(payload),
  },
];
// The conditions every target shares: exact runtimes and packages, host, and
// the CPU sets the servers and the load generator are pinned to
const environment = describeEnvironment({
  project,
  node: settings.node,
  bun: settings.bun,
  generator: settings.generator,
  loadGenerator: settings.generator === "oha" ? settings.oha : settings.node,
});
const metadata: Record<string, any> = {
  generatedAt: new Date().toISOString(),
  completed: false,
  // The executables as the record names them, the same on any machine
  settings: {
    ...settings,
    node: portablePath(settings.node, { project }),
    bun: portablePath(settings.bun, { project }),
    oha: portablePath(settings.oha, { project }),
  },
  environment,
  runnerVersions: process.versions,
  upstream: {
    package: "@nestjs/platform-node",
    version: "12.3.3",
    commit: "59f33793c616eaf9669e8b81a35aa5f31accc5b4",
    pr: "https://github.com/nestjs/nest/pull/18063",
  },
  runtimes: {},
  backends: {},
  serverLogs: [],
  warnings: [],
};
if (settings.rounds < 3 || settings.duration < 5)
  metadata.warnings.push(
    "Short wiring/smoke run: fewer than three rounds or less than five seconds per measured route. Do not use as performance evidence.",
  );
try {
  const files = (await readdir(join(project, "src"), { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(await readFile(join(project, "src", file)));
  }
  metadata.sourceSha256 = hash.digest("hex");
  const buildFiles = (await readdir(join(project, "dist"), { recursive: true }))
    .filter((path) => path.endsWith(".js"))
    .sort();
  const buildHash = createHash("sha256");
  for (const file of buildFiles) {
    buildHash.update(file);
    buildHash.update(await readFile(join(project, "dist", file)));
  }
  metadata.buildSha256 = buildHash.digest("hex");
  metadata.lockSha256 = createHash("sha256")
    .update(await readFile(join(project, "bun.lock")))
    .digest("hex");
} catch {}
try {
  metadata.package = JSON.parse(
    await readFile(join(project, "package.json"), "utf8"),
  );
} catch {}
try {
  metadata.clockTicksPerSecond = Number(
    execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim(),
  );
} catch {}
const trials: any[] = [];
let active: ChildProcess | undefined;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    active?.kill("SIGTERM");
    process.exit(130);
  });

function launch(
  target: string,
): Promise<{ child: ChildProcess; info: any; stderr: () => string }> {
  const adapter = ["bun", "raw-bun"].includes(target)
    ? target
    : target.split("-")[0];
  const executable = target === "node-node" ? settings.node : settings.bun;
  const [command, args] = pinned(environment.pinning.server, executable, [
    join(directory, "server.mjs"),
    adapter,
  ]);
  return new Promise((resolveReady, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      env: { ...process.env, BENCH_PORT: "0", NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    active = child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill();
        reject(new Error(`Server ${target} did not become ready: ${stderr}`));
      }
    }, 15000);
    child.stderr!.on("data", (data) => {
      stderr += data.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (!settled)
        reject(
          new Error(`Server ${target} exited ${code}: ${stderr}\n${stdout}`),
        );
    });
    child.stdout!.on("data", (data) => {
      stdout += data.toString();
      for (const line of stdout.split("\n")) {
        try {
          const info = JSON.parse(line);
          if (info.ready && !settled) {
            settled = true;
            clearTimeout(timeout);
            resolveReady({ child, info, stderr: () => stderr });
          }
        } catch {}
      }
    });
  });
}
async function serverUsage(pid: number) {
  try {
    const data = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = data.slice(data.lastIndexOf(")") + 2).split(/\s+/);
    return {
      cpuTicks: Number(fields[11]) + Number(fields[12]),
      sampledAtMs: performance.now(),
    };
  } catch {
    return undefined;
  }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
  active = undefined;
}
// Runs a load generator on the load generator's CPUs, `input` on its stdin
function runGenerator(executable: string, args: string[], input = "") {
  const [command, commandArgs] = pinned(
    environment.pinning.generator,
    executable,
    args,
  );
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: project,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      child.once("error", reject);
      child.once("close", (code) => resolveRun({ code, stdout, stderr }));
      child.stdin.end(input);
    },
  );
}
// An oha run: requests still in flight at the deadline complete rather than
// count as errors
async function ohaLoad(options: Record<string, any>) {
  const args = [
    "-z",
    `${options.duration * 1000}ms`,
    "-c",
    String(options.connections),
    "--no-tui",
    "--output-format",
    "json",
    "-w",
    // A redirect is an answer to count, as autocannon does, not to follow
    "--redirect",
    "0",
    "-m",
    options.method,
  ];
  if (options.body !== undefined)
    args.push("-T", "application/json", "-d", options.body);
  const { code, stdout, stderr } = await runGenerator(settings.oha, [
    ...args,
    options.url,
  ]);
  return ohaResult(code, stdout, stderr);
}
// The figures of an oha run, in the shape of autocannon's
function ohaResult(code: number | null, stdout: string, stderr: string) {
  if (code !== 0) throw new Error(`oha exited ${code}: ${stderr}`);
  let figures;
  try {
    figures = JSON.parse(stdout);
  } catch {}
  // A figure oha measured: a number, never negative
  const measured = (value: unknown) =>
    Number.isFinite(value) && (value as number) >= 0;
  // The requests one of oha's distributions counts, NaN unless each of its
  // counts is a whole number, none negative
  const total = (counts?: Record<string, number>) =>
    typeof counts === "object" &&
    Object.values(counts).every(
      (count) => Number.isInteger(count) && count >= 0,
    )
      ? Object.values(counts).reduce((sum, count) => sum + count, 0)
      : NaN;
  const statuses = figures?.statusCodeDistribution;
  const answers = total(statuses);
  const errors = total(figures?.errorDistribution);
  const p99 = figures?.latencyPercentiles?.p99;
  if (
    ![figures?.summary?.requestsPerSec, answers, errors].every(measured) ||
    // oha has a latency unless no request got an answer, as when all failed
    !(measured(p99) || (answers === 0 && errors > 0))
  )
    throw new Error(`oha printed no figures: ${stdout}${stderr}`);
  return {
    requests: { average: figures.summary.requestsPerSec },
    // oha's latencies are in seconds; with no answer it has none (null), and
    // this counts 0, as autocannon reports it
    latency: { p99: p99 * 1000 },
    // Timeouts among them
    errors,
    timeouts: 0,
    // Not checked: oha does not compare bodies
    mismatches: null,
    non2xx: total(
      Object.fromEntries(
        Object.entries(statuses as Record<string, number>).filter(
          ([status]) => !status.startsWith("2"),
        ),
      ),
    ),
    oha: figures,
  };
}
async function load(options: Record<string, any>) {
  if (settings.generator === "oha") return ohaLoad(options);
  const { code, stdout, stderr } = await runGenerator(
    settings.node,
    [join(directory, "load.mjs")],
    JSON.stringify(options),
  );
  if (code !== 0) throw new Error(`Load generator exited ${code}: ${stderr}`);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid driver output: ${stdout}\n${stderr}`);
  }
}
async function validate(
  base: string,
  scenario: (typeof scenarios)[number],
  target: string,
) {
  const response = await fetch(base + scenario.path, {
    method: scenario.method,
    headers: scenario.body ? { "Content-Type": "application/json" } : {},
    body: scenario.body,
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.text();
  if (response.status !== scenario.status || body !== scenario.expected) {
    throw new Error(
      `${scenario.name} correctness failed: expected ${scenario.status} ${scenario.expected}, got ${response.status} ${body}`,
    );
  }
  const expectedType =
    scenario.name === "plaintext"
      ? target === "express-bun"
        ? "text/html"
        : "text/plain"
      : "application/json";
  if (!response.headers.get("content-type")?.startsWith(expectedType))
    throw new Error(`${scenario.name} incorrect Content-Type`);
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    bodyBytes: Buffer.byteLength(body),
  };
}
async function persist() {
  metadata.loadAtEnd = loadavg();
  await writeFile(
    join(output, "raw.json"),
    JSON.stringify({ metadata, scenarios, trials }, null, 2) + "\n",
  );
  await writeFile(
    join(output, "report.md"),
    renderControllersReport({ metadata, scenarios, trials }),
  );
}
function format(value: number, decimals = 0) {
  return value.toLocaleString("en-US", { maximumFractionDigits: decimals });
}
try {
  for (let round = 0; round < settings.rounds; round++) {
    const rotated = [
      ...settings.targets.slice(round % settings.targets.length),
      ...settings.targets.slice(0, round % settings.targets.length),
    ];
    const order = rotated;
    for (const target of order) {
      const { child, info, stderr } = await launch(target);
      metadata.runtimes[target] = info.runtime;
      metadata.backends[target] = info.backend;
      const base = `http://127.0.0.1:${info.port}`;
      try {
        for (const scenario of scenarios) {
          const validation = await validate(base, scenario, target);
          const common = {
            url: base + scenario.path,
            method: scenario.method,
            body: scenario.body,
            headers: scenario.body
              ? { "Content-Type": "application/json" }
              : {},
            connections: settings.connections,
            workers: settings.workers,
            pipelining: settings.pipelining,
            expectBody: scenario.expected,
            timeout: 10,
          };
          process.stdout.write(
            `Round ${round + 1}/${settings.rounds}: ${target} ${scenario.method} ${scenario.path} warming up...\n`,
          );
          const warmup = await load({ ...common, duration: settings.warmup });
          if (
            warmup.errors ||
            warmup.timeouts ||
            warmup.non2xx ||
            warmup.mismatches
          )
            throw new Error(
              `Warm-up ${target}/${scenario.name} failed response checks`,
            );
          const started = new Date().toISOString();
          const hostLoadBefore = loadavg();
          const serverBefore = await serverUsage(info.pid);
          const result = await load({ ...common, duration: settings.duration });
          const serverAfter = await serverUsage(info.pid);
          const serverCPUSeconds =
            serverBefore && serverAfter && metadata.clockTicksPerSecond
              ? (serverAfter.cpuTicks - serverBefore.cpuTicks) /
                metadata.clockTicksPerSecond
              : undefined;
          const valid = !(
            result.errors ||
            result.timeouts ||
            result.non2xx ||
            result.mismatches
          );
          trials.push({
            round: round + 1,
            target,
            scenario: scenario.name,
            started,
            hostLoadBefore,
            hostLoadAfter: loadavg(),
            server: info,
            validation,
            serverCPU: {
              before: serverBefore,
              after: serverAfter,
              seconds: serverCPUSeconds,
              averageCores:
                serverCPUSeconds !== undefined && serverBefore && serverAfter
                  ? serverCPUSeconds /
                    ((serverAfter.sampledAtMs - serverBefore.sampledAtMs) /
                      1000)
                  : undefined,
            },
            valid,
            result,
          });
          await persist();
          process.stdout.write(
            `  ${format(result.requests.average)} req/s; p99 ${result.latency.p99}ms; ${result.errors} errors; ${result.non2xx} non-2xx; ${result.mismatches === null ? "bodies not checked" : `${result.mismatches} mismatches`}\n`,
          );
          if (
            result.errors ||
            result.timeouts ||
            result.non2xx ||
            result.mismatches
          )
            throw new Error(
              `Measured ${target}/${scenario.name} failed response checks`,
            );
        }
      } finally {
        await stop(child);
        metadata.serverLogs.push({
          target,
          round: round + 1,
          stderr: stderr(),
        });
      }
    }
  }
  metadata.completed = true;
  await persist();
  process.stdout.write(`Results: ${output}/report.md\n`);
} catch (error) {
  metadata.warnings.push(String(error));
  await persist();
  process.stderr.write(String(error) + "\n");
  process.exitCode = 1;
} finally {
  if (active) await stop(active);
}
