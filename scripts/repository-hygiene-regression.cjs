const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const assert = (condition, message) => {
  if (!condition) throw new Error(`Repository hygiene regression failed: ${message}`);
};

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);

const forbiddenPatterns = [
  /^\.codex-/,
  /^\.codex-backups\//,
  /^\.agents\//,
  /^\.p29\//,
  /^nexus-phase1-final\//,
  /^dev-server\.(?:out|err)\.log$/,
  /(^|\/)__pycache__\//,
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
];
const forbidden = tracked.filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
assert(
  !forbidden.length,
  `internal worktrees, caches, logs, or build artifacts are tracked: ${forbidden.slice(0, 12).join(", ")}`,
);

const stagedRows = execFileSync("git", ["ls-files", "--stage", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const gitlinks = stagedRows
  .filter((row) => row.startsWith("160000 "))
  .map((row) => row.split("\t").slice(1).join("\t"));
assert(!gitlinks.length, `unexpected Git submodule entries are tracked: ${gitlinks.join(", ")}`);

const overlong = tracked.filter((file) => file.length > 220);
assert(!overlong.length, `tracked paths exceed the cross-platform safety limit: ${overlong.slice(0, 5).join(", ")}`);

const ignoreFile = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
for (const rule of [
  "/.codex-*",
  "/.codex-backups/",
  "/.agents/",
  "/.p29/",
  "/nexus-phase1-final/",
  "/dev-server.out.log",
  "/dev-server.err.log",
]) {
  assert(ignoreFile.includes(rule), `.gitignore is missing ${rule}`);
}

console.log(JSON.stringify({
  tracked_files: tracked.length,
  forbidden_files: forbidden.length,
  gitlinks: gitlinks.length,
  overlong_paths: overlong.length,
  passed: true,
}));
