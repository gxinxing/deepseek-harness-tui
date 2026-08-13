# deepseek-harness-tui x DeepSeek Harness — Integration Report

Source checkout: `$DSH_HOME_SRC` (verified 2026-08-13)
Installed CLI: `$NPM_GLOBAL_BIN/dsh` = `@deepseek-ai/dsh` 0.1.0-rc.6; pnpm 10.32.1; Node v22.23.1
Profiles on disk: `~/.dsh/profiles/{headless, web, tui}`; `tui` currently holds only `@deepseek-ai/dsh-base` in `dsh.profile.bundles` (no headless yet).
Method: source quotes (file:line) + live `dsh --dump-config` output + one throwaway-profile empirical test (`dsh plugin add` of a scriptless local package; profile removed afterwards).

---

## 1. Patch semantics

**Where the semantics live.** The single implementation is `applyEntryPatches` in the vendored include — `vendor/include/src/index.ts:44-58`:
> "Apply patch lists to an entry list — THE patch semantics of this include, shared by mounting (`applyPatches`) and offline config tooling (`dsh --dump-config`) so a dump can never drift from what boots… Inserted entries are indexed as they are added, so a later patch in the same list can target a row an earlier patch inserted. A patch that matches nothing warns and is skipped."

All layers are flattened into **one** list and applied in **one** call: `apps/cli/src/profile-boot.ts:122-126` (`allPatches` = bundlePatches + profile.patches + homePatches + overlays), passed to `boot()` at `profile-boot.ts:253`, mounted as the root include's `patches` array (`packages/boot/app-boot/src/index.ts:514-521`), applied over the empty root `cordis.yml` (`[]`) by `Include._apply` -> `applyPatches` -> `applyEntryPatches` (`vendor/include/src/index.ts:267-270`). So bundle layers are *not* separate nested trees — later entries in the same flat list can target rows earlier entries inserted.

**(a) `- id: X / disabled: true` from a later bundle works.** For a non-insert patch (`vendor/include/src/index.ts:104-127`):
```ts
const target = entryMap.get(id)
if (!target) { warn('patch: entry %C not found', id); continue }
if (name && name !== target.name) { warn('patch: name mismatch for %C …', id, target.name, name); continue }
for (const [key, value] of Object.entries(overrides)) { target[key] = value }   // disabled: true lands here
```
`entryMap` is rebuilt over the running data and `buildMap(insert)` re-indexes rows the moment an earlier `insert` adds them (`vendor/include/src/index.ts:96-101`: "a layer must be able to configure or disable a row an earlier layer inserted"). Your `headless-startup`/`headless-runner` disables will therefore hit rows inserted by `@deepseek-ai/dsh-headless`'s own `- insert:` (same flattened list). `disabled: true` also survives because `data` is a detached `structuredClone` per call (`:63`).
Empirically verified: a later bundle patch `- id: timer / disabled: true` produced `- id: timer … disabled: true` in `--dump-config`, and `deepseek-harness-tui` rows landed after all base rows.

**(b) A later bundle's `insert` appends after all earlier rows.** `vendor/include/src/index.ts:77-94`: with no `id`, `data.push(...insert)` — appended to the end of the entry list, i.e. after every earlier bundle's rows (activation is service-driven; row order is not load semantics — `packages/bundle/base/cordis.patch.yml:14-16`). With `id` pointing at a group row it pushes into that group's `config` instead (`:82-92`). Inserted rows are indexed immediately (`:96-101`), so the *same* list can later disable them.

**(c) Unmatched target = warning, not error.** `vendor/include/src/index.ts:52` ("A patch that matches nothing warns and is skipped"), `:106-113` (`warn('patch: entry %C not found', id); continue`), and `packages/boot/app-boot/src/index.ts:312-313` ("a single patch whose target row is absent stays a per-entry Loader warning, so one overlay shared across surfaces does not have to match every tree"). The dump path writes warnings to **stderr** by default: `renderConfigDump`'s `warn` sink is `line => void process.stderr.write(line + '\n')` (`app-boot/src/index.ts:383`). Verified live:
```
$ dsh --profile zz-allowbuilds-test --dump-config >/dev/null
dsh: [$DSH_HOME/profiles/zz-allowbuilds-test/cordis.patch.yml] patch: entry "does-not-exist-row" not found   # exit 0
```
Nuance for the **boot** path: the include warns through `this.ctx.root.logger?.('loader').warn(...)` (`vendor/include/src/index.ts:269`). Cordis's default logger exporter only buffers (`vendor/cordis/src/logger.ts:196-210`), and neither `dsh-base` nor `dsh-headless` mounts `@deepseek-ai/cordis-plugin-logger-console`, so a boot-time unmatched patch may be invisible unless a console exporter is registered. The stderr claim in the reference doc is exactly true for `--dump-config`; at boot it is "a warning routed to the Cordis logger" (buffered by default).

VERDICT: disabled works from a later bundle; insert appends after all earlier rows; unmatched targets are warnings (stderr in the dump path, Cordis-logger in the boot path) — the planned `dsh.bundle.patch` shape is supported as written.

---

## 2. Profile manifest & bundle resolution

**Ordering.** `loadProfile` reads `manifest.dsh?.profile?.bundles ?? []` and maps each entry in order to its patch layer — `packages/boot/app-boot/src/profile.ts:371-409`:
```ts
const bundles = manifest.dsh?.profile?.bundles ?? []
const layers = bundles.map((packageName): ProfileLayer => {
  const packageDir = resolveBundleDir(binName, packageName, installAnchor, dir)
  const bundleManifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const declared = bundleManifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error(`…profile bundle … declares no dsh.bundle…`)
  …
  patches: loadOverlayPatches(binName, patchPath)
})
```
A bundle-listed package **without** `dsh.bundle.patch` fails loud — naming a bundle-less package as a layer is a misconfiguration.

**In-box bundle resolution (installation first).** `resolveBundleDir` (`profile.ts:344-361`):
```ts
for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
  const dir = packageDirFromAnchor(anchor, packageName)
  if (dir !== undefined) return dir
}
```
with the contract comment: "The installation-first order is the contract that `@deepseek-ai/dsh-base` (and every other in-box bundle) always comes from the same installation as the running dsh, never from a profile-local copy." `installAnchor` = the dsh app's own `package.json` (`apps/cli/src/profile-boot.ts:58-60`), so `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-headless` never need to be installed into the profile. Runtime plugin imports are covered by the flat fallback `$DSH_HOME/profiles/node_modules` — `healProfilesModuleFallback` (`profile.ts:223-290`) symlinks the whole dsh dependency closure there ("so every in-box plugin resolves without pnpm ever managing it"), and it is healed on every `prepareProfile` (`profile-boot.ts:92`). Node's parent-walk from a profile dir finds it after the profile's own `node_modules`.

