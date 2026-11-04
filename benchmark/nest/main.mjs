#!/usr/bin/env node
// Nest's own benchmark (tools/benchmarks at the pinned commit) as a runtime
// matrix: the same "Hello world!" GET / workload, 100 connections, pipelining
// 10, a full-length warm-up then a measured run with autocannon in this
// process, each server in its own process. Every target names the runtime that
// runs it, so platform-node and platform-bun are measured on Node and on Bun.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedCpus,
  describeEnvironment,
  expandCpuList,
  pinned,
  portablePath,
  procStat,
  runtimeVersion,
  softirqCores,
} from "../environment.mjs";
import { BODY, fmt, renderNestReport } from "./report.mjs";

const require = createRequire(import.meta.url);
const autocannon = require("autocannon");
const directory = dirname(fileURLToPath(import.meta.url));
const project = resolve(directory, "..", "..");

const WRK_SCRIPT = join(directory, "wrk-pipeline.lua");
const FRAMEWORKS = [
  "node",
  "bun",
  "nest-node",
  "nest-bun",
  "express",
  "nest-express",
  "fastify",
  "nest-fastify",
];
const RUNTIMES = ["node", "bun"];
const DEFAULT_TARGETS =
  "node@node,nest-node@node,node@bun,bun@bun,nest-node@bun,nest-bun@bun";
const ALL_TARGETS =
  "node@node,nest-node@node,express@node,nest-express@node,fastify@node,nest-fastify@node," +
  "node@bun,bun@bun,nest-node@bun,nest-bun@bun,express@bun,nest-express@bun,fastify@bun,nest-fastify@bun";

const usage = `Usage: node benchmark/nest/main.mjs [options]

  --targets a@node,b@bun  Targets as <framework>@<runtime>; frameworks: ${FRAMEWORKS.join(", ")}
                          ("bun" is a bare Bun.serve() handler, the ceiling; default: ${DEFAULT_TARGETS})
  --all                   All frameworks on both runtimes
  --node PATH             Node executable for the @node targets (default: $BENCH_NODE, else the Node running this runner)
  --bun PATH              Bun executable for the @bun targets (default: $BENCH_BUN or "bun")
  --rounds 3              Measured rounds; the target order rotates between rounds and medians are reported
  --connections 100       Concurrent connections
  --duration 10           Seconds per run; the warm-up run takes as long
  --pipelining 10         Requests pipelined per connection
  --generator autocannon  Load generator: autocannon (in this process) or wrk
  --wrk PATH              wrk executable (default: $BENCH_WRK or "wrk")
  --threads 4             wrk threads
  --port 3000             Port the servers listen on
  --output PATH           Output directory (default: benchmark/results/nest-<timestamp>)
  --verbose               Live autocannon progress
`;

