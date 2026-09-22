import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

test("Pi package manifest exposes the execution progress extension", () => {
  assert.equal(manifest.name, "pi-execution-progress");
  assert.equal(manifest.version, "0.1.0");
  assert.deepEqual(manifest.pi, {
    extensions: ["./extensions/execution-progress.ts"],
  });
  assert.ok(existsSync(resolve(packageRoot, manifest.pi.extensions[0])));
});

test("Pi core modules remain peer dependencies", () => {
  for (const dependency of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies[dependency], "*");
  }
  assert.equal(manifest.dependencies, undefined);
});