**`dsh plugin --profile <name> add <spec>`.** `apps/cli/src/plugin.ts:120-158` (`runPlugin`): init the profile if missing (`initProfile` with `PROFILE_TEMPLATES[name] ?? DEFAULT_PROFILE_BUNDLES`, `:124-127`), then a plain pnpm forwarder:
```ts
const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), { cwd: dir, stdio: 'inherit' })
```
then on exit 0: `reconcilePlugins(before, dir)` (`:137-140`). `anchorPathSpec` (`:104-118`) rewrites only relative `.`/`..` specs against the invoking cwd; **an absolute path spec like `$DSH_HOME_SRC-tui` passes through untouched** and pnpm records it as a `link:` dependency. `reconcilePlugins` (`:59-101`) then appends every dependency that resolves to a `dsh.bundle`-declaring package to `dsh.profile.bundles`:
```ts
const isBundle = exportsPatch(packageName, profileDir)   // manifest.dsh?.bundle?.patch !== undefined  (:36-54)
if (isBundle && !plugins.includes(packageName)) { plugins.push(packageName); changed = true }
```
It also warns once for a newly-added bundle-less dependency (`:71-75`) and removes deps that stopped being bundles (`:84-91`).

**Empirically verified** (throwaway profile `zz-allowbuilds-test`, cleaned up): `dsh plugin --profile zz-allowbuilds-test add /tmp/zz-deepseek-harness-tui-scratch (throwaway)` (a `dsh.bundle.patch`-declaring package, no scripts) exited 0; pnpm wrote `"deepseek-harness-tui-scratch": "link:/tmp/zz-deepseek-harness-tui-scratch (throwaway)"` into `dependencies`; `node_modules/deepseek-harness-tui-scratch -> /tmp/zz-deepseek-harness-tui-scratch (throwaway)` symlink; reconcile appended `"deepseek-harness-tui-scratch"` to `bundles` after `@deepseek-ai/dsh-base`; `--dump-config` then showed the composed tree including the bundle's rows (and its `timer` disable).

VERDICT: `dsh.profile.bundles` composes in order; in-box bundles resolve from the dsh installation (never the profile); `dsh plugin --profile tui add $DSH_HOME_SRC-tui` will `link:` it into the profile and reconcile appends `deepseek-harness-tui` to `bundles` (after base, i.e. after headless when headless is listed) because it declares `dsh.bundle.patch`.

---

## 3. Row inventory

Commands run: `dsh --profile headless --dump-config` (81 rows), `dsh --profile web --dump-config` (129 rows), both exit 0 with empty stderr. The dump groups rows under `# == <source>` provenance comments and attributes patches per layer (e.g. `# == @deepseek-ai/dsh-base, patched by $DSH_HOME/profiles/headless/cordis.patch.yml`).

### 3.1 `@deepseek-ai/dsh-base` contributes exactly 78 rows
(`packages/bundle/base/cordis.patch.yml`, one `- insert:`; ids/names extracted from the file):

```
timer = '@deepseek-ai/cordis-plugin-timer'
hmr = '@deepseek-ai/cordis-plugin-hmr'
llm = '@deepseek-ai/dsh-llm'
session = '@deepseek-ai/dsh-session'
typert = '@deepseek-ai/dsh-typert-registry'
typert-loader = '@deepseek-ai/dsh-typert-loader'
typert-gateway = '@deepseek-ai/dsh-api-gateway'
session-title = '@deepseek-ai/dsh-session-title'
session-title-llm = '@deepseek-ai/dsh-session-title-first-prompt-llm'
user-questions = '@deepseek-ai/dsh-user-questions'
agent = '@deepseek-ai/dsh-agent'
agent-default-model = '@deepseek-ai/dsh-agent-default-model'
jobs = '@deepseek-ai/dsh-jobs-local'
llm-retry = '@deepseek-ai/dsh-llm-retry'
settings = '@deepseek-ai/dsh-settings-file'
credentials = '@deepseek-ai/dsh-credentials-local'
llm-pi-ai = '@deepseek-ai/dsh-llm-pi-ai'
session-persistence-jsonl = '@deepseek-ai/dsh-session-persistence-jsonl'
attachment-local = '@deepseek-ai/dsh-attachment-local'
session-query-sqlite = '@deepseek-ai/dsh-session-query-sqlite'
session-projection = '@deepseek-ai/dsh-session-projection'
session-telemetry-otel = '@deepseek-ai/dsh-session-telemetry-otel'
subprocess = '@deepseek-ai/dsh-subprocess-local'
sandbox = '@deepseek-ai/dsh-sandbox-local'
sandbox-policy = '@deepseek-ai/dsh-sandbox-policy'
bash-sandbox = '@deepseek-ai/dsh-bash-sandbox'
pwsh-sandbox = '@deepseek-ai/dsh-pwsh-sandbox'
approval = '@deepseek-ai/dsh-user-approval'
permission = '@deepseek-ai/dsh-permission-presets'
shell-env = '@deepseek-ai/dsh-shell-env'
tool-bash = '@deepseek-ai/dsh-tool-bash'
tool-pwsh = '@deepseek-ai/dsh-tool-pwsh'
tool-jobs = '@deepseek-ai/dsh-tool-jobs'
fs-observation-policy = '@deepseek-ai/dsh-fs-observation-policy'
tool-fs = '@deepseek-ai/dsh-tool-fs'
tool-fs-search = '@deepseek-ai/dsh-tool-fs-search'
agent-instructions = '@deepseek-ai/dsh-agent-instructions'
skill = '@deepseek-ai/dsh-skill'
skill-filesystem = '@deepseek-ai/dsh-skill-filesystem'
skill-badge = '@deepseek-ai/dsh-skill-badge'
tool-skill = '@deepseek-ai/dsh-tool-skill'
commands = '@deepseek-ai/dsh-commands'
command-feedback = '@deepseek-ai/dsh-command-feedback'
goal = '@deepseek-ai/dsh-goal'
goal-round-driver = '@deepseek-ai/dsh-goal-round-driver'
command-goal = '@deepseek-ai/dsh-command-goal'
plan-mode = '@deepseek-ai/dsh-plan-mode'
token-meter = '@deepseek-ai/dsh-token-meter'
compaction-basic = '@deepseek-ai/dsh-compaction-basic'
command-compact = '@deepseek-ai/dsh-command-compact'
subagent = '@deepseek-ai/dsh-subagent'
subagent-spawn-in-process = '@deepseek-ai/dsh-subagent-spawn-in-process'
subagent-fork-in-process = '@deepseek-ai/dsh-subagent-fork-in-process'
tool-subagent-control = '@deepseek-ai/dsh-tool-subagent-control'
tool-subagent-list-agents = '@deepseek-ai/dsh-tool-subagent-control/list-agents'
tool-subagent = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-fork = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-report = '@deepseek-ai/dsh-tool-subagent-report'
workflow-worker-thread = '@deepseek-ai/dsh-workflow-worker-thread'
tool-workflow = '@deepseek-ai/dsh-tool-workflow'
timeout-policy = '@deepseek-ai/dsh-tool-call-timeout-policy'
spill-local = '@deepseek-ai/dsh-spill-local'
spill-policy = '@deepseek-ai/dsh-spill-policy'
session-checkpoint-policy = '@deepseek-ai/dsh-session-checkpoint-policy'
tool-result-pruner = '@deepseek-ai/dsh-compaction-tool-result-pruner'
tool-todo = '@deepseek-ai/dsh-tool-todo'
tool-goal = '@deepseek-ai/dsh-tool-goal'
tool-ralph = '@deepseek-ai/dsh-tool-ralph'
tool-str-replace-editor = '@deepseek-ai/dsh-tool-str-replace-editor'
repeat-tool-reminder = '@deepseek-ai/dsh-repeat-tool-reminder'
web = '@deepseek-ai/dsh-web'
web-search-deepseek = '@deepseek-ai/dsh-web-search-deepseek'
tool-web = '@deepseek-ai/dsh-tool-web'
tools = '@deepseek-ai/dsh-tools'
system-prompt = '@deepseek-ai/dsh-system-prompt'
agent-loop = '@deepseek-ai/dsh-agent-loop'
fs-sandbox = '@deepseek-ai/dsh-fs-sandbox'
llm-deepseek = '@deepseek-ai/dsh-llm-deepseek'
```