function parseArgs(argv) {
  const args = {
    targets: DEFAULT_TARGETS,
    node: process.env.BENCH_NODE ?? process.execPath,
    bun: process.env.BENCH_BUN ?? "bun",
    rounds: 3,
    connections: 100,
    duration: 10,
    pipelining: 10,
    generator: "autocannon",
    wrk: process.env.BENCH_WRK ?? "wrk",
    threads: 4,
    port: 3000,
    output: undefined,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${token} needs a value`);
      return next;
    };
    const number = () => {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0)
        throw new Error(`${token} needs a positive number`);
      return n;
    };
    switch (token) {
      case "--targets":
        args.targets = value();
        break;
      case "--all":
        args.targets = ALL_TARGETS;
        break;
      case "--node":
        args.node = value();
        break;
      case "--bun":
        args.bun = value();
        break;

      case "--rounds":
        args.rounds = number();

        break;
      case "--connections":
        args.connections = number();
        break;
      case "--duration":
        args.duration = number();
        break;
      case "--pipelining":
        args.pipelining = number();
        break;
      case "--generator":
        args.generator = value();
        break;
      case "--wrk":
        args.wrk = value();
        break;
      case "--threads":
        args.threads = number();
        break;
      case "--port":
        args.port = number();
        break;
      case "--output":
        args.output = value();
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(usage);
        process.exit(0);
      default:
        throw new Error(`Unknown option ${token}\n${usage}`);
    }
  }
  if (!["autocannon", "wrk"].includes(args.generator))
    throw new Error(`--generator must be autocannon or wrk\n${usage}`);
  if (args.generator === "wrk") {
    if (
      !Number.isInteger(args.threads) ||
      args.connections % args.threads !== 0
    )
      throw new Error(
        "--threads must divide --connections: each wrk thread opens connections / threads of them",
      );
    if (!Number.isInteger(args.duration))
      throw new Error("--duration must be whole seconds with wrk");
  }
  args.targets = args.targets.split(",").map((entry) => {
    const [framework, runtime] = entry.trim().split("@");
    if (!FRAMEWORKS.includes(framework) || !RUNTIMES.includes(runtime)) {
      throw new Error(
        `Invalid target "${entry}": expected <framework>@<runtime>\n${usage}`,
      );
    }
    return { framework, runtime, name: `${framework}@${runtime}` };
  });
  return args;
}

async function newest(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;
  let latest = 0;
  for (const entry of await readdir(path)) {
    latest = Math.max(latest, await newest(join(path, entry)));
  }
  return latest;
}

// The Bun adapter target runs the compiled package, as a consumer would
async function assertFreshBuild() {
  let built;
  try {
    built = (await stat(join(project, "dist", "index.js"))).mtimeMs;
  } catch {
    throw new Error(
      "Missing build: run `bun run build` before benchmarking nest-bun",
    );
  }
  if ((await newest(join(project, "src"))) > built) {
    throw new Error(
      "Stale build: run `bun run build` before benchmarking nest-bun",
    );
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let clockTicks = 100;
try {
  clockTicks = Number(
    execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }),
  );
} catch {}

// The fields of /proc/<pid>/stat (Linux) from the process state on
async function statFields(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  } catch {
    return undefined;
  }
}

// CPU ticks a process has used, to tell a saturated server from one waiting
// on the load generator
async function cpuTicks(pid) {
  const fields = await statFields(pid);
  return fields && Number(fields[11]) + Number(fields[12]);
}

// CPU ticks of the runner's children that have exited, wrk among them
async function childTicks() {
  const fields = await statFields("self");
  return fields && Number(fields[13]) + Number(fields[14]);
}

// Whatever answers on the port is measured: a server left there, by an
// interrupted run say, would be measured in place of the one started
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      reject(
        new Error(
          `port ${port} is in use: another server answers on it; stop it or pass --port`,
        ),
      );
    });
    socket.once("error", (error) =>
      error.code === "ECONNREFUSED" ? resolve() : reject(error),
    );
  });
}

// A server killed by a signal has no exit code
const hasExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;

// The server started must be the one measured: once it is gone (it lost the
// port to another process, or crashed), whatever answers there would be
function assertServing(child, port) {
  if (hasExited(child)) {
    throw new Error(
      `port ${port}: the server started there exited during the run, so what answered was not it`,
    );
  }
}

async function waitForServer(url, child, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null)
      throw new Error(`server exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      const text = await response.text();
      if (response.status !== 200 || text !== BODY) {
        throw new Error(
          `unexpected reply: ${response.status} ${JSON.stringify(text)}`,
        );
      }
      return;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
    await sleep(100);
  }
  throw new Error(`server not ready after ${timeoutMs} ms`);
}

function load(args, options) {
  return args.generator === "wrk"
    ? wrkLoad(args, options)
    : autocannonLoad(options);
}

function autocannonLoad(options) {
  return new Promise((resolve, reject) => {
    const instance = autocannon(options, (error, result) =>
      error ? reject(error) : resolve(result),
    );
    if (options.verbose) autocannon.track(instance);
  });
}

