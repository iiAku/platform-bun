// Renders the report of each result directory given again from its raw.json,
// as the run that measured it would write it now:
//   node benchmark/render.mjs benchmark/results/<run> [...]
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderNestReport } from "./nest/report.mjs";
import { renderControllersReport } from "./report.mjs";

const directories = process.argv.slice(2);
if (directories.length === 0) {
  process.stderr.write(
    "Usage: node benchmark/render.mjs <result directory>...\n",
  );
  process.exit(1);
}
for (const directory of directories) {
  const raw = JSON.parse(await readFile(join(directory, "raw.json"), "utf8"));
  // Nest's benchmark keeps its summaries; the controllers benchmark, its trials
  const report = Array.isArray(raw.summaries)
    ? renderNestReport(raw)
    : renderControllersReport(raw);
  await writeFile(join(directory, "report.md"), report);
  process.stdout.write(`${join(directory, "report.md")}\n`);
}