### 3.2 Full composed headless tree (`dsh --profile headless --dump-config`, 81 rows)

timer = '@deepseek-ai/cordis-plugin-timer'
hmr = '@deepseek-ai/cordis-plugin-hmr'
llm = '@deepseek-ai/dsh-llm'
session = '@deepseek-ai/dsh-session'
typert = '@deepseek-ai/dsh-typert-registry'
typert-loader = '@deepseek-ai/dsh-typert-loader'
typert-gateway = '@deepseek-ai/dsh-api-gateway'
session-title = '@deepseek-ai/dsh-session-title'
session-title-llm = '@deepseek-ai/dsh-session-title-first-prompt-llm'
user-questions = '@deepseek-ai/dsh-user-questions'
agent = '@deepseek-ai/dsh-agent'
agent-default-model = '@deepseek-ai/dsh-agent-default-model'
jobs = '@deepseek-ai/dsh-jobs-local'
llm-retry = '@deepseek-ai/dsh-llm-retry'
settings = '@deepseek-ai/dsh-settings-file'
credentials = '@deepseek-ai/dsh-credentials-local'
llm-pi-ai = '@deepseek-ai/dsh-llm-pi-ai'
session-persistence-jsonl = '@deepseek-ai/dsh-session-persistence-jsonl'
attachment-local = '@deepseek-ai/dsh-attachment-local'
session-query-sqlite = '@deepseek-ai/dsh-session-query-sqlite'
session-projection = '@deepseek-ai/dsh-session-projection'
session-telemetry-otel = '@deepseek-ai/dsh-session-telemetry-otel'
subprocess = '@deepseek-ai/dsh-subprocess-local'
sandbox = '@deepseek-ai/dsh-sandbox-local'
sandbox-policy = '@deepseek-ai/dsh-sandbox-policy'
bash-sandbox = '@deepseek-ai/dsh-bash-sandbox'
pwsh-sandbox = '@deepseek-ai/dsh-pwsh-sandbox'
approval = '@deepseek-ai/dsh-user-approval'
permission = '@deepseek-ai/dsh-permission-presets'
shell-env = '@deepseek-ai/dsh-shell-env'
tool-bash = '@deepseek-ai/dsh-tool-bash'
tool-pwsh = '@deepseek-ai/dsh-tool-pwsh'
tool-jobs = '@deepseek-ai/dsh-tool-jobs'
fs-observation-policy = '@deepseek-ai/dsh-fs-observation-policy'
tool-fs = '@deepseek-ai/dsh-tool-fs'
tool-fs-search = '@deepseek-ai/dsh-tool-fs-search'
agent-instructions = '@deepseek-ai/dsh-agent-instructions'
skill = '@deepseek-ai/dsh-skill'
skill-filesystem = '@deepseek-ai/dsh-skill-filesystem'
skill-badge = '@deepseek-ai/dsh-skill-badge'
tool-skill = '@deepseek-ai/dsh-tool-skill'
commands = '@deepseek-ai/dsh-commands'
command-feedback = '@deepseek-ai/dsh-command-feedback'
goal = '@deepseek-ai/dsh-goal'
goal-round-driver = '@deepseek-ai/dsh-goal-round-driver'
command-goal = '@deepseek-ai/dsh-command-goal'
plan-mode = '@deepseek-ai/dsh-plan-mode'
token-meter = '@deepseek-ai/dsh-token-meter'
compaction-basic = '@deepseek-ai/dsh-compaction-basic'
command-compact = '@deepseek-ai/dsh-command-compact'
subagent = '@deepseek-ai/dsh-subagent'
subagent-spawn-in-process = '@deepseek-ai/dsh-subagent-spawn-in-process'
subagent-fork-in-process = '@deepseek-ai/dsh-subagent-fork-in-process'
tool-subagent-control = '@deepseek-ai/dsh-tool-subagent-control'
tool-subagent-list-agents = '@deepseek-ai/dsh-tool-subagent-control/list-agents'
tool-subagent = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-fork = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-report = '@deepseek-ai/dsh-tool-subagent-report'
workflow-worker-thread = '@deepseek-ai/dsh-workflow-worker-thread'
tool-workflow = '@deepseek-ai/dsh-tool-workflow'
timeout-policy = '@deepseek-ai/dsh-tool-call-timeout-policy'
spill-local = '@deepseek-ai/dsh-spill-local'
spill-policy = '@deepseek-ai/dsh-spill-policy'
session-checkpoint-policy = '@deepseek-ai/dsh-session-checkpoint-policy'
tool-result-pruner = '@deepseek-ai/dsh-compaction-tool-result-pruner'
tool-todo = '@deepseek-ai/dsh-tool-todo'
tool-goal = '@deepseek-ai/dsh-tool-goal'
tool-ralph = '@deepseek-ai/dsh-tool-ralph'
tool-str-replace-editor = '@deepseek-ai/dsh-tool-str-replace-editor'
repeat-tool-reminder = '@deepseek-ai/dsh-repeat-tool-reminder'
web = '@deepseek-ai/dsh-web'
web-search-deepseek = '@deepseek-ai/dsh-web-search-deepseek'
tool-web = '@deepseek-ai/dsh-tool-web'
tools = '@deepseek-ai/dsh-tools'
system-prompt = '@deepseek-ai/dsh-system-prompt'
agent-loop = '@deepseek-ai/dsh-agent-loop'
fs-sandbox = '@deepseek-ai/dsh-fs-sandbox'
llm-deepseek = '@deepseek-ai/dsh-llm-deepseek'
code-runtime = '@deepseek-ai/dsh-code-runtime-worker-thread'
headless-startup = '@deepseek-ai/dsh-headless/startup'
headless-runner = '@deepseek-ai/dsh-headless'

