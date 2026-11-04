// The reports of both benchmarks, rendered from the data a run keeps in its
// raw.json: what each target is, in words, and how platform-bun compares.
import { expect, test } from "bun:test";
import { renderNestReport } from "../../benchmark/nest/report.mjs";
import { renderControllersReport } from "../../benchmark/report.mjs";
import {
  controllersRun,
  environment,
  nestRun,
  nestSummary,
} from "../support/benchmark-runs";

// The rows of the first table after a heading
function table(report: string, heading: string) {
  const lines = report.split("\n");
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThan(-1);
  const first = lines.findIndex(
    (line, index) => index > start && line.startsWith("|"),
  );
  const rows: string[] = [];
  for (let index = first + 2; lines[index]?.startsWith("|"); index++)
    rows.push(lines[index]);
  return rows;
}

const nestMatrix = nestRun([
  nestSummary("node", "node", 202_595),
  nestSummary("nest-node", "node", 180_428),
  nestSummary("express", "node", 110_205),
  nestSummary("nest-express", "node", 102_176),
  nestSummary("bun", "bun", 333_952),
  nestSummary("nest-node", "bun", 160_087),
  nestSummary("nest-bun", "bun", 198_231),
]);

test("Nest's benchmark report names each target by its adapter, or its server without Nest, and its runtime, platform-bun and platform-node first", () => {
  expect(table(renderNestReport(nestMatrix), "## Requests per second")).toEqual(
    [
      "| platform-bun on Bun | 198,231 | 197,231–199,231 |",
      "| platform-node on Node | 180,428 | 179,428–181,428 |",
      "| platform-node on Bun | 160,087 | 159,087–161,087 |",
      "| platform-express on Node | 102,176 | 101,176–103,176 |",
      "| Bun.serve() on Bun (no Nest) | 333,952 | 332,952–334,952 |",
      "| node:http on Node (no Nest) | 202,595 | 201,595–203,595 |",
      "| Express on Node (no Nest) | 110,205 | 109,205–111,205 |",
    ],
  );
});

test("Nest's benchmark report gives platform-bun's lead over each other Nest adapter, each adapter's change from Node to Bun, and what Nest costs over its server", () => {
  const report = renderNestReport(nestMatrix);
  expect(report).toContain(
    [
      "platform-bun on Bun against the other Nest adapters:",
      "",
      "- platform-node on Node: +9.9% (198,231 against 180,428 requests/s)",
      "- platform-node on Bun: +23.8% (198,231 against 160,087 requests/s)",
      "- platform-express on Node: +94.0% (198,231 against 102,176 requests/s)",
    ].join("\n"),
  );
  expect(report).toContain(
    [
      "Each Nest adapter on Bun against itself on Node:",
      "",
      "- platform-node: −11.3% (160,087 against 180,428 requests/s)",
    ].join("\n"),
  );
  expect(report).toContain(
    [
      "Each Nest adapter against its server without Nest, on the same runtime:",
      "",
      "- platform-bun on Bun against Bun.serve() on Bun: −40.6% (198,231 against 333,952 requests/s)",
      "- platform-node on Node against node:http on Node: −10.9% (180,428 against 202,595 requests/s)",
      "- platform-express on Node against Express on Node: −7.3% (102,176 against 110,205 requests/s)",
    ].join("\n"),
  );
});

test("Nest's benchmark report keeps each target's server and generator load and errors, in the same order", () => {
  const rows = table(
    renderNestReport(nestMatrix),
    "## Server and load generator",
  );
  expect(rows[0]).toBe(
    "| platform-bun on Bun | 0.61 | 0.43 | 0.81 | 4.50 | 9 | 30.0 MB/s | 0 / 0 / 0 |",
  );
  expect(rows.map((row) => row.split(" | ")[0])).toEqual([
    "| platform-bun on Bun",
    "| platform-node on Node",
    "| platform-node on Bun",
    "| platform-express on Node",
    "| Bun.serve() on Bun (no Nest)",
    "| node:http on Node (no Nest)",
    "| Express on Node (no Nest)",
  ]);
});

const controllers = controllersRun({
  "raw-bun": [206_246, 197_030, 164_365],
  "node-bun": [142_784, 145_779, 115_270],
  bun: [179_034, 166_208, 132_000],
  "node-node": [141_094, 134_694, 101_843],
  "express-bun": [116_691, 108_230, 83_002],
});

test("the controllers benchmark report gives each target one row of medians by route, platform-bun and platform-node first, without the invalid trials", () => {
  expect(
    table(renderControllersReport(controllers), "## Requests per second"),
  ).toEqual([
    "| platform-bun on Bun | 179,034 | 166,208 | 132,000 |",
    "| platform-node on Node | 141,094 | 134,694 | 101,843 |",
    "| platform-node on Bun | 142,784 | 145,779 | 115,270 |",
    "| platform-express on Bun | 116,691 | 108,230 | 83,002 |",
    "| Bun.serve() on Bun (no Nest) | 206,246 | 197,030 | 164,365 |",
  ]);
});

test("the controllers benchmark report gives platform-bun's lead over each other Nest adapter on every route", () => {
  const report = renderControllersReport(controllers);
  expect(
    table(report, "platform-bun on Bun against the other Nest adapters:"),
  ).toEqual([
    "| platform-node on Node | +26.9% | +23.4% | +29.6% |",
    "| platform-node on Bun | +25.4% | +14.0% | +14.5% |",
    "| platform-express on Bun | +53.4% | +53.6% | +59.0% |",
  ]);
});

