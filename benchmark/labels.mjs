// The names the reports give the benchmarks' targets: a Nest adapter, or a
// server without Nest, and the runtime it runs on.

const RUNTIMES = { node: "Node", bun: "Bun" };
const ADAPTERS = {
  "nest-bun": "platform-bun",
  "nest-node": "platform-node",
  "nest-fastify": "platform-fastify",
  "nest-express": "platform-express",
};
const SERVERS = {
  bun: "Bun.serve()",
  node: "node:http",
  fastify: "Fastify",
  express: "Express",
};

// The order the reports list targets in: platform-bun, the platform-node
// baselines, the other Nest adapters, then the servers without Nest
const ORDER = [
  "nest-bun@bun",
  "nest-node@node",
  "nest-node@bun",
  "nest-fastify@node",
  "nest-fastify@bun",
  "nest-express@node",
  "nest-express@bun",
  "bun@bun",
  "node@node",
  "node@bun",
  "fastify@node",
  "fastify@bun",
  "express@node",
  "express@bun",
];

// The controllers benchmark's targets, as framework and runtime
const CONTROLLERS = {
  bun: ["nest-bun", "bun"],
  "node-node": ["nest-node", "node"],
  "node-bun": ["nest-node", "bun"],
  "fastify-bun": ["nest-fastify", "bun"],
  "express-bun": ["nest-express", "bun"],
  "raw-bun": ["bun", "bun"],
};

/** A target of Nest's benchmark: a framework (`nest-*` for a Nest adapter) on a runtime */
export function nestTargetLabel(framework, runtime) {
  const on = `on ${RUNTIMES[runtime] ?? runtime}`;
  if (ADAPTERS[framework]) return `${ADAPTERS[framework]} ${on}`;
  if (SERVERS[framework]) return `${SERVERS[framework]} ${on} (no Nest)`;
  return `${framework} ${on}`;
}

/** Whether a framework of Nest's benchmark is a Nest adapter */
export function isNestAdapter(framework) {
  return framework in ADAPTERS;
}

/** The adapter's name alone, as `platform-node` */
export function adapterName(framework) {
  return ADAPTERS[framework] ?? framework;
}

/** The framework of the server a Nest adapter runs on: `node` for `nest-node` */
export function serverOf(framework) {
  return framework.replace(/^nest-/, "");
}

/** A server without Nest, as `node:http on Node` */
export function serverLabel(framework, runtime) {
  return `${SERVERS[framework] ?? framework} on ${RUNTIMES[runtime] ?? runtime}`;
}

/** Where a target of Nest's benchmark comes in the reports; unknown ones last */
export function nestTargetRank(framework, runtime) {
  const rank = ORDER.indexOf(`${framework}@${runtime}`);
  return rank === -1 ? ORDER.length : rank;
}

/** A target of the controllers benchmark (`bun`, `node-node`, `raw-bun`...) */
export function controllersTargetLabel(target) {
  const known = CONTROLLERS[target];
  return known ? nestTargetLabel(...known) : target;
}

/** Whether a target of the controllers benchmark is a Nest adapter */
export function isControllersAdapter(target) {
  const known = CONTROLLERS[target];
  return known !== undefined && isNestAdapter(known[0]);
}

/** Where a target of the controllers benchmark comes in the reports */
export function controllersTargetRank(target) {
  const known = CONTROLLERS[target];
  return known ? nestTargetRank(...known) : ORDER.length;
}