### 3.3 Full composed web tree (`dsh --profile web --dump-config`, 129 rows)

timer = '@deepseek-ai/cordis-plugin-timer'
hmr = '@deepseek-ai/cordis-plugin-hmr'
llm = '@deepseek-ai/dsh-llm'
session = '@deepseek-ai/dsh-session'
typert = '@deepseek-ai/dsh-typert-registry'
typert-loader = '@deepseek-ai/dsh-typert-loader'
typert-gateway = '@deepseek-ai/dsh-api-gateway'
session-title = '@deepseek-ai/dsh-session-title'
session-title-llm = '@deepseek-ai/dsh-session-title-first-prompt-llm'
user-questions = '@deepseek-ai/dsh-user-questions'
agent = '@deepseek-ai/dsh-agent'
agent-default-model = '@deepseek-ai/dsh-agent-default-model'
jobs = '@deepseek-ai/dsh-jobs-local'
llm-retry = '@deepseek-ai/dsh-llm-retry'
settings = '@deepseek-ai/dsh-settings-file'
credentials = '@deepseek-ai/dsh-credentials-local'
llm-pi-ai = '@deepseek-ai/dsh-llm-pi-ai'
session-persistence-jsonl = '@deepseek-ai/dsh-session-persistence-jsonl'
attachment-local = '@deepseek-ai/dsh-attachment-local'
session-query-sqlite = '@deepseek-ai/dsh-session-query-sqlite'
session-projection = '@deepseek-ai/dsh-session-projection'
session-telemetry-otel = '@deepseek-ai/dsh-session-telemetry-otel'
subprocess = '@deepseek-ai/dsh-subprocess-local'
sandbox = '@deepseek-ai/dsh-sandbox-local'
sandbox-policy = '@deepseek-ai/dsh-sandbox-policy'
bash-sandbox = '@deepseek-ai/dsh-bash-sandbox'
pwsh-sandbox = '@deepseek-ai/dsh-pwsh-sandbox'
approval = '@deepseek-ai/dsh-user-approval'
permission = '@deepseek-ai/dsh-permission-presets'
shell-env = '@deepseek-ai/dsh-shell-env'
tool-bash = '@deepseek-ai/dsh-tool-bash'
tool-pwsh = '@deepseek-ai/dsh-tool-pwsh'
tool-jobs = '@deepseek-ai/dsh-tool-jobs'
fs-observation-policy = '@deepseek-ai/dsh-fs-observation-policy'
tool-fs = '@deepseek-ai/dsh-tool-fs'
tool-fs-search = '@deepseek-ai/dsh-tool-fs-search'
agent-instructions = '@deepseek-ai/dsh-agent-instructions'
skill = '@deepseek-ai/dsh-skill'
skill-filesystem = '@deepseek-ai/dsh-skill-filesystem'
skill-badge = '@deepseek-ai/dsh-skill-badge'
tool-skill = '@deepseek-ai/dsh-tool-skill'
commands = '@deepseek-ai/dsh-commands'
command-feedback = '@deepseek-ai/dsh-command-feedback'
goal = '@deepseek-ai/dsh-goal'
goal-round-driver = '@deepseek-ai/dsh-goal-round-driver'
command-goal = '@deepseek-ai/dsh-command-goal'
plan-mode = '@deepseek-ai/dsh-plan-mode'
token-meter = '@deepseek-ai/dsh-token-meter'
compaction-basic = '@deepseek-ai/dsh-compaction-basic'
command-compact = '@deepseek-ai/dsh-command-compact'
subagent = '@deepseek-ai/dsh-subagent'
subagent-spawn-in-process = '@deepseek-ai/dsh-subagent-spawn-in-process'
subagent-fork-in-process = '@deepseek-ai/dsh-subagent-fork-in-process'
tool-subagent-control = '@deepseek-ai/dsh-tool-subagent-control'
tool-subagent-list-agents = '@deepseek-ai/dsh-tool-subagent-control/list-agents'
tool-subagent = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-fork = '@deepseek-ai/dsh-tool-subagent'
tool-subagent-report = '@deepseek-ai/dsh-tool-subagent-report'
workflow-worker-thread = '@deepseek-ai/dsh-workflow-worker-thread'
tool-workflow = '@deepseek-ai/dsh-tool-workflow'
timeout-policy = '@deepseek-ai/dsh-tool-call-timeout-policy'
spill-local = '@deepseek-ai/dsh-spill-local'
spill-policy = '@deepseek-ai/dsh-spill-policy'
session-checkpoint-policy = '@deepseek-ai/dsh-session-checkpoint-policy'
tool-result-pruner = '@deepseek-ai/dsh-compaction-tool-result-pruner'
tool-todo = '@deepseek-ai/dsh-tool-todo'
tool-goal = '@deepseek-ai/dsh-tool-goal'
tool-ralph = '@deepseek-ai/dsh-tool-ralph'
tool-str-replace-editor = '@deepseek-ai/dsh-tool-str-replace-editor'
repeat-tool-reminder = '@deepseek-ai/dsh-repeat-tool-reminder'
web = '@deepseek-ai/dsh-web'
web-search-deepseek = '@deepseek-ai/dsh-web-search-deepseek'
tool-web = '@deepseek-ai/dsh-tool-web'
tools = '@deepseek-ai/dsh-tools'
system-prompt = '@deepseek-ai/dsh-system-prompt'
agent-loop = '@deepseek-ai/dsh-agent-loop'
fs-sandbox = '@deepseek-ai/dsh-fs-sandbox'
llm-deepseek = '@deepseek-ai/dsh-llm-deepseek'
code-runtime = '@deepseek-ai/dsh-code-runtime-worker-thread'
storage = '@deepseek-ai/dsh-storage'
storage-json = '@deepseek-ai/dsh-storage-json'
storage-domain = '@deepseek-ai/dsh-storage-domain'
message-feedback = '@deepseek-ai/dsh-message-feedback'
session-log-download = '@deepseek-ai/dsh-session-log-export'
workspace = '@deepseek-ai/dsh-workspace'
session-projection-cache = '@deepseek-ai/dsh-session-projection-cache'
session-stats = '@deepseek-ai/dsh-session-stats'
directory-picker = '@deepseek-ai/dsh-host-directory-picker-auto'
plugin-inventory = '@deepseek-ai/dsh-host-plugin-inventory'
api-gateway = '@deepseek-ai/dsh-host-apiproxy'
cordis-host-runner = '@deepseek-ai/dsh-cordis-host-runner'
web-startup = '@deepseek-ai/dsh-web-app/startup'
webserver = '@deepseek-ai/dsh-host-webserver'
web-runtime = '@deepseek-ai/dsh-web-app'
client-hmr = '@deepseek-ai/dsh-client-hmr'
modules = '@deepseek-ai/dsh-client-modules'
connection = '@deepseek-ai/dsh-client-connection'
api-remotes = '@deepseek-ai/dsh-api-remotes'
client-runtime = '@deepseek-ai/dsh-client-runtime'
cordis-client-runner = '@deepseek-ai/dsh-cordis-client-runner'
ui-theme = '@deepseek-ai/dsh-client-ui-theme'
locale = '@deepseek-ai/dsh-client-locale'
ui-layout = '@deepseek-ai/dsh-client-ui-layout'
ui-sidebar = '@deepseek-ai/dsh-client-ui-sidebar'
ui-settings = '@deepseek-ai/dsh-client-ui-settings'
ui-settings-general = '@deepseek-ai/dsh-client-ui-settings-general'
ui-settings-models = '@deepseek-ai/dsh-client-ui-settings-models'
ui-settings-plugin-inventory = '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'
ui-conversation = '@deepseek-ai/dsh-client-ui-conversation'
ui-tool = '@deepseek-ai/dsh-client-ui-tool'
ui-cordis = '@deepseek-ai/dsh-client-ui-cordis'
ui-workflow-run = '@deepseek-ai/dsh-client-ui-workflow-run'
ui-deliverables = '@deepseek-ai/dsh-client-ui-deliverables'
ui-workspace = '@deepseek-ai/dsh-client-ui-workspace'
ui-input-trigger = '@deepseek-ai/dsh-client-ui-input-trigger'
ui-commands = '@deepseek-ai/dsh-client-ui-commands'
ui-skill = '@deepseek-ai/dsh-client-ui-skill'
ui-subagent = '@deepseek-ai/dsh-client-ui-subagent'
ui-jobs = '@deepseek-ai/dsh-client-ui-jobs'
ui-goal = '@deepseek-ai/dsh-client-ui-goal'
ui-message-feedback = '@deepseek-ai/dsh-client-ui-message-feedback'
ui-model-selection = '@deepseek-ai/dsh-client-ui-model-selection'
ui-permission = '@deepseek-ai/dsh-client-ui-permission-presets'
ui-agent-preset = '@deepseek-ai/dsh-client-ui-agent-preset'
ui-settings-plugins = '@deepseek-ai/dsh-client-ui-settings-plugins'
ui-plan = '@deepseek-ai/dsh-client-ui-plan'
ui-user-questions = '@deepseek-ai/dsh-client-ui-user-questions'
ui-trajectory = '@deepseek-ai/dsh-client-ui-trajectory'
agent-presets = '@deepseek-ai/dsh-agent-presets'

