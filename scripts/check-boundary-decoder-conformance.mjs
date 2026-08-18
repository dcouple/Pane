import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = join(root, "node_modules", ".bin", process.platform === "win32" ? "oxlint.cmd" : "oxlint");
const config = join(root, ".oxlintrc.json");
const primitives = [
  join(root, "shared", "validation", "boundaryDecoder.ts"),
  join(root, "packages", "runpane", "src", "boundaryDecoder.ts"),
];

execFileSync(oxlint, ["--config", config, "--deny-warnings", ...primitives], {
  cwd: root,
  stdio: "pipe",
});

const fixtureDirectory = mkdtempSync(join(root, "shared", "validation", ".boundary-conformance-"));
const fixture = join(fixtureDirectory, "downstream.ts");

try {
  writeFileSync(
    fixture,
    [
      "type UnsafeValues = { [key: string]: unknown };",
      "export function leak(value: unknown): UnsafeValues {",
      "  return typeof value === 'object' && value !== null ? {} : {};",
      "}",
    ].join("\n"),
  );
  const result = spawnSync(oxlint, ["--config", config, "--deny-warnings", fixture], {
    cwd: root,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  const expectedRules = [
    "no-runtime-typeof",
    "no-unknown-parameters",
    "no-unsafe-dictionary-type",
  ];
  if (result.status === 0 || expectedRules.some((rule) => !output.includes(rule))) {
    throw new Error(`Boundary decoder conformance probe did not report all expected rules:\n${output}`);
  }
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("Boundary decoder lint conformance checks passed");
