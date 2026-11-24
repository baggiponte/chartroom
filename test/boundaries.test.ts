// Some checks run only when the files they cover change. These tests fail when a module starts depending on a file
// outside that list, so the list can't silently go stale: either the dependency is a leak to undo, or the list grows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every repo file `file` reaches through relative runtime imports (not `import type`), itself included. */
function closure(file: string, seen = new Set<string>()): Set<string> {
  seen.add(file);
  const source = readFileSync(join(ROOT, file), "utf8");
  for (const [, spec] of source.matchAll(
    /^(?:import(?!\s+type\b)[^;]*?from\s*|import\s*\(?\s*|export[^;]*?from\s*)["'](\.{1,2}\/[^"']+)["']/gm,
  )) {
    const next = normalize(join(dirname(file), spec ?? ""));
    if (!seen.has(next)) {
      closure(next, seen);
    }
  }
  return seen;
}

/** The `paths` filter of a workflow's pull_request trigger. */
function prPaths(workflow: string): Array<string> {
  const yaml = readFileSync(join(ROOT, ".github/workflows", workflow), "utf8");
  const block = /^ {2}pull_request:\n {4}paths:\n((?: {6}- .+\n)+)/m.exec(yaml)?.[1];
  assert.ok(block, `${workflow} has no pull_request paths filter`);
  return block.split("\n").flatMap(line => (line.trim() ? [line.trim().slice(2)] : []));
}

test("the harness CLI workflow runs whenever providers.ts or anything it imports changes", () => {
  const paths = prPaths("harnesses.yaml");
  const watched = (file: string): boolean =>
    paths.some(p => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : file === p));
  const missing = [...closure("skills/chartroom/providers.ts")].filter(f => !watched(relative(".", f)));
  assert.deepEqual(missing, [], "add these to the paths of harnesses.yaml, or drop the import");
});