### Confirmations

**(a) `llm-deepseek` exists** in the headless tree with `name: '@deepseek-ai/dsh-llm-deepseek'` (dump line 322). With the headless profile patch applied it carries `config: { apiKeyEnv: TOKENDANCE_API_KEY, baseURL: https://tokendance.space/gateway/v1 }`; the base row itself (`base/cordis.patch.yml:450`) has **no config** — "No key or endpoint is inlined: both resolve per request from the `llm-deepseek:` settings section" — so in the **web** dump the same row exists with no config (default `apiKeyEnv: DEEPSEEK_API_KEY`, `packages/llm/llm-deepseek/src/index.ts:45,91-92`). Your patch target (`id: llm-deepseek`, `name: '@deepseek-ai/dsh-llm-deepseek'`) matches the row in any base composition; the headless profile already proves the exact patch shape end-to-end.

**(b) `llm-pi-ai` also exists** in the headless/base tree: `id: llm-pi-ai`, `name: '@deepseek-ai/dsh-llm-pi-ai'` (base patch line 95; headless dump lines 53-54). Mounted dormant — zero routes until a `llm-pi-ai:` settings section supplies provider profiles.

**(c) Durability rows exist**: `session-persistence-jsonl = '@deepseek-ai/dsh-session-persistence-jsonl'` (base line 98; dump line 55) with `config: { root: !!js dshHomePath('sessions') }`; also `session-query-sqlite` (`path: ':memory:'`, `openAt: never`), `session-checkpoint-policy`, `attachment-local`, `session-projection`.

**(d) Settings/credentials rows exist in the headless tree**: `settings = '@deepseek-ai/dsh-settings-file'` (base line 78) and `credentials = '@deepseek-ai/dsh-credentials-local'` (base line 85) are mounted with no config — so `$DSH_HOME/settings.yaml` and `~/.dsh/.credentials.yaml` apply in the headless tree (and will in tui, same base). The `llm-deepseek` adapter resolves its key per request through `ctx.get('credentials').resolve(apiKeyEnv)` (`packages/llm/llm-deepseek/src/index.ts:220-231`).

VERDICT: the tui patch's `llm-deepseek` target matches a real base row in every composition; `llm-pi-ai`, `session-persistence-jsonl`, `settings`/`credentials` all exist in the headless/base tree; base contributes exactly the 78 rows above.

