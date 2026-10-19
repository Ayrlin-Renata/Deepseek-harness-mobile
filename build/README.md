# dsh-mobile rebuild pipeline

This fork no longer hand-builds on one machine: every tarball in `install/` is
regenerated from **stock upstream packages at 0.2.1-alpha.5** plus a small
per-package patch in `build/patches/`. The next DSH port is: rebase the patches,
run the build, commit.

## Workflow

1. Edit `build/patches/<name>.patch` (standard `git diff -p1` format, paths
   relative to the package root, i.e. `a/package/...`).
2. Run the build:

   ```
   node build/build.js                      # all 11 packages -> install/
   node build/build.js --only fs-local      # just one
   node build/build.js --check-only         # verify install/ matches a fresh build
   node build/build.js --force              # rewrite even when byte-identical
   ```

3. The script prints one PASS/SKIP/FAIL line per package plus a summary; exit
   code 0 only when nothing FAILED. Commit the patches together with the
   rebuilt `install/*.tgz`.

Stock tarballs are fetched with `npm pack @deepseek-ai/dsh-<name>@0.2.1-alpha.5`
into `build/cache/` (git-ignored, re-fetchable) and reused on cache hits.

## What build.js enforces per package

- the patch applies cleanly to the pristine stock tarball
  (`git apply`, with a documented `git apply -3` fallback); packages declared
  `stock: true` in `PACKAGES` (currently `client-ui-layout` — the MobileFrame
  shell was retired 2026-10-19) ship byte-for-byte upstream with **no patch
  file**;
- `package.json` version is exactly `0.2.1-alpha.5`;
- native addons sit in `optionalDependencies`, never `dependencies`
  (sharp / koffi / node-pty / @deepseek-ai/dsh-sandbox-windows-acl);
- patch markers are greppable in the built files (hard-link fallbacks,
  listing-timeout fields, Android sandbox messaging, …); markers may declare
  `absent: true` to prove a retired feature stays gone (MobileFrame symbols
  in `client-ui-layout`);
- every `.js/.mjs/.cjs` file parses (`node --check`);
- the repacked tarball re-extracts and still passes version + optionalDeps
  checks (smoke test).

Two build.js quirks worth knowing (fixed during the 0.2.1-alpha.5 port):

- `git apply -C <subdir>` inside a work tree silently *skips* every hunk with
  exit 0 (paths resolve from the tree toplevel). build.js therefore runs from
  the enclosing toplevel with `--directory=<subdir>`.
- On Windows `npm` is a `.cmd` shim; Node refuses to spawn it without a shell
  (ENOENT/EINVAL). build.js routes spawns through `cmd.exe` with quoting.

## The 11 packages (0.2.1-alpha.5)

| package | what the patch does (why) |
| --- | --- |
| attachment-local | `link()` → `copyFile(COPYFILE_EXCL)` fallback (FUSE/sdcardfs forbid hard links); sharp → optionalDependencies (glibc prebuilds must not fail Termux installs) |
| fs-local | same hard-link fallback in writeFileAtomic; koffi optional |
| host-directory-picker-browse | listing deadline + windowed listing (Termux sdcardfs listings can hang) |
| host-directory-picker-native | manifest only: koffi optional |
| sandbox | `SandboxUnavailableError` 3rd platform arg + "Android has no sandbox backend" messaging |
| sandbox-local | windows-acl optional + lazy require + platform arg threading |
| session-persistence-jsonl | `link()` → `rename()` fallback + koffi optional |
| subprocess-local | android uses LinuxProcessInspector; ensure-spawn-helper import.meta.resolve guarded; node-pty optional |
| terminal-bash | resolveShellPath on android → `$PREFIX/bin/bash` (Termux has no /bin/bash) |
| client-ui-layout | MobileFrame: mobile single-column shell ≤767px (top bar, sidebar + rightbar drawers, CSS-module classes) transplanted onto alpha5's rewritten AppFrame |
| client-ui-directory-picker-browse | retry affordance for failed listings (failedTarget + retry button + `browser.retry` strings) |

## Deliberate decisions

- **client-modules dropped** (12th former package): its only fork delta was
  immutable cache-control for served plugin bundles; stock 0.2.1-alpha.5 is
  byte-equivalent upstream (`IMMUTABLE_CACHE`), so the CLI's exact pin installs
  the stock package. No patch, no tarball.
- **@deepseek-ai/dsh-workflow-worker-thread**: 404 at 0.2.1-alpha.5 (the
  package's own train is 0.1.5-alpha.2). Upstream `@deepseek-ai/dsh@0.2.1-alpha.5`
  does not reference it at all — `install.sh` asserts that stays true.
- **client-ui-layout adaptations for alpha5's rewrite**: details → rightbar
  store semantics (`openRightbar/closeRightbar/rightbarShown`), mobile CSS
  classes re-hashed to alpha5's `pI_x6G_` prefix, `MOBILE_BREAKPOINT = 767`
  constant introduced, `DocumentTitle` kept mounted inside the mobile tree, and
  the `layout` locale namespace registered in `apply()` (bound at module scope
  — the root-slot locale binding stays `common` upstream). The details button
  is not session-gated (alpha5's rightbar occupancy is not observable from the
  frame).
- **dpb markers corrected**: the old draft expected
  `LIST_TIMEOUT_CODE`/`MobileDirectoryBrowser` in this package; those live in
  host-directory-picker-browse (timeout) while MobileDirectoryBrowser never
  existed in the fork. The real fork delta here is the retry UI, and the
  markers now pin that.
