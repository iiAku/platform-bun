// The conditions of a benchmark run, shared by both harnesses: the exact
// runtimes and packages measured, the host, and the CPU sets the servers and
// the load generator are pinned to, so that every target of a run is measured
// under the same conditions and the report says which.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import {
  arch,
  cpus,
  freemem,
  homedir,
  loadavg,
  platform,
  release,
  totalmem,
} from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const PACKAGES = [
  "@nestjs/core",
  "@nestjs/common",
  "@nestjs/platform-node",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "express",
  "fastify",
  "autocannon",
];

/** `node --version` or `bun --version` of the executable that is measured. */
/**
 * A path as a run's record names it, so that the record reads the same on any
 * machine: relative to the project inside it, from `~` inside the home
 * directory, and as given elsewhere.
 */
export function portablePath(path, { project, home = homedir() }) {
  if (!isAbsolute(path)) return path;
  const inside = (root) => {
    const rest = relative(root, path);
    return rest === ".." || rest.startsWith(`..${sep}`) ? undefined : rest;
  };
  const inProject = inside(project);
  if (inProject !== undefined) return inProject;
  const inHome = inside(home);
  return inHome === undefined ? path : `~/${inHome}`;
}

/**
 * A recorded path as one shell word in a reproduce command: as it is when the
 * shell leaves it alone, quoted otherwise, a leading `~/` outside the quotes
 * so that the shell expands it.
 */
export function shellPath(path) {
  const home = path.startsWith("~/") ? "~/" : "";
  const rest = path.slice(home.length);
  return /^[\w./+-]+$/.test(rest)
    ? home + rest
    : `${home}'${rest.replaceAll("'", "'\\''")}'`;
}

export function runtimeVersion(executable) {
  return execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
}

/**
 * The first line of `executable --version`, whatever its exit code: wrk exits
 * 1 after printing its version and its usage.
 */
export function toolVersion(executable) {
  const { stdout, error } = spawnSync(executable, ["--version"], {
    encoding: "utf8",
  });
  if (error) throw new Error(`cannot run ${executable}: ${error.message}`);
  return stdout.split("\n")[0].replace(/ Copyright .*$/, "");
}

