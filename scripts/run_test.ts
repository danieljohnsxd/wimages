/**
 * Test runner: hermetic `node --test` over the tests directory glob.
 *
 * ```
 *   pnpm test
 *   pnpm test -- --test-name-pattern foo
 * ```
 *
 * Tokens after a bare `--`, and any other unknown tokens, are forwarded to
 * `node --test` so name patterns and reporters still work.
 */
import { spawnSync } from "node:child_process";

const raw = process.argv.slice(2);
const forwarded: Array<string> = [];
let afterDash = false;
for (const arg of raw) {
  if (afterDash) {
    forwarded.push(arg);
    continue;
  }
  if (arg === "--") {
    afterDash = true;
    continue;
  }
  forwarded.push(arg);
}

const run = spawnSync(process.execPath, ["--test", ...forwarded, "tests/*_test.ts"], {
  stdio: "inherit",
});
process.exit(run.status === null ? 1 : run.status);
