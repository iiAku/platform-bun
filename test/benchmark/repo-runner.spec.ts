// The controllers benchmark's runner (benchmark/run.ts) with oha as its load
// generator, the cross-check of its autocannon figures: every route is
// measured by oha under the conditions the report states.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandCpuList } from "../../benchmark/environment.mjs";
import { fakeExecutable, type FakeOutput } from "../support/fake-generator";

const RUNNER = join(import.meta.dir, "../../benchmark/run.ts");
const RENDER = join(import.meta.dir, "../../benchmark/render.mjs");

// The runner on Bun, as `bun benchmark/run.ts` runs it, measuring the bare
// Bun.serve() server, which needs no build, one second per route; in a process
// group of its own so that a test can take down everything it started
function run(args: string[], env?: Record<string, string>) {
  const child = spawn(
    process.execPath,
    [
      RUNNER,
      "--targets",
      "raw-bun",
      "--rounds",
      "1",
      "--duration",
      "1",
      "--warmup",
      "1",
      ...args,
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, env },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  return {
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
    killAll: () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    },
  };
}

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "repo-runner-"));
  return { directory, output: join(directory, "run") };
}

// oha's JSON report, with the figures the runner reads
function ohaOutput({
  requestsPerSec = 100_000,
  p99 = 0.002,
  status = { "200": 100_000 },
  errors = {},
}: {
  requestsPerSec?: number;
  p99?: number;
  status?: Record<string, number>;
  // null: as no oha prints it
  errors?: Record<string, number | null>;
} = {}) {
  return JSON.stringify({
    summary: { successRate: 1, total: 1, requestsPerSec },
    latencyPercentiles: { p50: p99 / 2, p99 },
    statusCodeDistribution: status,
    errorDistribution: errors,
  });
}

const fakeOha = (outputs: FakeOutput[]) =>
  fakeExecutable("oha", { version: "oha 1.16.0 [fake]\n", outputs });

// The value after `flag` in a recorded command line
const valueOf = (args: string[], flag: string) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

const PAYLOAD = JSON.stringify({
  name: "John Doe",
  email: "john@example.com",
  tags: ["a", "b", "c"],
  nested: { x: 1, y: [1, 2, 3] },
});

