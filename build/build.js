#!/usr/bin/env node
"use strict";
/**
 * dsh-mobile rebuild pipeline
 * ===========================
 * Rebuilds this fork's patched Android/Termux tarballs from the STOCK upstream
 * packages at TARGET_VERSION, so the next DSH port is one commit:
 *
 *   stock tarball (npm pack @deepseek-ai/dsh-<name>@<TARGET>)
 *     -> extract            (build/patches/<name>.patch applied with git apply)
 *     -> verify             (version, optionalDependencies, patch markers, node --check)
 *     -> npm pack           (byte-reproducible; npm pins tarball mtimes)
 *     -> install/<deepseek-ai-dsh-<name>-<TARGET>.tgz>
 *
 * Usage:
 *   node build/build.js [options]
 *
 * Options:
 *   --cache <dir>    where stock tarballs live / are fetched into
 *                    (default build/cache; a hit skips the registry fetch)
 *   --out <dir>      output directory for rebuilt tarballs (default <repo>/install)
 *   --work <dir>     scratch directory (default build/work; wiped per package)
 *   --only <a,b>     build only the named packages
 *   --force          rewrite output tarballs even when byte-identical (SKIP -> PASS)
 *   --check-only     build + verify but never write; FAIL on any drift vs <out>
 *
 * Results: one line per package (PASS / SKIP / FAIL) and a summary table.
 * Exit code: 0 only when no package FAILED (in --check-only mode, "identical"
 * counts as PASS and any drift as FAIL).
 *
 * Patch application: `git apply` (plain). If a patch ever fails to apply
 * cleanly, the script retries once with `git apply --3way` after committing the
 * pristine tree, which reports conflicts as usual — but with patches generated
 * from the exact stock tree below, plain apply is expected to succeed. A FAIL
 * therefore always means a real upstream change, not tooling noise.
 *
 * The 12th former package (client-modules) is deliberately absent: its only
 * fork delta (immutable cache-control for served plugin bundles) is
 * byte-equivalent in stock 0.2.1-alpha.5 (`IMMUTABLE_CACHE`), so the exact pin
 * in @deepseek-ai/dsh installs the stock package. See build/README.md.
 */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const TARGET_VERSION = "0.2.1-alpha.5";
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Per-package build expectations.
 *   optionalDeps: native addons that MUST sit in optionalDependencies and MUST
 *                 NOT sit in dependencies (the Termux "no native prebuild"
 *                 pattern).
 *   markers:      substrings that MUST be present after patching
 *                 ({ absent: true } inverts the check).
 */
const PACKAGES = [
  {
    name: "attachment-local",
    optionalDeps: ["sharp"],
    markers: [
      { file: "lib/index.js", text: "isHardLinkUnsupported" },
      { file: "lib/index.js", text: "COPYFILE_EXCL" },
    ],
  },
  {
    name: "client-ui-directory-picker-browse",
    optionalDeps: [],
    // The fork delta for this package is a retry affordance for failed
    // directory listings (failedTarget ref + retryListing + error-row button +
    // browser.retry locale strings). NOTE: LIST_TIMEOUT_CODE / listTimeoutMs
    // live in host-directory-picker-browse (see its patch), not here — the
    // earlier marker draft was mistaken about which package carries them.
    markers: [
      { file: "lib/client.js", text: "retryListing" },
      { file: "lib/client.js", text: 't("browser.retry")' },
      { file: "lib/client.js", text: "errorRow" },
    ],
  },
  {
    name: "client-ui-layout",
    optionalDeps: [],
    markers: [
      { file: "lib/client.js", text: "MobileFrame" },
      { file: "lib/client.js", text: "MOBILE_BREAKPOINT" },
      { file: "lib/types/client/MobileFrame.d.ts", text: "MobileFrame" },
    ],
  },
  {
    name: "fs-local",
    optionalDeps: ["koffi"],
    markers: [
      { file: "lib/index.js", text: "isHardLinkUnsupported" },
      { file: "lib/index.js", text: "COPYFILE_EXCL" },
    ],
  },
  {
    name: "host-directory-picker-browse",
    optionalDeps: [],
    markers: [
      { file: "lib/index.js", text: "listTimeoutMs" },
      { file: "lib/types/index.d.ts", text: "listTimeoutMs" },
    ],
  },
  {
    name: "host-directory-picker-native",
    optionalDeps: ["koffi"],
    markers: [],
  },
  {
    name: "sandbox",
    optionalDeps: [],
    markers: [
      { file: "lib/index.js", text: 'platform === "android"' },
      { file: "lib/index.js", text: "Android has no sandbox backend" },
      { file: "lib/types/index.d.ts", text: "platform?: NodeJS.Platform" },
    ],
  },
  {
    name: "sandbox-local",
    optionalDeps: ["@deepseek-ai/dsh-sandbox-windows-acl"],
    markers: [
      { file: "lib/index.js", text: "loadWindowsAcl" },
      { file: "lib/index.js", text: "void 0, this.internals.platform ?? process.platform" },
      { file: "lib/types/index.d.ts", text: "windowsAclModule" },
    ],
  },
  {
    name: "session-persistence-jsonl",
    optionalDeps: ["koffi"],
    markers: [
      { file: "lib/index.js", text: "isHardLinkUnsupported" },
      { file: "lib/index.js", text: "await rename(tmp, finalPath)" },
    ],
  },
  {
    name: "subprocess-local",
    optionalDeps: ["node-pty", "koffi"],
    markers: [
      { file: "lib/runner-launch-B2zsQ1Dz.js", text: 'platform === "linux" || platform === "android"' },
      { file: "scripts/ensure-spawn-helper.mjs", text: "let entry" },
      { file: "scripts/ensure-spawn-helper.mjs", text: "process.exit(0)" },
      { file: "scripts/ensure-spawn-helper.mjs", text: "const entry = fileURLToPath", absent: true, note: "eager top-level node-pty resolve removed" },
    ],
  },
  {
    name: "terminal-bash",
    optionalDeps: [],
    markers: [
      { file: "lib/index.js", text: "function resolveShellPath" },
      { file: "lib/index.js", text: 'shellPath === "/bin/bash"' },
      { file: "lib/index.js", text: 'PROMPT_COMMAND: `printf', absent: true, note: "PS1= suffix removed from PROMPT_COMMAND" },
      { file: "lib/types/config.d.ts", text: "resolveShellPath" },
    ],
  },
];

