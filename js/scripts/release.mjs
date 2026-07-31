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

// Semver precedence, enough for the forms this script accepts. A prerelease sorts
// below the release it precedes, and numeric identifiers compare numerically.
function comparePrerelease(a, b) {
  if (a === b) return 0;
  if (!a) return 1; // 1.0.0 > 1.0.0-RC.1
  if (!b) return -1;
  const left = a.split(".");
  const right = b.split(".");
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i];
    const r = right[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (lNum !== rNum) {
      return lNum ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

function compareSemver(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(v);
    return m
      ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? "" }
      : null;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) {
      return left.parts[i] < right.parts[i] ? -1 : 1;
    }
  }
  return comparePrerelease(left.pre, right.pre);
}

const allowDowngrade = process.argv.includes("--allow-downgrade");
const ordering = compareSemver(version, pkg.version);

if (ordering !== null && ordering <= 0 && !allowDowngrade) {
  const relation = ordering === 0 ? "already at" : "ahead of";
  console.error(
    `${pkg.name} is ${relation} ${pkg.version}, so ${version} would not be an ` +
      `increase.\nPick a higher version, or pass --allow-downgrade if you are ` +
      `deliberately renumbering the package.`
  );
  process.exit(1);
}

if (allowDowngrade && ordering !== null && ordering <= 0) {
  console.warn(
    `Renumbering ${pkg.name} from ${pkg.version} down to ${version}. ` +
      `Anything depending on ^${pkg.version} will not resolve this.`
  );
}

pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Absolute path: git accepts it, and it does not depend on where this was invoked.
execSync(`git add ${JSON.stringify(pkgPath)}`, { stdio: "inherit" });
execSync(`git commit -m ${JSON.stringify(`Release ${tag}`)}`, {
  stdio: "inherit",
});
execSync(`git tag ${JSON.stringify(tag)}`, { stdio: "inherit" });

const isPrerelease = version.includes("-");

console.log(`\nTagged ${tag}.`);
console.log("Push the tag to trigger the publish workflow:");
console.log(`  git push origin ${JSON.stringify(tag)}`);
console.log(
  "\nPushing the tag is enough — it carries the commit. Do not use " +
    "`git push --tags`, which would also try to move older package tags."
);
if (isPrerelease) {
  console.log(
    `\n${version} is a prerelease: it publishes from any branch, under the ` +
      `'next' dist-tag, leaving 'latest' on the last stable release.`
  );
} else {
  console.log(
    `\n${version} is a stable version: publishing requires this commit to be ` +
      `reachable from origin/master.`
  );
}
