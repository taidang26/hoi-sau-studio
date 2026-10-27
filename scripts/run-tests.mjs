// Runs dist/*.test.js of the current package. npm on Windows does not expand
// globs and Node 20 does not either, so the list is built here.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync("dist").filter((f) => f.endsWith(".test.js")).map((f) => join("dist", f));
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
