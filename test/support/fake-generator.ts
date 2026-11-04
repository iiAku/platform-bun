// A stand-in for an executable the benchmark runners start, such as a load
// generator (wrk, oha): it records every run it is asked for, with the CPUs it
// was allowed to run on, and answers with canned output, so that the runners'
// tests need none of those tools installed.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A run the fake was asked for, by the process that made it. */
export type FakeRun = { args: string[]; cpus?: string; pid: number };

/** What one run prints, how long it keeps a CPU busy first, and its exit code. */
export type FakeOutput = {
  stdout?: string;
  stderr?: string;
  exit?: number;
  busyMs?: number;
};

// The nth run answers with the nth output, and the runs past the last output
// with the last one. `--version` is answered without being recorded.
const SCRIPT = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const config = JSON.parse(readFileSync(join(__dirname, "config.json"), "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(config.version);
  process.exitCode = config.versionExit;
} else {
  const record = join(__dirname, "runs.jsonl");
  let runs = 0;
  try {
    runs = readFileSync(record, "utf8").split("\\n").filter(Boolean).length;
  } catch {}
  let cpus;
  try {
    cpus = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\\s*(.+)$/m)[1];
  } catch {}
  appendFileSync(record, JSON.stringify({ args, cpus, pid: process.pid }) + "\\n");
  const output = config.outputs[Math.min(runs, config.outputs.length - 1)];
  const until = Date.now() + (output.busyMs ?? 0);
  while (Date.now() < until);
  process.stdout.write(output.stdout ?? "");
  process.stderr.write(output.stderr ?? "");
  process.exitCode = output.exit ?? 0;
}
`;

export async function fakeExecutable(
  name: string,
  {
    version,
    versionExit = 0,
    outputs,
  }: { version: string; versionExit?: number; outputs: FakeOutput[] },
) {
  const directory = await mkdtemp(join(tmpdir(), `fake-${name}-`));
  const path = join(directory, name);
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ version, versionExit, outputs }),
  );
  await writeFile(path, SCRIPT);
  await chmod(path, 0o755);
  return {
    path,
    async runs(): Promise<FakeRun[]> {
      let text = "";
      try {
        text = await readFile(join(directory, "runs.jsonl"), "utf8");
      } catch {}
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeRun);
    },
    remove: () => rm(directory, { recursive: true, force: true }),
  };
}
