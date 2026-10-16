#!/usr/bin/env node
/**
 * Prepare `packages/alchemy` for publication to GitHub Packages.
 *
 * The package is an internal monorepo member: its name is unscoped (GitHub
 * Packages requires the repository owner's scope) and its dependencies are
 * `workspace:*` / `catalog:` references that a consumer's package manager
 * cannot resolve. Both are rewritten here, in the publish step only, so the
 * checked-in manifest stays upstream-compatible.
 *
 * Every rewritten dependency must exist on the public npm registry; the script
 * fails loudly if one does not, rather than publishing an uninstallable
 * package.
 *
 * Usage: node scripts/rewrite-workspace-deps.mjs <version>
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SCOPE = "@flatfilers";
const NAME = `${SCOPE}/alchemy`;
const INTERNAL_REF = /^(workspace:|catalog:|link:|file:)/;

const version = process.argv[2];
if (!version) {
  console.error("usage: rewrite-workspace-deps.mjs <version>");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

const publishedVersion = (name) => {
  try {
    const out = execFileSync("npm", ["view", name, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.split("\n").pop();
  } catch {
    return undefined;
  }
};

const rewritten = [];
const unresolved = [];

for (const field of ["dependencies", "peerDependencies"]) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, range] of Object.entries(deps)) {
    if (!INTERNAL_REF.test(range)) continue;
    // Peer deps stay peers: consumers provide them. Resolve to a caret range
    // on the published version so installs resolve.
    const resolved = publishedVersion(name);
    if (resolved === undefined) {
      unresolved.push(`${name} (${field})`);
      continue;
    }
    deps[name] = `^${resolved}`;
    rewritten.push(`${name}: ${range} -> ^${resolved} (${field})`);
  }
}

if (unresolved.length > 0) {
  console.error(
    `Cannot publish: ${unresolved.length} internal dependency(ies) are not on the public registry:\n  ${unresolved.join("\n  ")}`,
  );
  process.exit(1);
}

pkg.name = NAME;
pkg.version = version;
pkg.private = false;

writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

console.log(`Publishing ${NAME}@${version}`);
console.log(`Rewrote ${rewritten.length} internal dependency reference(s):`);
for (const line of rewritten) console.log(`  ${line}`);