---

## 4. appExit

**Provided for every profile boot, before the tree mounts.** `dsh --profile <name>` routes through the single shared `runProfile` (`apps/cli/src/bin.ts:29-36` -> `apps/cli/src/profile-boot.ts:204`), whose `boot()` `prepare` hook runs before any config-tree entry mounts (`profile-boot.ts:250-259`):
```ts
// Before any config-tree entry mounts, so plugins resolve all launch-time
// environment values from the same immutable provenance snapshot.
hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
// The command line and bounded exit request are launcher facts available
// to every app plugin that injects the argument snapshot.
provideCmdline(hostCtx, {
  args: options.args,
  exit: code => void shutdown.shutdown(code),
})
```
`provideCmdline` (`packages/boot/cmdline/src/index.ts:68-72`) does `ctx.provide('cmdlineArgs', …)` and `ctx.provide('appExit', host.exit)`; the Context merge declares `appExit?: AppExit` (`cmdline/src/index.ts:31-33`).

**Signature.** `packages/boot/cmdline/src/index.ts:36-42`:
```ts
/** Request bounded process exit; the launcher wires it to its shutdown controller. */
export interface AppExit {
  /** Request exit once the tree has been disposed. @param code - the process exit code. */
  (code: number): void
}
```

**What happens after it is called.** `shutdown.shutdown(code)` -> `start(code, false)` in `createProcessShutdown` (`apps/cli/src/process-shutdown.ts:54-68`): arms a 5000 ms force-exit timer, then awaits the disposer — `dispose = () => app.current?.fiber.dispose()` (`profile-boot.ts:210`) — i.e. the **whole root fiber/tree is disposed**; on clean dispose it sets `process.exitCode = code` (natural exit, `process-shutdown.ts:25,56-58`); on dispose rejection or 5 s timeout it calls `process.exit(code)` (`:38-44,54,60`). headless-runner's contract is exactly this: `packages/bundle/headless/src/index.ts:141-149` reads `ctx.get('appExit')` and throws `'headless-runner: the launcher must provide ctx.appExit before the tree mounts'` when missing, then `run(...)` ends with `io.exit(outcome.reason?.kind === 'completed' ? 0 : 1)` (`:132-136`).

VERDICT: `ctx.appExit(code: number): void` is provided by the launcher for ALL profile boots (not just headless) before any plugin mounts; calling it disposes the entire tree via `fiber.dispose()` and exits with the code (natural exit, or forced after 5 s / on dispose failure).

---

## 5. Plugin module resolution

**Import site.** The Loader imports an entry's `name` in `Entry.init()` -> `vendor/loader/src/config/entry.ts:280`:
```ts
plugin = this.loader.unwrapExports(await this.parent.tree.import(this.options.name, this.getOuterStack))
```
(and re-imports on name change at `:217`). `EntryTree.import` (`vendor/loader/src/config/tree.ts:144-160`):
```ts
import(name: string, getOuterStack?: () => string[]) {
  if (name.startsWith('cordis:')) { return this.ctx.loader.builtins[name.slice(7)] }
  ...
  if (this.ctx.loader.internal) {
    return await this.ctx.loader.internal.import(name, this.ctx.baseUrl!, {})
  } else if (name.startsWith('.')) { ... } else { return await import(name) }
}
```
For the CLI profile boot `bareModuleBaseUrl` is not passed (`profile-boot.ts:253`), so the plain `Include` is used and `baseUrl` is the **profile directory**: `boot()` sets `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'` (`packages/boot/app-boot/src/index.ts:769`; root config = `<profile>/cordis.yml`), and the Include constructor re-anchors to the same dir (`vendor/include/src/index.ts:204`). `internal.import(name, baseUrl, {})` is Node's internal ESM loader, which resolves bare specifiers by the standard `node_modules` **parent-walk from the profile directory**: `<profile>/node_modules` (pnpm-managed, where `deepseek-harness-tui` is symlinked) -> `$DSH_HOME/profiles/node_modules` (installation fallback) -> up. Node ESM resolution **honors the `exports` map** (`"."` -> `./src/index.js`).

Empirically verified with a scratch `file:`-linked package: from the profile dir, `import.meta.resolve('deepseek-harness-tui-scratch')` -> `file:///private/tmp/zz-deepseek-harness-tui-scratch (throwaway)/src/index.js` (exports map honored), exports `['apply', 'name']` loaded.

Caveat: if `ctx.loader.internal` were `undefined` (no Node internal loader), bare names would fall back to a plain `import(name)` from the loader module's own resolution — not profile-anchored. The installed dsh ships `node-addon-require-builtin` (`apps/cli/package.json` dependencies) so `ModuleLoader.fromInternal()` works (`vendor/loader/src/internal.ts:67-75`) and the primary path applies.

**`Config` is NOT required when a row has no config.** Config validation is `resolveConfig` in `vendor/cordis/src/fiber.ts:50-63`:
```ts
export function resolveConfig(runtime: Plugin.Runtime, config: any) {
  if (!runtime.Config) return config   // no schema -> config passes through unchanged
  const result = runtime.Config['~standard'].validate(config)
  ...
}
```
`runtime.Config` is copied from `plugin.Config` at registration (`vendor/cordis/src/registry.ts:316-326`). The base `timer` row has no config and `@deepseek-ai/cordis-plugin-timer` exports no `Config` (`vendor/timer/src/index.ts`) — and headless boots with it, so a config-less row + schema-less plugin is a valid load. When a plugin DOES export `Config` (e.g. `headless-runner`, `Config = z.object({ task: z.string().required() })`, `packages/bundle/headless/src/index.ts:43-47`) and the row supplies config, validation runs through the standard-schema pipeline (`fiber.ts:641-643`).

VERDICT: bare `name` specifiers resolve through Node's parent-walk anchored at the profile directory, `exports` maps are honored, and no `Config` export is required for config-less rows — the planned `name: 'deepseek-harness-tui'` row will load the linked local package.

---

## 6. agentDefaultModel

