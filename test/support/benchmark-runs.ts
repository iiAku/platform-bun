// Runs of both benchmarks as their raw.json keeps them, for the tests of
// what is rendered from them

export const environment = {
  host: {
    cpu: "Test CPU",
    physicalCores: 12,
    logicalCPUs: 12,
    smt: false,
    memoryGiB: 60,
    platform: "linux",
    kernel: "7.1.12",
    arch: "x64",
    cpuGovernor: "performance",
    energyPerformancePreference: "performance",
    loadAverage: [1, 1, 1],
  },
  runtimes: {
    node: { version: "v26.13.0", path: "/node" },
    bun: { version: "1.4.4", path: "/bun" },
    loadGenerator: { name: "autocannon", version: "v26.13.0", path: "/node" },
  },
  packages: { autocannon: "8.0.0", "@nestjs/core": "12.3.3" },
  pinning: { server: "0,1,2,3", generator: "4,5,6,7", cores: 12 },
};

export function nestSummary(framework: string, runtime: string, rps: number) {
  return {
    target: `${framework}@${runtime}`,
    framework,
    runtime,
    runtimeVersion: runtime === "bun" ? "1.4.4" : "v26.13.0",
    rounds: 3,
    requestsPerSecAvg: rps,
    requestsPerSecMin: rps - 1000,
    requestsPerSecMax: rps + 1000,
    latencyAvgMs: 4.5,
    latencyP99Ms: 9,
    throughputBytesPerSecAvg: 30 * 1024 * 1024,
    serverCpu: 0.61,
    serverSoftirqCpu: 0.43,
    generatorCpu: 0.81,
    errors: 0,
    timeouts: 0,
    non2xx: 0,
    httpErrors: 0,
  };
}

export function nestRun(summaries: ReturnType<typeof nestSummary>[]) {
  return {
    startedAt: "2026-11-03T22:07:37.953Z",
    args: {
      targets: summaries.map((s) => ({
        name: s.target,
        framework: s.framework,
        runtime: s.runtime,
      })),
      node: "/node",
      bun: "/bun",
      rounds: 3,
      connections: 100,
      duration: 10,
      pipelining: 10,
    },
    environment,
    summaries,
  };
}

export const scenarios = [
  { name: "plaintext", method: "GET", path: "/", status: 200, expected: "x" },
  {
    name: "params",
    method: "GET",
    path: "/users/42",
    status: 200,
    expected: "x",
  },
  { name: "json", method: "POST", path: "/echo", status: 201, expected: "x" },
];

// Three valid rounds per route, the median in the middle, and one invalid
// trial that must not count
export function controllersRun(medians: Record<string, number[]>) {
  const trials = Object.entries(medians).flatMap(([target, perRoute]) =>
    scenarios.flatMap((scenario, index) =>
      [-500, 0, 700, 90_000].map((offset, round) => ({
        round,
        target,
        scenario: scenario.name,
        valid: round < 3,
        result: {
          requests: { average: perRoute[index] + offset },
          latency: { p99: 1 },
          errors: 0,
          non2xx: 0,
          mismatches: 0,
        },
      })),
    ),
  );
  const targets = Object.keys(medians);
  return {
    metadata: {
      generatedAt: "2026-11-03T22:01:05.136Z",
      completed: true,
      settings: {
        duration: 5,
        warmup: 2,
        rounds: 3,
        connections: 100,
        workers: 4,
        pipelining: 1,
        generator: "autocannon",
        node: "/node",
        bun: "/bun",
        targets,
      },
      environment,
      runtimes: Object.fromEntries(
        targets.map((target) => [
          target,
          target === "node-node" ? "Node v26.13.0" : "Bun 1.4.4",
        ]),
      ),
      warnings: [],
    },
    scenarios,
    trials,
  };
}