/** Versions of the packages under test, as installed in the project. */
export function packageVersions(project) {
  const require = createRequire(join(project, "package.json"));
  const versions = {};
  for (const name of PACKAGES) {
    try {
      versions[name] = require(`${name}/package.json`).version;
    } catch {
      versions[name] = "not installed";
    }
  }
  try {
    const own = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    versions[own.name] = `${own.version} (this tree, built)`;
  } catch {}
  return versions;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** The online physical cores, each as its sorted logical CPUs (Linux sysfs). */
export function cpuCores() {
  let entries;
  try {
    entries = readdirSync("/sys/devices/system/cpu");
  } catch {
    return [];
  }
  const cores = new Map();
  for (const entry of entries) {
    const match = /^cpu(\d+)$/.exec(entry);
    if (!match) continue;
    const base = `/sys/devices/system/cpu/${entry}`;
    // cpu0 has no "online" file: it is always online
    if (readText(`${base}/online`) === "0") continue;
    const core = readText(`${base}/topology/core_id`);
    if (core === undefined) continue;
    const key = `${readText(`${base}/topology/physical_package_id`) ?? 0}:${core}`;
    if (!cores.has(key)) cores.set(key, []);
    cores.get(key).push(Number(match[1]));
  }
  return [...cores.values()]
    .map((list) => list.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

function hasTaskset() {
  try {
    execFileSync("taskset", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The CPU sets of a run: the servers get physical cores of their own (up to
 * four), the load generator the rest, and more of them, so that it never
 * limits the server it measures. Below six cores, or without `taskset`,
 * nothing is pinned, and the report says so.
 */
export function cpuSets() {
  const cores = cpuCores();
  if (cores.length < 6 || !hasTaskset()) {
    return { server: undefined, generator: undefined, cores: cores.length };
  }
  const serverCores = Math.min(4, Math.floor(cores.length / 3));
  const list = (group) =>
    group
      .flat()
      .sort((a, b) => a - b)
      .join(",");
  return {
    server: list(cores.slice(0, serverCores)),
    generator: list(cores.slice(serverCores)),
    cores: cores.length,
  };
}

/** `[command, args]` to run `command` pinned to `set`, when one is given. */
export function pinned(set, command, args) {
  return set === undefined
    ? [command, args]
    : ["taskset", ["-c", set, command, ...args]];
}

/** Expands a CPU list such as "0-3,12-15" into its CPUs. */
export function expandCpuList(list) {
  const result = [];
  for (const part of list.split(",")) {
    const [from, to = from] = part.split("-").map(Number);
    for (let cpu = from; cpu <= to; cpu++) result.push(cpu);
  }
  return result.sort((a, b) => a - b);
}

/** A /proc/stat reading (Linux), or undefined where there is none. */
export function procStat() {
  return readText("/proc/stat");
}

/**
 * The softirq time, in cores, that the CPUs in `list` spent between two
 * /proc/stat readings `seconds` apart. On loopback the kernel delivers each
 * segment to its reader, and wakes it, in softirq on the sender's CPU: time
 * that a kernel accounting IRQ time on its own books to no process.
 */
export function softirqCores(before, after, list, seconds, ticksPerSecond) {
  // Unpinned, the server shares its CPUs with the load generator; without
  // /proc/stat there is nothing to count
  if (list === undefined || before === undefined || after === undefined)
    return undefined;
  const start = softirqTicks(before);
  const end = softirqTicks(after);
  let ticks = 0;
  for (const cpu of expandCpuList(list)) ticks += end.get(cpu) - start.get(cpu);
  return ticks / ticksPerSecond / seconds;
}

// Softirq ticks by CPU, from the per-CPU lines of a /proc/stat reading
function softirqTicks(reading) {
  const ticks = new Map();
  for (const line of reading.split("\n")) {
    const match = /^cpu(\d+) (.+)$/.exec(line);
    if (match) ticks.set(Number(match[1]), Number(match[2].split(" ")[6]));
  }
  return ticks;
}

/** The CPUs this process may run on, as a list, or undefined off Linux. */
export function allowedCpus() {
  const list = readText("/proc/self/status")?.match(
    /^Cpus_allowed_list:\s*(.+)$/m,
  )?.[1];
  return list === undefined ? undefined : expandCpuList(list);
}

export function describeHost() {
  const cores = cpuCores();
  const smt = readText("/sys/devices/system/cpu/smt/active");
  return {
    platform: platform(),
    arch: arch(),
    kernel: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    physicalCores: cores.length || undefined,
    logicalCPUs: cpus().length,
    smt: smt === undefined ? undefined : smt === "1",
    cpuGovernor: readText(
      "/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
    ),
    energyPerformancePreference: readText(
      "/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference",
    ),
    memoryGiB: Math.round(totalmem() / 2 ** 30),
    freeMemoryGiB: Math.round((freemem() / 2 ** 30) * 10) / 10,
    loadAverage: loadavg().map((value) => Math.round(value * 100) / 100),
    cpusAllowed: allowedCpus()?.join(","),
  };
}

/**
 * Everything a reader needs to judge the conditions of a run: `node` and
 * `bun` are the executables the targets run on, `loadGenerator` the Node
 * running autocannon, or the load generator itself.
 */
export function describeEnvironment({
  project,
  node,
  bun,
  generator = "autocannon",
  loadGenerator,
}) {
  return {
    host: describeHost(),
    runtimes: {
      node: {
        path: portablePath(node, { project }),
        version: runtimeVersion(node),
      },
      bun: {
        path: portablePath(bun, { project }),
        version: runtimeVersion(bun),
      },
      loadGenerator: {
        name: generator,
        path: portablePath(loadGenerator, { project }),
        version:
          generator === "autocannon"
            ? runtimeVersion(loadGenerator)
            : toolVersion(loadGenerator),
      },
    },
    packages: packageVersions(project),
    pinning: cpuSets(),
  };
}

/** The load generator of a run; those recorded before oha and wrk were added name none: autocannon */
export function generatorName(environment) {
  return environment.runtimes.loadGenerator.name ?? "autocannon";
}

/** The conditions as report lines. */
export function environmentMarkdown(environment) {
  const { host, runtimes, packages, pinning } = environment;
  const generator =
    generatorName(environment) === "autocannon"
      ? `autocannon ${packages.autocannon} on Node ${runtimes.loadGenerator.version}`
      : runtimes.loadGenerator.version;
  const smt =
    host.smt === undefined ? "SMT unknown" : host.smt ? "SMT on" : "SMT off";
  const governor =
    (host.cpuGovernor ?? "unknown") +
    (host.energyPerformancePreference
      ? ` (${host.energyPerformancePreference})`
      : "");
  return [
    "## Conditions",
    "",
    `- Host: ${host.cpu}; ${host.physicalCores ?? "?"} cores, ${host.logicalCPUs} logical CPUs (${smt}); ${host.memoryGiB} GiB; ${host.platform} ${host.kernel} ${host.arch}; CPU governor ${governor}; load average at start ${host.loadAverage.join(", ")}.`,
    `- Runtimes: Node ${runtimes.node.version} (\`${runtimes.node.path}\`), Bun ${runtimes.bun.version} (\`${runtimes.bun.path}\`). Load generator: ${generator} (\`${runtimes.loadGenerator.path}\`).`,
    `- Packages: ${Object.entries(packages)
      .filter(([name]) => name !== "autocannon")
      .map(([name, version]) => `${name} ${version}`)
      .join(", ")}.`,
    `- CPU pinning (taskset, the same for every target): ${
      pinning.server
        ? `servers on CPUs ${pinning.server}; load generator on CPUs ${pinning.generator}`
        : `none (${pinning.cores} cores)`
    }.`,
  ];
}
