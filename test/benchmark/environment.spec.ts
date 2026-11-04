// How a run's record names the executables it ran: the same on any machine,
// and naming nobody's home directory.
import { expect, test } from "bun:test";
import { portablePath } from "../../benchmark/environment.mjs";

const where = { project: "/home/ann/dev/platform-bun", home: "/home/ann" };

test("a run records an executable's path relative to the project inside it, from ~ inside the home directory, and as given elsewhere", () => {
  expect(
    portablePath("/home/ann/dev/platform-bun/.tools/bun-1.4.4/bun", where),
  ).toBe(".tools/bun-1.4.4/bun");
  expect(
    portablePath("/home/ann/.nvm/versions/node/v26.13.0/bin/node", where),
  ).toBe("~/.nvm/versions/node/v26.13.0/bin/node");
  // A directory whose name only starts with the home directory's is not in it
  expect(portablePath("/home/annex/bin/wrk", where)).toBe(
    "/home/annex/bin/wrk",
  );
  expect(portablePath("/usr/bin/node", where)).toBe("/usr/bin/node");
  // A command looked up on PATH stays that command
  expect(portablePath("node", where)).toBe("node");
});