Default selection is a row-config fact of the base bundle (`packages/bundle/base/cordis.patch.yml:63-67`):
```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash
```
The composed headless dump shows the same values (dump lines 40-44). `AgentDefaultModelConfig` (`packages/core/agent-default-model/src/index.ts:64-95`):
```ts
export class AgentDefaultModelConfig extends Service {
  static Config: z<Config> = z.object({ provider: z.string().required(), model: z.string().required() })
  ...
  currentSelection(): ModelSelection {
    return selection(this.source())   // { provider, model, ...reasoningEffort? } — source = row config, or settings section
  }
}
```
The provider route `deepseek-official` is owned by `@deepseek-ai/dsh-llm-deepseek`: `const PROVIDER = 'deepseek-official'` (`packages/llm/llm-deepseek/src/index.ts:47`), and its advisory catalog defaults advertise `deepseek-v4-flash` and `deepseek-v4-pro` (`llm-deepseek/README.md:38`). headless consumes it exactly as the tui-runner should: `const selection = defaultModel.currentSelection()` then `agents.create({ …, agentOptions: { provider: selection.provider, model: selection.model }, setup: … })` (`packages/bundle/headless/src/index.ts:106-121`).

VERDICT: in a base+headless composition with no extra config, `defaultModel.currentSelection()` returns `{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }` — the route owned by the `llm-deepseek` row, so patching that row's `apiKeyEnv`/`baseURL` redirects the default model's traffic.

---

## 7. pnpm allowBuilds

`initProfile` writes the profile's `pnpm-workspace.yaml` (`packages/boot/app-boot/src/profile.ts:141-148`):
```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```
There is **no `allowBuilds` key** — dsh never writes one. `dsh plugin` only *mentions* allowBuilds in an error hint for **git-hosted** specs (`apps/cli/src/plugin.ts:143-154`): "git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in …/pnpm-workspace.yaml, then re-run". pnpm 10's build-script gate only affects packages that have lifecycle scripts (`prepare`/`postinstall`/`preinstall`); a `file:`-linked package with **no build/prepare scripts** runs no lifecycle scripts, so nothing is blocked and no allowBuilds dance is needed.

Empirically verified (throwaway profile, cleaned up): `dsh plugin --profile zz-allowbuilds-test add /tmp/zz-deepseek-harness-tui-scratch (throwaway)` — a scriptless package with `dsh.bundle.patch` — succeeded in ~0.4 s, exit 0, no allowBuilds; pnpm wrote `"deepseek-harness-tui-scratch": "link:/tmp/zz-deepseek-harness-tui-scratch (throwaway)"`.

**Gotchas with absolute-path specs:**
- `anchorPathSpec` passes absolute specs through verbatim (`plugin.ts:104-118`); pnpm records `link:<abs>` in `dependencies` + lockfile and creates a **symlink** into the profile's `node_modules`. The linked directory must exist at add time, and the symlink points at the live directory — moving/renaming `$DSH_HOME_SRC-tui` breaks resolution until re-`add`.
- Reconcile is based on installed state, so `deepseek-harness-tui` joins `bundles` **only if** its `package.json` declares `dsh.bundle.patch` (any file name works, e.g. `./dsh.bundle.patch`); otherwise it installs with a "declares no dsh.bundle" warning and never joins the layer stack.
- If the tui-runner plugin has its own deps: `autoInstallPeers: false` plus the flat fallback mean missing peers fall through to the healed `~/.dsh/profiles/node_modules`, so the plugin shares the installation's single `@deepseek-ai/cordis` instance (comment at `profile.ts:138-140`).

VERDICT: `dsh plugin --profile tui add $DSH_HOME_SRC-tui` succeeds without any allowBuilds change as long as the package has no build/prepare scripts; the only caveats are the absolute-path `link:` symlink (source dir must stay put) and that the manifest must declare `dsh.bundle.patch` for the reconcile to append it to `bundles`.

---

## 8. Session event flow

**`session/event` is emitted for every append, post-commit.** Declaration (`packages/core/session/src/index.ts:66-76`):
> "Post-commit, fire-and-forget append feed. The listener snapshot resolves before the log push, but callbacks run after it; observer failures are logged and contained without making the committed append fail."
> `'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void`

