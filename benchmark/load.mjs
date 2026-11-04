// Run under Node, in a separate process from the server and orchestrator.
import autocannon from "autocannon";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const options = JSON.parse(input);
const startCPU = process.cpuUsage();
try {
  const result = await new Promise((resolve, reject) =>
    autocannon(options, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  result.driverCPU = process.cpuUsage(startCPU);
  result.driverRuntime = `Node ${process.version}`;
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(String(error?.stack ?? error));
  process.exitCode = 1;
}