// A wrk run: each connection sends `pipelining` requests at once, and its
// next batch once every response to them has arrived
function wrkLoad(args, { url, connections, duration, pipelining }) {
  const batch = `GET / HTTP/1.1\r\nHost: ${new URL(url).host}\r\n\r\n`.repeat(
    pipelining,
  );
  const child = spawn(
    args.wrk,
    [
      "-t",
      String(args.threads),
      "-c",
      String(connections),
      "-d",
      `${duration}s`,
      "-s",
      WRK_SCRIPT,
      url,
      "--",
      batch,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  generator = child;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return once(child, "close").then(([code]) => {
    const figures = code === 0 ? wrkFigures(stdout) : undefined;
    if (figures === undefined)
      throw new Error(
        `wrk ${code === 0 ? "printed no figures" : `exited with ${code}`}: ${stderr || stdout}`,
      );
    const seconds = figures.durationUs / 1e6;
    return {
      requests: {
        average: figures.requests / seconds,
        total: figures.requests,
      },
      latency: {},
      throughput: { average: figures.bytes / seconds },
      errors:
        figures.errors.connect + figures.errors.read + figures.errors.write,
      timeouts: figures.errors.timeout,
      // wrk counts the 4xx and 5xx answers, not every one but 2xx
      httpErrors: figures.errors.status,
      wrk: figures,
    };
  });
}

// The figures the wrk script prints after wrk's own report, provided they are
// those of a measured run: whole numbers, none negative, over some time
function wrkFigures(stdout) {
  const line = stdout.split("\n").findLast((text) => text.startsWith("{"));
  if (line === undefined) return undefined;
  const figures = JSON.parse(line);
  const counts = [
    figures.durationUs,
    figures.requests,
    figures.bytes,
    ...["connect", "read", "write", "status", "timeout"].map(
      (kind) => figures.errors?.[kind],
    ),
  ];
  return counts.every((count) => Number.isInteger(count) && count >= 0) &&
    figures.durationUs > 0
    ? figures
    : undefined;
}

async function stop(child) {
  if (hasExited(child)) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  await exited;
  clearTimeout(timer);
}

async function runOne(target, args, round) {
  const executable = target.runtime === "bun" ? args.bun : args.node;
  const entry = join(directory, "frameworks", `${target.framework}.mjs`);
  const url = `http://127.0.0.1:${args.port}/`;
  const [command, commandArgs] = pinned(args.pinning.server, executable, [
    entry,
  ]);
  await assertPortFree(args.port);
  const child = spawn(command, commandArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, PORT: String(args.port), NODE_ENV: "production" },
  });
  server = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const options = {
    url,
    connections: args.connections,
    duration: args.duration,
    pipelining: args.pipelining,
    verbose: args.verbose,
  };
  try {
    await waitForServer(url, child);
    process.stdout.write(
      `\n=== round ${round} ${target.name} (${runtimeVersion(executable)}) ===\n`,
    );
    process.stdout.write(`warm-up ${args.duration}s...\n`);
    await load(args, options);
    assertServing(child, args.port);
    process.stdout.write(`measuring ${args.duration}s...\n`);
    const measureStart = performance.now();
    const cpuBefore = process.cpuUsage();
    const childTicksBefore = await childTicks();
    const serverTicksBefore = await cpuTicks(child.pid);
    const statBefore = procStat();
    const result = await load(args, options);
    const cpu = process.cpuUsage(cpuBefore);
    const childTicksAfter = await childTicks();
    const serverTicksAfter = await cpuTicks(child.pid);
    const statAfter = procStat();
    // autocannon stops on its one-second sampler, so its run can outlast the
    // duration it was given: the CPU figures are per second of this window
    const seconds = (performance.now() - measureStart) / 1000;
    assertServing(child, args.port);
    const summary = {
      target: target.name,
      framework: target.framework,
      runtime: target.runtime,
      runtimeVersion: runtimeVersion(executable),
      round,
      // CPU cores the server and the load generator used during the measured
      // run (a single-threaded server saturates at one)
      serverCpu:
        serverTicksBefore === undefined || serverTicksAfter === undefined
          ? undefined
          : (serverTicksAfter - serverTicksBefore) / clockTicks / seconds,
      serverSoftirqCpu: softirqCores(
        statBefore,
        statAfter,
        args.pinning.server,
        seconds,
        clockTicks,
      ),
      // autocannon runs in this process, wrk in a child of it
      generatorCpu:
        args.generator === "wrk"
          ? (childTicksAfter - childTicksBefore) / clockTicks / seconds
          : (cpu.user + cpu.system) / 1e6 / seconds,
      requestsPerSecAvg: result.requests.average,
      latencyAvgMs: result.latency.average,
      latencyP99Ms: result.latency.p99,
      throughputBytesPerSecAvg: result.throughput.average,
      totalRequests: result.requests.total,
      errors: result.errors,
      timeouts: result.timeouts,
      non2xx: result.non2xx,
      httpErrors: result.httpErrors,
      stderr,
    };
    // wrk reports no latency, and counts 4xx and 5xx answers alone
    const latency =
      summary.latencyAvgMs === undefined
        ? ""
        : `  latency avg=${summary.latencyAvgMs}ms p99=${summary.latencyP99Ms}ms`;
    const statuses =
      args.generator === "wrk"
        ? `4xx–5xx=${summary.httpErrors}`
        : `non2xx=${summary.non2xx}`;
    process.stdout.write(
      `Requests/sec: ${summary.requestsPerSecAvg}${latency}  errors=${summary.errors} timeouts=${summary.timeouts} ${statuses}  server CPU=${fmt(summary.serverCpu, 2)} cores  generator CPU=${fmt(summary.generatorCpu, 2)} cores\n`,
    );
    return { summary, result };
  } catch (error) {
    throw new Error(
      `${target.name}: ${error.message}${stderr ? `\n${stderr}` : ""}`,
      { cause: error },
    );
  } finally {
    await stop(child);
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// One row per target: medians over the rounds, with the range of req/s
function aggregate(samples) {
  const byTarget = new Map();
  for (const sample of samples) {
    if (!byTarget.has(sample.target)) byTarget.set(sample.target, []);
    byTarget.get(sample.target).push(sample);
  }
  return [...byTarget.values()].map((rounds) => {
    const first = rounds[0];
    // A count the load generator does not make stays undefined
    const total = (key) =>
      rounds.every((r) => r[key] !== undefined)
        ? rounds.reduce((n, r) => n + r[key], 0)
        : undefined;
    const rps = rounds.map((r) => r.requestsPerSecAvg);
    return {
      target: first.target,
      framework: first.framework,
      runtime: first.runtime,
      runtimeVersion: first.runtimeVersion,
      rounds: rounds.length,
      requestsPerSecAvg: median(rps),
      requestsPerSecMin: Math.min(...rps),
      requestsPerSecMax: Math.max(...rps),
      latencyAvgMs: rounds.every((r) => r.latencyAvgMs !== undefined)
        ? median(rounds.map((r) => r.latencyAvgMs))
        : undefined,
      latencyP99Ms: rounds.every((r) => r.latencyP99Ms !== undefined)
        ? median(rounds.map((r) => r.latencyP99Ms))
        : undefined,
      throughputBytesPerSecAvg: median(
        rounds.map((r) => r.throughputBytesPerSecAvg),
      ),
      serverCpu: rounds.every((r) => r.serverCpu !== undefined)
        ? median(rounds.map((r) => r.serverCpu))
        : undefined,
      serverSoftirqCpu: rounds.every((r) => r.serverSoftirqCpu !== undefined)
        ? median(rounds.map((r) => r.serverSoftirqCpu))
        : undefined,
      generatorCpu: median(rounds.map((r) => r.generatorCpu)),
      errors: total("errors"),
      timeouts: total("timeouts"),
      non2xx: total("non2xx"),
      httpErrors: total("httpErrors"),
    };
  });
}

// The signals that stop a run, sent to the runner alone or to its group
const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

// The server being measured, and the wrk measuring it, which a run stopped by
// a signal takes down with it: left running, the server would answer the next
// run on its port, and wrk would load the next run's server
let server;
let generator;

// autocannon runs in this process: the runner itself is pinned to the load
// generator's CPUs, by running itself again under taskset when it is not,
// and passing on the signals that stop it
async function pinSelf(generator) {
  if (generator === undefined) return;
  const wanted = expandCpuList(generator).join(",");
  if (allowedCpus()?.join(",") === wanted) return;
  const runner = spawn(
    "taskset",
    [
      "-c",
      generator,
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit" },
  );
  for (const signal of STOP_SIGNALS) {
    process.on(signal, () => runner.kill(signal));
  }
  const [code] = await once(runner, "exit");
  process.exit(code ?? 1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const environment = describeEnvironment({
    project,
    node: args.node,
    bun: args.bun,
    generator: args.generator,
    loadGenerator: args.generator === "wrk" ? args.wrk : process.execPath,
  });
  await pinSelf(environment.pinning.generator);
  for (const signal of STOP_SIGNALS) {
    process.once(signal, () => {
      server?.kill("SIGKILL");
      generator?.kill("SIGKILL");
      process.exit(128 + constants.signals[signal]);
    });
  }
  args.pinning = environment.pinning;
  if (args.targets.some((t) => t.framework === "nest-bun"))
    await assertFreshBuild();
  const startedAt = new Date().toISOString();
  const output = resolve(
    args.output ??
      join(
        project,
        "benchmark",
        "results",
        `nest-${startedAt.replace(/[:.]/g, "-")}`,
      ),
  );
  const samples = [];
  const raw = [];
  for (let round = 1; round <= args.rounds; round++) {
    // The order rotates so that no target always runs last
    const shift = (round - 1) % args.targets.length;
    const order = [
      ...args.targets.slice(shift),
      ...args.targets.slice(0, shift),
    ];
    for (const target of order) {
      const { summary, result } = await runOne(target, args, round);
      samples.push(summary);
      raw.push({ target: target.name, round, result });
      await sleep(250);
    }
  }
  await mkdir(output, { recursive: true });
  const summaries = aggregate(samples);
  // The record names the executables the same on any machine, and not where
  // the run was written
  const { output: _output, ...settings } = args;
  const recorded = {
    ...settings,
    node: portablePath(args.node, { project }),
    bun: portablePath(args.bun, { project }),
    wrk: portablePath(args.wrk, { project }),
  };
  const text = renderNestReport({
    startedAt,
    args: recorded,
    environment,
    summaries,
  });
  await writeFile(join(output, "report.md"), text);
  await writeFile(
    join(output, "raw.json"),
    JSON.stringify(
      { startedAt, args: recorded, environment, samples, summaries, raw },
      null,
      2,
    ),
  );
  process.stdout.write(`\n${text}\nResults: ${output}/report.md\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