// --- small helpers -----------------------------------------------------------

function die(message) {
  process.stderr.write(`build.js: ${message}\n`);
  process.exit(2);
}

function run(cmd, args, opts = {}) {
  const execOpts = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts };
  if (process.platform === "win32" && !execOpts.shell) {
    // npm/npx are .cmd shims on Windows: spawn without a shell fails with
    // ENOENT (no PATHEXT resolution) or EINVAL (Node refuses .cmd spawns
    // without shell, CVE-2024-27980). Route everything through cmd.exe and
    // quote any arg containing whitespace so cmd.exe re-splits identically.
    execOpts.shell = true;
    args = args.map((a) => (/[\s"^&|<>%]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
  }
  return execFileSync(cmd, args, execOpts);
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, out: run(cmd, args, opts) };
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return { ok: false, out: out || String(error.message) };
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

// --- pipeline steps ----------------------------------------------------------

function ensureStockTarball(pkg, cacheDir) {
  const fileName = `deepseek-ai-dsh-${pkg.name}-${TARGET_VERSION}.tgz`;
  const cached = path.join(cacheDir, fileName);
  if (fs.existsSync(cached)) return { file: cached, fromCache: true };
  fs.mkdirSync(cacheDir, { recursive: true });
  const scoped = `@deepseek-ai/dsh-${pkg.name}@${TARGET_VERSION}`;
  try {
    run("npm", ["pack", scoped, "--pack-destination", cacheDir, "--json", "--silent"]);
  } catch (error) {
    throw new Error(`npm pack ${scoped} failed: ${`${error.stderr ?? ""}`.trim().slice(-400)}`);
  }
  if (!fs.existsSync(cached)) throw new Error(`npm pack ${scoped} did not produce ${fileName}`);
  return { file: cached, fromCache: false };
}

function extractStock(tgz, extractDir) {
  rmrf(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", tgz, "-C", extractDir]);
  const pkgDir = path.join(extractDir, "package");
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) throw new Error(`extraction of ${tgz} produced no package/package.json`);
  return pkgDir;
}

function applyPatch(pkg, pkgDir, extractDir, patchFile) {
  if (!fs.existsSync(patchFile)) throw new Error(`missing patch ${patchFile}`);
  // Inside a work tree, `git apply -C <subdir>` silently skips every hunk
  // ("Skipped patch", exit 0) because it resolves patch paths from the tree
  // TOPOLEVEL, not the -C directory. Run from the toplevel with
  // --directory=<subdir> instead; outside any work tree, -C works as-is.
  let cwdArgs = ["-C", extractDir];
  let applyExtra = [];
  const top = tryRun("git", ["-C", extractDir, "rev-parse", "--show-toplevel"]);
  if (top.ok && top.out.trim()) {
    const toplevel = top.out.trim();
    const rel = path.relative(toplevel, extractDir).split(path.sep).join("/");
    cwdArgs = ["-C", toplevel];
    if (rel) applyExtra = [`--directory=${rel}`];
  }
  const base = [...cwdArgs, "-c", "core.autocrlf=false"];
  const check = tryRun("git", [...base, "apply", ...applyExtra, "--check", "-p1", patchFile]);
  if (check.ok) {
    const applied = tryRun("git", [...base, "apply", ...applyExtra, "-p1", patchFile]);
    if (applied.ok) return "git-apply";
    throw new Error(`git apply failed after --check passed:\n${applied.out.slice(0, 600)}`);
  }
  // Documented fallback: 3-way merge. The pristine tree is committed first so
  // the preimage blobs exist locally; conflicts surface as usual. These steps
  // always run INSIDE extractDir (its own freshly-init'ed repo), never at the
  // enclosing work-tree toplevel computed above.
  const localBase = ["-C", extractDir, "-c", "core.autocrlf=false"];
  for (const step of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=build@localhost", "-c", "user.name=dsh-mobile-build", "commit", "-qm", "stock base"],
  ]) {
    const r = tryRun("git", [...localBase, ...step]);
    if (!r.ok) throw new Error(`git ${step.join(" ")} failed (3way fallback):\n${r.out.slice(0, 400)}`);
  }
  // extractDir is now its own toplevel, so a plain -C apply resolves paths
  // correctly here.
  const three = tryRun("git", [...localBase, "apply", "-3", "-p1", patchFile]);
  if (three.ok) return "git-apply-3way";
  const conflicts = [...walkFiles(pkgDir)].filter((f) => {
    try {
      return fs.readFileSync(f, "utf8").includes("<<<<<<<");
    } catch {
      return false;
    }
  });
  throw new Error(
    `patch does not apply (plain or 3-way)${conflicts.length ? `; conflict markers in:\n  ${conflicts.map((f) => path.relative(pkgDir, f)).join("\n  ")}` : ""}\n${three.out.slice(0, 600)}`
  );
}

function checkVersion(pkgDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  if (manifest.version !== TARGET_VERSION) throw new Error(`package.json version ${manifest.version} != ${TARGET_VERSION}`);
  return manifest;
}

function checkOptionalDeps(pkg, manifest) {
  const deps = manifest.dependencies ?? {};
  const optional = manifest.optionalDependencies ?? {};
  for (const addon of pkg.optionalDeps) {
    if (addon in deps) throw new Error(`${addon} is still a hard dependency (must move to optionalDependencies)`);
    if (!(addon in optional)) throw new Error(`${addon} missing from optionalDependencies`);
  }
}

function checkMarkers(pkg, pkgDir) {
  for (const marker of pkg.markers) {
    const file = path.join(pkgDir, marker.file);
    if (!fs.existsSync(file)) throw new Error(`marker file missing: ${marker.file}`);
    const present = fs.readFileSync(file, "utf8").includes(marker.text);
    if (marker.absent ? present : !present) {
      throw new Error(`marker ${marker.absent ? "should be absent" : "missing"} in ${marker.file}: ${JSON.stringify(marker.text)}${marker.note ? ` (${marker.note})` : ""}`);
    }
  }
}

function checkSyntax(pkgDir) {
  const targets = [...walkFiles(pkgDir)].filter((f) => /\.(js|mjs|cjs)$/.test(f));
  for (const file of targets) {
    // All packages are type:module, so `node --check` parses .js as ESM and
    // .cjs as CommonJS — the same classification the runtime uses.
    const r = tryRun("node", ["--check", file]);
    if (!r.ok) throw new Error(`node --check failed for ${path.relative(pkgDir, file)}:\n${r.out.slice(0, 400)}`);
  }
  return targets.length;
}

function packPatched(pkg, pkgDir, workDir) {
  const outDir = path.join(workDir, "packed");
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  run("npm", ["pack", pkgDir, "--pack-destination", outDir, "--silent"]);
  const packed = fs.readdirSync(outDir).filter((f) => f.endsWith(".tgz"));
  if (packed.length !== 1) throw new Error(`expected exactly one tarball in ${outDir}, found: ${packed.join(", ")}`);
  const expected = `deepseek-ai-dsh-${pkg.name}-${TARGET_VERSION}.tgz`;
  if (packed[0] !== expected) throw new Error(`packed tarball ${packed[0]} != expected ${expected}`);
  return path.join(outDir, packed[0]);
}

function smokeExtract(tarball, workDir, pkg) {
  const smokeDir = path.join(workDir, "smoke");
  rmrf(smokeDir);
  fs.mkdirSync(smokeDir, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", smokeDir]);
  const pkgDir = path.join(smokeDir, "package");
  const manifest = checkVersion(pkgDir);
  checkOptionalDeps(pkg, manifest);
  const files = [...walkFiles(pkgDir)].length;
  if (files < 3) throw new Error(`re-extracted tarball looks empty (${files} files)`);
  return files;
}

// --- driver ------------------------------------------------------------------

function buildOne(pkg, options) {
  const patchFile = path.join(REPO_ROOT, "build", "patches", `${pkg.name}.patch`);
  const workDir = path.join(options.workDir, pkg.name);
  rmrf(workDir);
  fs.mkdirSync(workDir, { recursive: true });

  const stock = ensureStockTarball(pkg, options.cacheDir);
  const pkgDir = extractStock(stock.file, path.join(workDir, "extract"));
  const applyMode = applyPatch(pkg, pkgDir, path.join(workDir, "extract"), patchFile);
  const manifest = checkVersion(pkgDir);
  checkOptionalDeps(pkg, manifest);
  checkMarkers(pkg, pkgDir);
  const checked = checkSyntax(pkgDir);
  const tarball = packPatched(pkg, pkgDir, workDir);
  const smokeFiles = smokeExtract(tarball, workDir, pkg);

  const outName = `deepseek-ai-dsh-${pkg.name}-${TARGET_VERSION}.tgz`;
  const outFile = path.join(options.outDir, outName);
  const digest = sha256File(tarball);
  const bytes = fs.statSync(tarball).size;
  const detail = `${applyMode}, ${checked} js checked, ${smokeFiles} files, ${bytes} B, sha256 ${digest.slice(0, 12)}`;

  if (options.checkOnly) {
    if (!fs.existsSync(outFile)) return { status: "FAIL", detail: `check-only: ${outName} missing from ${options.outDir}` };
    if (sha256File(outFile) !== digest) return { status: "FAIL", detail: `check-only: ${outName} drifted from freshly built tarball` };
    return { status: "PASS", detail: `check-only: identical. ${detail}` };
  }
  if (fs.existsSync(outFile) && sha256File(outFile) === digest && !options.force) {
    return { status: "SKIP", detail: `already up to date. ${detail}` };
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  fs.copyFileSync(tarball, outFile);
  return { status: "PASS", detail: `wrote ${outName}. ${detail}` };
}

function parseArgs(argv) {
  const options = {
    cacheDir: path.join(REPO_ROOT, "build", "cache"),
    outDir: path.join(REPO_ROOT, "install"),
    workDir: path.join(REPO_ROOT, "build", "work"),
    only: null,
    force: false,
    checkOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cache") options.cacheDir = path.resolve(argv[++i]);
    else if (arg === "--out") options.outDir = path.resolve(argv[++i]);
    else if (arg === "--work") options.workDir = path.resolve(argv[++i]);
    else if (arg === "--only") options.only = argv[++i].split(",").map((s) => s.trim());
    else if (arg === "--force") options.force = true;
    else if (arg === "--check-only") options.checkOnly = true;
    else die(`unknown argument: ${arg}`);
  }
  if (options.only) {
    const known = new Set(PACKAGES.map((p) => p.name));
    for (const name of options.only) if (!known.has(name)) die(`unknown package in --only: ${name}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const selected = options.only ? PACKAGES.filter((p) => options.only.includes(p.name)) : PACKAGES;
  process.stdout.write(`dsh-mobile rebuild: target ${TARGET_VERSION}, ${selected.length} package(s)\n`);
  process.stdout.write(`  stock cache: ${options.cacheDir}\n  output:      ${options.outDir}\n\n`);

  const results = [];
  for (const pkg of selected) {
    const started = Date.now();
    let result;
    try {
      result = buildOne(pkg, options);
    } catch (error) {
      result = { status: "FAIL", detail: String(error.message ?? error).slice(0, 800) };
    }
    result.ms = Date.now() - started;
    results.push({ name: pkg.name, ...result });
    process.stdout.write(`${result.status.padEnd(5)} ${pkg.name.padEnd(34)} ${result.detail}\n`);
  }

  const counts = { PASS: 0, SKIP: 0, FAIL: 0 };
  for (const r of results) counts[r.status]++;
  process.stdout.write(`\nsummary: ${counts.PASS} pass / ${counts.SKIP} skip / ${counts.FAIL} fail (target ${TARGET_VERSION})\n`);
  if (counts.FAIL > 0) process.exit(1);
}

main();
