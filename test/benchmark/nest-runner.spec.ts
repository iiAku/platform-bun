// Nest's benchmark runner (benchmark/nest/main.mjs) measures whatever answers
// on its port: it must only ever measure the server it started.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expandCpuList } from "../../benchmark/environment.mjs";
import { fakeExecutable } from "../support/fake-generator";
import { waitFor } from "../support/wait-for";

const RUNNER = join(import.meta.dir, "../../benchmark/nest/main.mjs");
const RENDER = join(import.meta.dir, "../../benchmark/render.mjs");

// The runner on Node, as `node benchmark/nest/main.mjs` runs it, in a process
// group of its own so that a test can take down everything it started
function run(args: string[], env?: Record<string, string>) {
  const child = spawn(
    Bun.which("node")!,
    [RUNNER, "--targets", "node@node", "--rounds", "1", ...args],
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
    child,
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

function accepts(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), "nest-runner-"));
  return { directory, output: join(directory, "run") };
}

test("a run on a port another server answers on stops before measuring it", async () => {
  const other = Bun.serve({
    port: 0,
    fetch: () => new Response("Hello world!"),
  });
  const { directory, output } = await scratch();
  const runner = run([
    "--port",
    String(other.port),
    "--duration",
    "1",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(1);
    expect(runner.stderr()).toContain(`port ${other.port}`);
    expect(runner.stdout()).not.toContain("warm-up");
    expect(existsSync(output)).toBe(false);
  } finally {
    runner.killAll();
    void other.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

// The server processes of a runner, by process group
function serversOf(group: number) {
  const found = Bun.spawnSync([
    "pgrep",
    "-g",
    String(group),
    "-f",
    "benchmark/nest/frameworks/",
  ]);
  return found.stdout.toString().trim().split("\n").filter(Boolean).map(Number);
}

test.each([
  ["SIGINT", 2],
  ["SIGTERM", 15],
  ["SIGHUP", 1],
] as const)(
  "a run stopped by %s takes its server down with it",
  async (signal, number) => {
    const port = await freePort();
    const { directory, output } = await scratch();
    const runner = run([
      "--port",
      String(port),
      "--duration",
      "30",
      "--output",
      output,
    ]);
    try {
      await waitFor(() => expect(runner.stdout()).toContain("warm-up"), {
        timeout: 8000,
      });
      expect(await accepts(port)).toBe(true);
      // As a supervisor stops it: the runner's own process, not its group
      runner.child.kill(signal);
      expect(await runner.exited).toBe(128 + number);
      await waitFor(async () => expect(await accepts(port)).toBe(false), {
        timeout: 2000,
      });
    } finally {
      runner.killAll();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test.each([
  ["warm-up", false],
  ["measuring", true],
] as const)(
  "a run whose server another one replaced while %s stops without a result",
  async (phase, measured) => {
    const port = await freePort();
    const { directory, output } = await scratch();
    const runner = run([
      "--port",
      String(port),
      "--duration",
      "1",
      "--output",
      output,
    ]);
    let other: ReturnType<typeof Bun.serve> | undefined;
    try {
      await waitFor(() => expect(runner.stdout()).toContain(`${phase} 1s`), {
        timeout: 8000,
      });
      // Its server goes away, and another one answers on its port
      for (const pid of serversOf(runner.child.pid!))
        process.kill(pid, "SIGKILL");
      await waitFor(async () => expect(await accepts(port)).toBe(false), {
        timeout: 2000,
      });
      other = Bun.serve({
        port,
        fetch: () => new Response("Hello world!"),
      });
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain(`port ${port}`);
      // A server replaced during the warm-up is not measured at all
      expect(runner.stdout().includes("measuring")).toBe(measured);
      expect(existsSync(output)).toBe(false);
    } finally {
      runner.killAll();
      void other?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test("a measured run reports the softirq time of its server's own CPUs", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { environment, samples, summaries } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    // The server has CPUs of its own whenever the host has the cores for it;
    // node:http answering on loopback, they deliver every response
    const own = environment.pinning.server !== undefined;
    const [sample] = samples;
    expect(sample.serverSoftirqCpu > 0).toBe(own);
    expect(summaries[0].serverSoftirqCpu).toBe(sample.serverSoftirqCpu);
    expect(await readFile(join(output, "report.md"), "utf8")).toContain(
      ` | ${sample.serverCpu.toFixed(2)} | ${own ? sample.serverSoftirqCpu.toFixed(2) : "?"} | `,
    );
  } finally {
    runner.killAll();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("a run that cannot pin its server reports no softirq time for it", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  // Without taskset on its PATH the runner pins nothing: the server shares
  // its CPUs with the load generator
  const runner = run(
    [
      "--port",
      String(port),
      "--duration",
      "1",
      "--rounds",
      "2",
      "--bun",
      process.execPath,
      "--output",
      output,
    ],
    { PATH: dirname(Bun.which("node")!) },
  );
  try {
    expect(await runner.exited).toBe(0);
    const { environment, samples, summaries } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    expect(environment.pinning.server).toBeUndefined();
    expect(
      samples.map((s: { serverSoftirqCpu?: number }) => s.serverSoftirqCpu),
    ).toEqual([undefined, undefined]);
    expect(summaries[0].serverSoftirqCpu).toBeUndefined();
    expect(await readFile(join(output, "report.md"), "utf8")).toContain(
      " | ? | ",
    );
  } finally {
    runner.killAll();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a measured run's CPU figures are per second of the run autocannon made", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  // autocannon stops on its one-second sampler: a half-second run lasts one
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "0.5",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { samples, raw } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    expect(raw[0].result.duration).toBeGreaterThanOrEqual(1);
    // One thread each: no more than a core, with the kernel's time for the
    // server, however long autocannon ran
    const [sample] = samples;
    expect(sample.serverCpu + (sample.serverSoftirqCpu ?? 0)).toBeLessThan(1.2);
    expect(sample.generatorCpu).toBeLessThan(1.2);
  } finally {
    runner.killAll();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

// wrk's own first lines, then the figures the runner's wrk script prints
const wrkReport = (figures: object) =>
  `Running 1s test @ http://127.0.0.1/\n  4 threads and 100 connections\n${JSON.stringify(figures)}\n`;

const NO_ERRORS = { connect: 0, read: 0, write: 0, status: 0, timeout: 0 };

function wrkOutput({
  requests,
  durationUs,
  bytes = 0,
  errors = {},
}: {
  requests: number;
  durationUs: number;
  bytes?: number;
  errors?: Partial<typeof NO_ERRORS>;
}) {
  return wrkReport({
    requests,
    durationUs,
    bytes,
    errors: { ...NO_ERRORS, ...errors },
  });
}

// As wrk 4.2.0 answers --version: its version, then its usage, exiting 1
const fakeWrk = (outputs: Parameters<typeof fakeExecutable>[1]["outputs"]) =>
  fakeExecutable("wrk", {
    version:
      "wrk 4.2.0 [fake] Copyright (C) 2012 Will Glozer\nUsage: wrk <options> <url>\n",
    versionExit: 1,
    outputs,
  });

// The value after `flag` in a recorded command line
const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("a run with wrk sends each connection's requests in batches of the pipelining depth and reports wrk's rate", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  const wrk = await fakeWrk([
    {
      stdout: wrkOutput({
        requests: 3_000_000,
        durationUs: 10_000_000,
        bytes: 375_000_000,
      }),
    },
  ]);
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--pipelining",
    "10",
    "--generator",
    "wrk",
    "--wrk",
    wrk.path,
    "--threads",
    "4",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { environment, samples } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    // A warm-up, then the measured run, from the load generator's CPUs
    const runs = await wrk.runs();
    expect(runs).toHaveLength(2);
    const batch = `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`.repeat(
      10,
    );
    for (const { args, cpus } of runs) {
      expect(valueOf(args, "-c")).toBe("100");
      expect(valueOf(args, "-t")).toBe("4");
      expect(valueOf(args, "-d")).toBe("1s");
      expect(existsSync(valueOf(args, "-s")!)).toBe(true);
      expect(args).toContain(`http://127.0.0.1:${port}/`);
      // The script's argument: what each connection sends at once
      expect(args.at(-1)).toBe(batch);
      if (environment.pinning.generator !== undefined)
        expect(expandCpuList(cpus!)).toEqual(
          expandCpuList(environment.pinning.generator),
        );
    }
    expect(samples[0]).toMatchObject({
      requestsPerSecAvg: 300_000,
      totalRequests: 3_000_000,
      throughputBytesPerSecAvg: 37_500_000,
    });
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("a run with wrk reports its socket errors, timeouts and 4xx/5xx answers, as all that wrk counts", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  const errors = { connect: 1, read: 2, write: 3, status: 4, timeout: 5 };
  const wrk = await fakeWrk([
    { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000, errors }) },
  ]);
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--generator",
    "wrk",
    "--wrk",
    wrk.path,
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { samples, summaries } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    // wrk sees no redirect: what it reports as status errors are 4xx and 5xx
    for (const figures of [samples[0], summaries[0]]) {
      expect(figures).toMatchObject({ errors: 6, timeouts: 5, httpErrors: 4 });
      expect(figures.non2xx).toBeUndefined();
    }
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).toContain("| Errors / timeouts / 4xx–5xx |");
    expect(report).toContain("| 6 / 5 / 4 |");
    expect(runner.stdout()).toContain("errors=6 timeouts=5 4xx–5xx=4");
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test.each([
  [
    "whose connections wrk's threads cannot share evenly",
    ["--connections", "100", "--threads", "8"],
    "--threads",
  ],
  ["whose wrk thread count is not whole", ["--threads", "2.5"], "--threads"],
  [
    "whose duration is not whole seconds, all wrk takes",
    ["--duration", "1.5"],
    "--duration",
  ],
  ["whose wrk is missing", ["--wrk", "/nonexistent/wrk"], "/nonexistent/wrk"],
  [
    "with a load generator the runner does not know",
    ["--generator", "oha"],
    "--generator",
  ],
] as const)(
  "a run %s is refused before any server starts",
  async (_, options, message) => {
    const { directory, output } = await scratch();
    // Every server would run on this Node, which records it
    const node = await fakeExecutable("node", {
      version: "v26.0.0\n",
      outputs: [{ exit: 1 }],
    });
    const wrk = await fakeWrk([
      { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }) },
    ]);
    const runner = run([
      "--node",
      node.path,
      "--port",
      String(await freePort()),
      "--duration",
      "1",
      "--generator",
      "wrk",
      "--wrk",
      wrk.path,
      ...options,
      "--output",
      output,
    ]);
    try {
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain(message);
      expect(await node.runs()).toEqual([]);
      expect(await wrk.runs()).toEqual([]);
      expect(existsSync(output)).toBe(false);
    } finally {
      runner.killAll();
      await node.remove();
      await wrk.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test("a run with wrk reports wrk as its load generator, with the CPU wrk used and no latency", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  // Every run keeps a CPU busy for 400 ms, as wrk would
  const wrk = await fakeWrk([
    {
      busyMs: 400,
      stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }),
    },
  ]);
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--rounds",
    "2",
    "--connections",
    "10",
    "--generator",
    "wrk",
    "--wrk",
    wrk.path,
    "--threads",
    "2",
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const { environment, samples, summaries } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    expect(environment.runtimes.loadGenerator).toEqual({
      name: "wrk",
      path: wrk.path,
      version: "wrk 4.2.0 [fake]",
    });
    // wrk's own CPU, not the runner's, which waits for it
    for (const sample of samples)
      expect(sample.generatorCpu).toBeGreaterThan(0.5);
    // Under pipelining, wrk times batches of requests, not requests
    expect(summaries[0].latencyAvgMs).toBeUndefined();
    expect(summaries[0].latencyP99Ms).toBeUndefined();
    expect(runner.stdout()).not.toContain("undefined");
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).toContain(
      `Load generator: wrk 4.2.0 [fake] (\`${wrk.path}\`)`,
    );
    expect(report).toContain(" | n/a | n/a | ");
    expect(report).toContain(`--generator wrk --wrk ${wrk.path} --threads 2`);
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a run records its executables from ~ when they are in the home directory, and neither the host's name nor where it wrote the run", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  const wrk = await fakeWrk([
    { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }) },
  ]);
  // The run's home directory holds its wrk, its Node and its Bun
  const home = dirname(wrk.path);
  await symlink(Bun.which("node")!, join(home, "node"));
  await symlink(process.execPath, join(home, "bun"));
  const runner = run(
    [
      "--port",
      String(port),
      "--duration",
      "1",
      "--generator",
      "wrk",
      "--wrk",
      wrk.path,
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
    const { args, environment } = JSON.parse(
      await readFile(join(output, "raw.json"), "utf8"),
    );
    const { runtimes, host } = environment;
    expect([args.node, args.bun, args.wrk]).toEqual([
      "~/node",
      "~/bun",
      "~/wrk",
    ]);
    expect([
      runtimes.node.path,
      runtimes.bun.path,
      runtimes.loadGenerator.path,
    ]).toEqual(["~/node", "~/bun", "~/wrk"]);
    expect(args).not.toHaveProperty("output");
    expect(host).not.toHaveProperty("hostname");
    const report = await readFile(join(output, "report.md"), "utf8");
    expect(report).not.toContain(home);
    expect(report).toContain(
      "--node ~/node --bun ~/bun --generator wrk --wrk ~/wrk",
    );
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("a report rendered again on Node from a run's raw.json is the report the run wrote", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  const wrk = await fakeWrk([
    { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }) },
  ]);
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--generator",
    "wrk",
    "--wrk",
    wrk.path,
    "--output",
    output,
  ]);
  try {
    expect(await runner.exited).toBe(0);
    const written = await readFile(join(output, "report.md"), "utf8");
    expect(written).toContain("| node:http on Node (no Nest) |");
    await rm(join(output, "report.md"));
    const render = Bun.spawnSync([Bun.which("node")!, RENDER, output]);
    expect(render.exitCode).toBe(0);
    expect(await readFile(join(output, "report.md"), "utf8")).toBe(written);
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test.each([
  [
    "exits with an error",
    // Whatever it printed before
    {
      exit: 1,
      stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }),
      stderr: "unable to connect to 127.0.0.1:3000 Connection refused\n",
    },
    "unable to connect to 127.0.0.1:3000",
  ],
  [
    "prints no figures",
    { stdout: "Running 1s test @ http://127.0.0.1/\n" },
    "no figures",
  ],
  [
    "prints figures without a request count",
    {
      stdout: wrkReport({ durationUs: 1_000_000, bytes: 0, errors: NO_ERRORS }),
    },
    "no figures",
  ],
  [
    "prints figures over no time",
    { stdout: wrkOutput({ requests: 1000, durationUs: 0 }) },
    "no figures",
  ],
  [
    "prints figures without a byte count",
    {
      stdout: wrkReport({
        requests: 1000,
        durationUs: 1_000_000,
        errors: NO_ERRORS,
      }),
    },
    "no figures",
  ],
  [
    "prints figures without its timeouts",
    {
      stdout: wrkReport({
        requests: 1000,
        durationUs: 1_000_000,
        bytes: 0,
        errors: { connect: 0, read: 0, write: 0, status: 0 },
      }),
    },
    "no figures",
  ],
  [
    "prints figures without error counts",
    { stdout: wrkReport({ requests: 1000, durationUs: 1_000_000, bytes: 0 }) },
    "no figures",
  ],
  [
    "prints a duration that is not a number",
    {
      stdout: wrkReport({
        requests: 1000,
        durationUs: true,
        bytes: 0,
        errors: NO_ERRORS,
      }),
    },
    "no figures",
  ],
  [
    "prints a negative count",
    {
      stdout: wrkOutput({
        requests: 1000,
        durationUs: 1_000_000,
        errors: { read: -1 },
      }),
    },
    "no figures",
  ],
  [
    "prints a fractional count",
    { stdout: wrkOutput({ requests: 1000.5, durationUs: 1_000_000 }) },
    "no figures",
  ],
] as const)(
  "a run whose wrk %s while measuring stops with wrk's account of it and no results",
  async (_, failure, message) => {
    const { directory, output } = await scratch();
    // A clean warm-up, then the measured run
    const wrk = await fakeWrk([
      { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }) },
      failure,
    ]);
    const runner = run([
      "--port",
      String(await freePort()),
      "--duration",
      "1",
      "--generator",
      "wrk",
      "--wrk",
      wrk.path,
      "--output",
      output,
    ]);
    try {
      expect(await runner.exited).toBe(1);
      expect(runner.stderr()).toContain(message);
      expect(await wrk.runs()).toHaveLength(2);
      expect(existsSync(output)).toBe(false);
    } finally {
      runner.killAll();
      await wrk.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

test.each([
  ["named by BENCH_WRK", (path: string) => ({ BENCH_WRK: path })],
  [
    "found on PATH",
    (path: string) => ({ PATH: `${dirname(path)}:${process.env.PATH}` }),
  ],
] as const)(
  "a run with wrk and no --wrk uses the wrk %s",
  async (_, env) => {
    const port = await freePort();
    const { directory, output } = await scratch();
    const wrk = await fakeWrk([
      { stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }) },
    ]);
    const runner = run(
      [
        "--port",
        String(port),
        "--duration",
        "1",
        "--generator",
        "wrk",
        "--output",
        output,
      ],
      { ...(process.env as Record<string, string>), ...env(wrk.path) },
    );
    try {
      expect(await runner.exited).toBe(0);
      expect(await wrk.runs()).toHaveLength(2);
    } finally {
      runner.killAll();
      await wrk.remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15_000,
);

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a run with wrk stopped by a signal takes wrk down with it", async () => {
  const port = await freePort();
  const { directory, output } = await scratch();
  // A warm-up that would keep wrk running for 30 s
  const wrk = await fakeWrk([
    {
      busyMs: 30_000,
      stdout: wrkOutput({ requests: 1000, durationUs: 1_000_000 }),
    },
  ]);
  const runner = run([
    "--port",
    String(port),
    "--duration",
    "1",
    "--generator",
    "wrk",
    "--wrk",
    wrk.path,
    "--output",
    output,
  ]);
  try {
    const [{ pid }] = await waitFor(
      async () => {
        const runs = await wrk.runs();
        expect(runs).toHaveLength(1);
        return runs as [{ pid: number }];
      },
      { timeout: 8000 },
    );
    // Left running, it would load the next run's server on the same port
    runner.child.kill("SIGTERM");
    expect(await runner.exited).toBe(143);
    await waitFor(() => expect(alive(pid)).toBe(false), { timeout: 2000 });
  } finally {
    runner.killAll();
    await wrk.remove();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