test("the controllers benchmark report keeps every target's spread, p99 and errors by route in its details", () => {
  const rows = table(renderControllersReport(controllers), "## Details");
  expect(rows[0]).toBe(
    "| platform-bun on Bun | GET `/` | 179,034 | 178,534–179,734 | 1 | 0 / 0 / 0 |",
  );
  expect(rows).toHaveLength(15);
});

test("Nest's benchmark report gives platform-bun's lead only when platform-bun and another Nest adapter were measured", () => {
  const heading = "platform-bun on Bun against the other Nest adapters:";
  const withoutBun = nestRun([
    nestSummary("nest-node", "node", 180_428),
    nestSummary("nest-node", "bun", 160_087),
  ]);
  expect(renderNestReport(withoutBun)).not.toContain(heading);
  const bunAlone = nestRun([
    nestSummary("nest-bun", "bun", 198_231),
    nestSummary("bun", "bun", 333_952),
  ]);
  expect(renderNestReport(bunAlone)).not.toContain(heading);
});

test("a run of a single round says so, in both reports", () => {
  expect(
    renderNestReport({
      ...nestMatrix,
      args: { ...nestMatrix.args, rounds: 1 },
    }),
  ).toContain("Each target ran 1 round of a 10 s warm-up");
  const { metadata } = controllers;
  expect(
    renderControllersReport({
      ...controllers,
      metadata: { ...metadata, settings: { ...metadata.settings, rounds: 1 } },
    }),
  ).toContain("Each target ran 1 round of a 2 s warm-up");
});

test("the controllers benchmark report gives platform-bun's lead only for a complete run that measured it", () => {
  const heading = "platform-bun on Bun against the other Nest adapters:";
  expect(
    renderControllersReport({
      ...controllers,
      metadata: { ...controllers.metadata, completed: false },
    }),
  ).not.toContain(heading);
  const withoutBun = controllersRun({
    "node-node": [141_094, 134_694, 101_843],
    "node-bun": [142_784, 145_779, 115_270],
  });
  expect(renderControllersReport(withoutBun)).not.toContain(heading);
});

test("a route a target has no valid trial on reads n/a, in its rates and in platform-bun's lead over it", () => {
  const report = renderControllersReport({
    ...controllers,
    trials: controllers.trials.map((trial) =>
      trial.target === "node-node" && trial.scenario === "json"
        ? { ...trial, valid: false }
        : trial,
    ),
  });
  expect(table(report, "## Requests per second")[1]).toBe(
    "| platform-node on Node | 141,094 | 134,694 | n/a |",
  );
  expect(
    table(report, "platform-bun on Bun against the other Nest adapters:")[0],
  ).toBe("| platform-node on Node | +26.9% | +23.4% | n/a |");
});

test("the controllers benchmark report names the runtime each server reported, leaving out a server that reported none", () => {
  const { "express-bun": _express, ...runtimes } =
    controllers.metadata.runtimes;
  const report = renderControllersReport({
    ...controllers,
    metadata: { ...controllers.metadata, runtimes },
  });
  expect(report).toContain(
    "- Runtimes the servers reported: platform-bun on Bun: Bun 1.4.4; platform-node on Node: Node v26.13.0; platform-node on Bun: Bun 1.4.4; Bun.serve() on Bun (no Nest): Bun 1.4.4.",
  );
});

test("a run's warnings close its report, and a run without any has no warnings", () => {
  expect(renderControllersReport(controllers)).not.toContain("Warnings:");
  const report = renderControllersReport({
    ...controllers,
    metadata: {
      ...controllers.metadata,
      warnings: ["the load generator used 0.98 cores"],
    },
  });
  expect(
    report.endsWith("Warnings:\n\n- the load generator used 0.98 cores\n"),
  ).toBe(true);
});

test("a report's reproduce command names each executable as the run recorded it, as one shell word whose ~/ the shell expands", () => {
  const nest = renderNestReport({
    ...nestMatrix,
    args: {
      ...nestMatrix.args,
      node: "~/.nvm/versions/node/v26.13.0/bin/node",
      bun: ".tools/bun-1.4.4/bun",
      generator: "wrk",
      wrk: "~/my tools/wrk",
      threads: 4,
    },
  });
  expect(nest).toContain(
    "--node ~/.nvm/versions/node/v26.13.0/bin/node --bun .tools/bun-1.4.4/bun --generator wrk --wrk ~/'my tools/wrk' --threads 4",
  );
  const report = renderControllersReport({
    ...controllers,
    metadata: {
      ...controllers.metadata,
      settings: {
        ...controllers.metadata.settings,
        node: "/opt/it's/node",
        bun: ".tools/bun-1.4.4/bun",
      },
    },
  });
  expect(report).toContain(
    "--node '/opt/it'\\''s/node' --bun .tools/bun-1.4.4/bun",
  );
});

test("a run recorded before its load generator was named reports autocannon, the only generator then", () => {
  const { name: _name, ...unnamed } = environment.runtimes.loadGenerator;
  const report = renderNestReport({
    ...nestMatrix,
    environment: {
      ...environment,
      runtimes: { ...environment.runtimes, loadGenerator: unnamed },
    },
  });
  expect(report).toContain(
    "Load generator: autocannon 8.0.0 on Node v26.13.0 (`/node`).",
  );
});

test("the controllers benchmark report names the Nest version the run measured", () => {
  const { metadata } = controllers;
  const report = renderControllersReport({
    ...controllers,
    metadata: {
      ...metadata,
      environment: {
        ...metadata.environment,
        packages: {
          ...metadata.environment.packages,
          "@nestjs/core": "12.9.1",
        },
      },
    },
  });
  expect(report).toContain(
    "Real Nest 12.9.1 controllers answer every Nest request",
  );
});
