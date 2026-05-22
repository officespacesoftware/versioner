#!/usr/bin/env node
// Bump a workspace package's version, commit, and tag as `<name>@<version>`.
// The matching push of the tag triggers .github/workflows/publish-js.yml.
//
// Usage (from js/):
//   pnpm release <package-dir> <version>
// Example:
//   pnpm release release-management-core 1.1.0

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , dir, version] = process.argv;
if (!dir || !version) {
  console.error("Usage: release.mjs <package-dir> <version>");
  console.error("Example: release.mjs release-management-core 1.1.0");
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(
    `Refusing to tag with non-semver value: ${version}\n` +
      "Expected formats: 1.2.3, 1.2.3-RC.1, 0.4.0-beta.0"
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const jsRoot = resolve(__dirname, "..");
const pkgPath = join(jsRoot, "packages", dir, "package.json");

if (!existsSync(pkgPath)) {
  console.error(`No package.json at ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const tag = `${pkg.name}@${version}`;

if (pkg.version === version) {
  console.error(
    `${pkg.name} is already at ${version}. Pick a higher version.`
  );
  process.exit(1);
}

pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const relPath = pkgPath.replace(`${process.cwd()}/`, "");
execSync(`git add ${JSON.stringify(relPath)}`, { stdio: "inherit" });
execSync(`git commit -m ${JSON.stringify(`Release ${tag}`)}`, {
  stdio: "inherit",
});
execSync(`git tag ${JSON.stringify(tag)}`, { stdio: "inherit" });

const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
  encoding: "utf8",
}).trim();

console.log(`\nTagged ${tag}.`);
console.log("Push to trigger the publish workflow:");
console.log(
  `  git push origin ${currentBranch} && git push origin ${JSON.stringify(tag)}`
);