Exact emit site inside `Session.append()` (`index.ts:636-647`):
```ts
const callbackArgs: unknown[] = [this, event]
if (entry !== undefined) {
  callbacks = collectSessionCallbacks(entry.emitCtx, [entry.carrier, 'session/event', ...callbackArgs])
}
this.log.push(event as SessionEvent)
this.eventsSnapshot = undefined
if (callbacks !== undefined && entry !== undefined) {
  invokeContainedSessionObservers(entry.emitCtx, 'session/event', entry.id, callbackArgs, callbacks)
}
return event
```
Synchronous dispatch, after the log push, per event; failures contained per listener. Two caveats: sessions only emit while **entered into the store** (the store's `enter()` installs the publication hooks with `emitCtx: this.ctx`, `index.ts:893-930` — agent-created sessions are entered), and constructor seeds do not emit (`index.ts:451-454`). Dispatch is scope-filtered: agent-scoped listeners receive only events from sessions entered through that agent's context (`session/event` doc, `:66-76`).

**Matching key.** The listener's first argument is the `Session`; `session.id` is the durable header id — `get id(): SessionId { return this.header.id }` (`index.ts:446-448`). The agent holds the same object: `public readonly session: Session` (`packages/core/agent-loop/src/agent.ts:84`), so `agent.session.id`/`session.id` are the same value and the correct join key for `session/event`.

**`followup` queues and does not await.** Runtime contract (`packages/core/agent/src/runtime-types.ts:118-124`): "Queue an ordinary follow-up turn and wake the driver. The item becomes the sole ordinary message of its own turn." Implementation (`packages/core/agent-loop/src/agent.ts:113-124`):
```ts
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
  ...
  this.inbox.splice(resolvedTarget, Infinity, 0, [message])
  if (wakeup) this.wakeDriver(wakingAfterAbort)
}
followup(input: UserMessage): void {
  this.send(input, 'next-turn', true)
}
```
`followup` returns `void`; `wakeDriver` (`:165-193`) resolves a driver promise and starts the loop without awaiting (`this.loopCtx.agents.withInitiator(this, () => this.kick()).then(driver.resolve, driver.reject)`). Callers await quiescence instead: `whenIdle(): Promise<void>` (`agent.ts:195-199`; runtime-types.ts:93-99) loops on `activityDone` until no driver/maintenance remains. This is exactly the headless sequence to mirror: `await agent.whenIdle(); agent.followup(createUserMessage(…)); await agent.whenIdle(); await sessions.flush(agent.session)` (`packages/bundle/headless/src/index.ts:122-127`).

VERDICT: every appended event on a store-entered session emits `session/event` (session first, event second) after commit; `agent.session.id`/`session.id` is the join key; `agent.followup(msg)` queues into `next-turn` and wakes the driver without awaiting — use `agent.whenIdle()` to wait.

---

## Cross-cutting notes for the tui plan

- Bundle order `["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "deepseek-harness-tui"]` matches the flatten-append semantics: base rows -> headless rows -> tui rows, and tui's disables target headless rows correctly (Q1). **Current state (2026-08-14):** the `tui` profile is fully wired — `dsh plugin --profile tui add @deepseek-ai/dsh-headless` and `dsh plugin --profile tui add $DSH_HOME_SRC-tui` were both run and verified live (`dsh --profile tui` boots the Ink UI end-to-end with the TokenDance route).
- The tui-runner plugin should follow `packages/bundle/headless/src/index.ts:96-137` verbatim in shape: `await ctx.get('loader')?.await()` first, read `appExit` via `ctx.get('appExit')`, drive `agents.create(...)` with `agentOptions: { provider, model }` from `agentDefaultModel.currentSelection()`, then `whenIdle`/`followup`/`flush`/`exit`.
- A config-less row needs no `Config` export (Q5); the headless pattern of exporting `Config` + `inject: [headlessStartup]` is optional — `!!js` expressions in `config` are supported by the patch parser (`packages/boot/app-boot/src/index.ts:304-311`).
- `llm-deepseek` config patch (Q3a) is proven end-to-end by the headless profile; the same `cordis.patch.yml` shape works in tui.

---

## Live event shapes observed (2026-08-13, rc.6, TokenDance route)

Forwarded via `session/event` after commit; `data` is a deep copy.

- `tool/call`: `{ turn, step, callId: 'call_…', name, arguments }`
- `tool/result`: `{ turn, step, message }` — **no top-level `callId`**.
  - Pair with `tool/call` via `message.source.callId` (or `message.content[0].toolCallId`).
  - Output text: `message.content[0].content[].text` (block type `'tool-result'`).
  - Error flag: `message.content[0].isError` (boolean, not an object).
- `assistant/message`: `{ turn, step, message, usage? }` — `message.content[]` blocks are `text` / `reasoning` / `tool-call` / `tool-result`.
- `turn/end`: `{ turn, reason: { kind: 'completed' | 'aborted' | 'error' | … }, usage? }`

The `tool/result` shape changed the pairing logic in `src/ui.js` (callId read from `message.source.callId`); keep defensive access — the harness iterates fast and field names may shift between rc builds.

---

## 9. UI layer (v2, 2026-08-14) — design & event mapping

The UI is a single Ink app (`src/ui.js`, ~800 lines) mounted by the `tui-runner` plugin (`src/index.js`) with `render(<App …/>, { stdout })`. The App bridges the Cordis event bus via a `forward` handler installed on mount; every `session/event` is mapped to UI state. This section documents the v2 visual design and the exact event → UI mapping, both verified live on 2026-08-14 (rc.6, TokenDance route).

### Empty state (brand banner)

Inspired by Hermes Agent's TUI (`ui-tui`, also Ink) and Codex CLI:

- **DeepSeek logo** — 6-line ANSI Shadow art ("DeepSeek"), gradient-colored `#4D6BFE → #B5C6FF` (brand blue ramp), centered.
- **Tagline** — `DeepSeek Harness · terminal AI chat for the DeepSeek Harness` (bold blue + dim).
- **Info panel** — single-line border (`borderStyle: 'single'`, `borderColor: '#4D6BFE'`) with three rows: `model` (bold) · `directory` (short cwd) · `commands` (`/help · /clear · /exit`).
- **Hint line** — `press /help for keys · ctrl + c to quit` (dim).
- **Composer** — `❯ ` prompt (cyan), placeholder `Ask anything`, via `ink-text-input` 6.0.0.
- The banner only renders when the transcript is empty (`items.length === 0 && no stream/tool state`) — it disappears on the first user message.

### Event → UI mapping (src/ui.js `handleEvent`)

| event type | UI effect |
| --- | --- |
| `turn/start` | busy on, reset stream/todos/usage; start elapsed timer |
| `turn/end` | busy off; `✓ completed · usage: Nin Nout Ncache` (or `✗` label); reason from `data.reason.kind`, usage from `data.usage` |
| `assistant/message` | reasoning → thinking block (folds via `ctrl + t`); text → markdown stream; tool-call blocks → tool cell |
| `tool/start` | tool cell `⠋ Running <cmd>` (pair by `callId`) |
| `tool/result` | cell settles `✓ <cmd> • <s>` / `✗`; output merged dimmed, truncated head+tail; `error` from `data.error` if present |
| `tool/todo` | todo panel: `◐` in-progress (cyan), `☐` pending (dim), `✓` done (green); cleared on `turn/start` |

Key pairing: `tool/result` carries **no top-level `callId`** — read `message.source.callId` (or `message.content[0].toolCallId`); error flag is `message.content[0].isError` (boolean). Esc during a live turn calls `agent.cancel({ kind: 'user' })`; `ctrl + c` exits exactly once via `appExit`.

### Theme derivation (src/theme.js)

`probeTerminalBg()` runs **before** Ink mounts (Ink's key parser would otherwise swallow the OSC 11 response). Since 2026-08-14 the regex requires the ST/BEL terminator (`(?:\x1b\\|\x07)`) so no stray `ESC \` bytes reach Ink, and 16-bit channels are converted by taking the high byte. `DSH_TUI_BG` forces a theme for testing.

### Input quirk observed (tmux send-keys only)

Sending text + Enter in a single `tmux send-keys '…' Enter` call drops the Enter — the message stays in the composer and needs a second Enter. Sending the text and Enter as separate keypresses (or a real keyboard) always submits. Ink's `useInput` + `ink-text-input` 6.0.0 handle `key.return` correctly (`if (key.return) onSubmit(originalValue)`), so this is a tmux send-keys batching artifact, not a UI bug — no fix applied.

### Status line & footer

- Busy: `⠋ Working <elapsed> · esc interrupt` (braille spinner + compact timer).
- Footer (always): `model · short-cwd` (dim) left, key hints right (`ctrl + t: show/hide thinking`, `ctrl + c quit`).

### TokenDance prerequisite fix

Applied 2026-08-13 to the global install (`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js:321-322`): empty-string guards on `call.id`/`call.function?.name`. Verified against the rc.6 tarball (diff is exactly those two lines) and with a behavior-level test through the real `DeepSeekAdapter.stream()` path (empty frames no longer clobber `callId`/`name`). **Lost on `dsh` upgrade — re-apply.**