test("a run with oha measures each route with its method and body, and reports oha's rate and p99", async () => {
  const { directory, output } = await scratch();
  const oha = await fakeOha([
    { stdout: ohaOutput({ requestsPerSec: 123_456.7, p99: 0.00234 }) },
  ]);
  const runner = run([
    "--generator",
    "oha",
    "--oha",
    oha.path,
    "--connections",
    "100",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { metadata, trials } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    const base = `http://127.0.0.1:${trials[0].server.port}`;
    // A warm-up, then the measured run, for each route
    const runs = await oha.runs();
    expect(runs.map(({ args }) => [valueOf(args, "-m"), args.at(-1)])).toEqual([
      ["GET", `${base}/`],
      ["GET", `${base}/`],
      ["GET", `${base}/users/42`],
      ["GET", `${base}/users/42`],
      ["POST", `${base}/echo`],
      ["POST", `${base}/echo`],
    ]);
    for (const { args, cpus } of runs) {
      expect(valueOf(args, "-c")).toBe("100");
      expect(valueOf(args, "-z")).toBe("1000ms");
      // Requests in flight at the deadline complete rather than count as
      // errors, and the figures come as JSON rather than a live display
      expect(args).toContain("-w");
      expect(args).toContain("--no-tui");
      expect(valueOf(args, "--output-format")).toBe("json");
      // A redirect is an answer to count, as autocannon does, not to follow
      expect(valueOf(args, "--redirect")).toBe("0");
      const post = valueOf(args, "-m") === "POST";
      expect(valueOf(args, "-d")).toBe(post ? PAYLOAD : undefined);
      expect(valueOf(args, "-T")).toBe(post ? "application/json" : undefined);
      if (metadata.environment.pinning.generator !== undefined)
        expect(expandCpuList(cpus!)).toEqual(
          expandCpuList(metadata.environment.pinning.generator),
        );
    }
    expect(trials).toHaveLength(3);
    for (const trial of trials) {
      expect(trial.valid).toBe(true);
      expect(trial.result.requests.average).toBe(123_456.7);
      expect(trial.result.latency.p99).toBeCloseTo(2.34, 10);
    }
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).toContain(" | 123,457 | 123,457–123,457 | 2.34 | ");
  } finally {
    runner.killAll();
    await oha.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test.each([
  ["a redirect", ohaOutput({ status: { "200": 99_999, "302": 1 } })],
  ["a server error", ohaOutput({ status: { "200": 99_999, "500": 1 } })],
  [
    "a transport error",
    ohaOutput({ errors: { "connection closed before message completed": 1 } }),
  ],
  // As oha reports it: no latency without an answer
  [
    "no answer at all",
    JSON.stringify({
      summary: { requestsPerSec: 100_000 },
      latencyPercentiles: { p99: null },
      statusCodeDistribution: {},
      errorDistribution: { "connection refused": 100_000 },
    }),
  ],
])(
  "a run in which oha meets %s while measuring records the trial as invalid and stops",
  async (_, measured) => {
    const { directory, output } = await scratch();
    // A clean warm-up, then the measured run
    const oha = await fakeOha([{ stdout: ohaOutput() }, { stdout: measured }]);
    const runner = run([
      "--generator",
      "oha",
      "--oha",
      oha.path,
      "--output",
      output,
    ]);
    try {
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain("failed response checks");
      const { metadata, trials } = JSON.parse(
        await readFile(join(output, "raw.json"), "utf8"),
      );
      expect(metadata.completed).toBe(false);
      expect(trials.map((trial: { valid: boolean }) => trial.valid)).toEqual([
        false,
      ]);
    } finally {
      runner.killAll();
      await oha.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test.each([
  [
    "exits with an error",
    // Whatever it printed before
    { exit: 1, stdout: ohaOutput(), stderr: "error: Connection refused\n" },
    "Connection refused",
  ],
  [
    "prints something other than its figures",
    { stdout: "Summary:\n" },
    "oha printed no figures",
  ],
  [
    "prints figures without a rate",
    {
      stdout: JSON.stringify({
        summary: {},
        statusCodeDistribution: {},
        errorDistribution: {},
      }),
    },
    "oha printed no figures",
  ],
  [
    "prints no latency for the requests it got answers to",
    {
      stdout: JSON.stringify({
        summary: { requestsPerSec: 100_000 },
        latencyPercentiles: { p99: null },
        statusCodeDistribution: { "200": 99_999 },
        errorDistribution: { "connection closed before message completed": 1 },
      }),
    },
    "oha printed no figures",
  ],
  [
    "measures no request at all",
    {
      stdout: JSON.stringify({
        summary: { requestsPerSec: 0 },
        latencyPercentiles: { p99: null },
        statusCodeDistribution: {},
        errorDistribution: {},
      }),
    },
    "oha printed no figures",
  ],
  [
    "prints figures without its answers' statuses",
    {
      stdout: JSON.stringify({
        summary: { requestsPerSec: 100_000 },
        latencyPercentiles: { p99: 0.002 },
        errorDistribution: {},
      }),
    },
    "oha printed no figures",
  ],
  [
    "prints figures without its errors",
    {
      stdout: JSON.stringify({
        summary: { requestsPerSec: 100_000 },
        latencyPercentiles: { p99: 0.002 },
        statusCodeDistribution: { "200": 100_000 },
      }),
    },
    "oha printed no figures",
  ],
  [
    "prints a count that is not a number",
    { stdout: ohaOutput({ errors: { "connection refused": null } }) },
    "oha printed no figures",
  ],
  [
    "prints counts that cancel out",
    {
      stdout: ohaOutput({
        errors: { "connection refused": 1, "connection reset": -1 },
      }),
    },
    "oha printed no figures",
  ],
  [
    "prints a fractional count",
    { stdout: ohaOutput({ status: { "200": 99_999.5 } }) },
    "oha printed no figures",
  ],
  [
    "prints a negative latency",
    { stdout: ohaOutput({ p99: -0.001 }) },
    "oha printed no figures",
  ],
  [
    "prints a negative rate",
    { stdout: ohaOutput({ requestsPerSec: -100_000 }) },
    "oha printed no figures",
  ],
] as const)(
  "a run whose oha %s while measuring stops without a measured trial",
  async (_, failure, message) => {
    const { directory, output } = await scratch();
    // A clean warm-up, then the measured run
    const oha = await fakeOha([{ stdout: ohaOutput() }, failure]);
    const runner = run([
      "--generator",
      "oha",
      "--oha",
      oha.path,
      "--output",
      output,
    ]);
    try {
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain(message);
      expect(await oha.runs()).toHaveLength(2);
      const { trials } = JSON.parse(
        await readFile(join(output, "raw.json"), "utf8"),
      );
      expect(trials).toEqual([]);
    } finally {
      runner.killAll();
      await oha.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

test("a run with a load generator the runner does not know is refused before any server starts", async () => {
  const { directory, output } = await scratch();
  // The bare Bun.serve() server would run on this Bun, which records it
  const bun = await fakeExecutable("bun", {
    version: "1.4.4\n",
    outputs: [{ exit: 1 }],
  });
  const runner = run([
    "--generator",
    "wrk",
    "--bun",
    bun.path,
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(1);
    expect(runner.stderr()).toContain("--generator");
    expect(await bun.runs()).toEqual([]);
  } finally {
    runner.killAll();
    await bun.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a run with oha reports oha as its load generator, and response bodies as unchecked under load", async () => {
  const { directory, output } = await scratch();
  const oha = await fakeOha([{ stdout: ohaOutput() }]);
  const runner = run([
    "--generator",
    "oha",
    "--oha",
    oha.path,
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { metadata, trials } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    expect(metadata.environment.runtimes.loadGenerator).toEqual({
      name: "oha",
      path: oha.path,
      version: "oha 1.16.0 [fake]",
    });
    // Bodies are checked once before the warm-up, and not under load
    for (const trial of trials) expect(trial.result.mismatches).toBeNull();
    expect(runner.stdout()).toContain("bodies not checked");
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).toContain(
      `Load generator: oha 1.16.0 [fake] (\`${oha.path}\`)`,
    );
    expect(report).toContain(" | 0 / 0 / not checked |");
    expect(report).not.toContain("autocannon load workers");
    expect(report).not.toContain("Autocannon checks exact response bodies");
    expect(report).toContain(`--generator oha --oha ${oha.path}`);
  } finally {
    runner.killAll();
    await oha.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a run records its executables from ~ when they are in the home directory, and not the host's name", async () => {
  const { directory, output } = await scratch();
  const oha = await fakeOha([{ stdout: ohaOutput() }]);
  // The run's home directory holds its oha, its Node and its Bun
  const home = dirname(oha.path);
  await symlink(Bun.which("node")!, join(home, "node"));
  await symlink(process.execPath, join(home, "bun"));
  const runner = run(
    [
      "--generator",
      "oha",
      "--oha",
      oha.path,
      "--node",
      join(home, "node"),
      "--bun",
      join(home, "bun"),
      "--output",
      output,
    ],
    { ...(process.env as Record<string, string>), HOME: home },
  );
  try {
    expect(await runner.exited).toBe(0);
    const { metadata } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    const { settings, environment } = metadata;
    const { runtimes, host } = environment;
    expect([settings.node, settings.bun, settings.oha]).toEqual([
      "~/node",
      "~/bun",
      "~/oha",
    ]);
    expect([
      runtimes.node.path,
      runtimes.bun.path,
      runtimes.loadGenerator.path,
    ]).toEqual(["~/node", "~/bun", "~/oha"]);
    expect(host).not.toHaveProperty("hostname");
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).not.toContain(home);
    expect(report).toContain(
      "--node ~/node --bun ~/bun --generator oha --oha ~/oha",
    );
  } finally {
    runner.killAll();
    await oha.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a report rendered again on Bun from a run's raw.json is the report the run wrote", async () => {
  const { directory, output } = await scratch();
  const oha = await fakeOha([{ stdout: ohaOutput() }]);
  const runner = run([
    "--generator",
    "oha",
    "--oha",
    oha.path,
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const written = await readFile(join(output, "report.md"), "utf8");
    expect(written).toContain("| Bun.serve() on Bun (no Nest) |");
    await rm(join(output, "report.md"));
    const render = Bun.spawnSync([process.execPath, RENDER, output]);
    expect(render.exitCode).toBe(0);
    expect(await readFile(join(output, "report.md"), "utf8")).toBe(written);
  } finally {
    runner.killAll();
    await oha.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test.each([
  ["named by BENCH_OHA", (path: string) => ({ BENCH_OHA: path })],
  [
    "found on PATH",
    (path: string) => ({ PATH: `${dirname(path)}:${process.env.PATH}` }),
  ],
] as const)(
  "a run with oha and no --oha uses the oha %s",
  async (_, env) => {
    const { directory, output } = await scratch();
    const oha = await fakeOha([{ stdout: ohaOutput() }]);
    const runner = run(["--generator", "oha", "--output", output], {
      ...(process.env as Record<string, string>),
      ...env(oha.path),
    });
    try {
      expect(await runner.exited).toBe(0);
      expect(await oha.runs()).toHaveLength(6);
    } finally {
      runner.killAll();
      await oha.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

// autocannon's figures, as the driver (load.mjs) prints them
const autocannonOutput = JSON.stringify({
  requests: { average: 1000 },
  latency: { p99: 1 },
  errors: 0,
  timeouts: 0,
  non2xx: 0,
  mismatches: 0,
});

test.each([
  [
    "exits with an error",
    // Whatever it printed before
    {
      exit: 1,
      stdout: autocannonOutput,
      stderr: "Error: connect ECONNREFUSED\n",
    },
    "Load generator exited 1: Error: connect ECONNREFUSED",
  ],
  [
    "prints something other than its figures",
    { stdout: "Running 1s test\n" },
    "Invalid driver output",
  ],
] as const)(
  "a run whose autocannon driver %s stops without a measured trial",
  async (_, failure, message) => {
    const { directory, output } = await scratch();
    // The Node that runs the autocannon driver, which records its runs
    const node = await fakeExecutable("node", {
      version: "v26.0.0\n",
      outputs: [failure],
    });
    const runner = run(["--node", node.path, "--output", output]);
    try {
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain(message);
      const [first] = await node.runs();
      expect(first!.args[0]).toEndWith("benchmark/load.mjs");
      const { trials } = JSON.parse(
        await readFile(join(output, "raw.json"), "utf8"),
      );
      expect(trials).toEqual([]);
    } finally {
      runner.killAll();
      await node.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);
