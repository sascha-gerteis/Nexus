const fs = require("node:fs");
const path = require("node:path");

const [patchFile, relativePath] = process.argv.slice(2);
if (!patchFile || !relativePath) {
  throw new Error("Usage: node apply-exact-diff.cjs <patch-file> <relative-path>");
}

const normalizedPath = relativePath.replaceAll("\\", "/");
const patch = fs.readFileSync(path.resolve(patchFile), "utf8").replaceAll("\r\n", "\n");
const marker = `diff --git a/${normalizedPath} b/${normalizedPath}`;
const start = patch.indexOf(marker);
if (start < 0) throw new Error(`Patch does not contain ${normalizedPath}`);
const next = patch.indexOf("\ndiff --git ", start + marker.length);
const section = patch.slice(start, next < 0 ? patch.length : next);
const lines = section.split("\n");
const hunks = [];

for (let index = 0; index < lines.length; index += 1) {
  if (!lines[index].startsWith("@@")) continue;
  const hunk = [];
  for (index += 1; index < lines.length && !lines[index].startsWith("@@"); index += 1) {
    hunk.push(lines[index]);
  }
  index -= 1;
  hunks.push(hunk);
}

const targetPath = path.resolve(relativePath);
let source = fs.readFileSync(targetPath, "utf8").replaceAll("\r\n", "\n");

for (const [hunkIndex, hunk] of hunks.entries()) {
  const oldText = hunk
    .filter((line) => line.startsWith(" ") || line.startsWith("-"))
    .map((line) => line.slice(1))
    .join("\n");
  const newText = hunk
    .filter((line) => line.startsWith(" ") || line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
  const first = source.indexOf(oldText);
  const second = first < 0 ? -1 : source.indexOf(oldText, first + oldText.length);
  if (first < 0) throw new Error(`Hunk ${hunkIndex + 1} did not match ${normalizedPath}`);
  if (second >= 0) throw new Error(`Hunk ${hunkIndex + 1} matched more than once in ${normalizedPath}`);
  source = `${source.slice(0, first)}${newText}${source.slice(first + oldText.length)}`;
}

fs.writeFileSync(targetPath, source, "utf8");
console.log(`Applied ${hunks.length} exact hunks to ${normalizedPath}`);
