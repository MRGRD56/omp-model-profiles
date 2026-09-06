# omp-model-profiles

Standalone Oh My Pi extension for saving, editing, and applying named sets of model-role assignments through the `/profiles` terminal UI.

## Product behavior

The extension registers:

- `/profiles` — opens the profile manager in TUI mode.
- `Ctrl+Alt+P` — opens the same interface by default.

A profile is a named snapshot of exact OMP role-to-model selectors. Applying a profile replaces the complete explicit assignment set in the active OMP storage layer. Roles omitted from the profile are returned to Auto in that layer.

The active profile indicator is derived by comparing the current settings with each profile. No separate active-profile marker is persisted, so manual model-role changes cannot leave a stale active state.

## Project layout

- `src/index.ts` registers the command and shortcut and opens the TUI.
- `src/profiles-dialog.ts` owns rendering, keyboard input, profile actions, model selection, and effort selection.
- `src/profile-store.ts` validates and persists the versioned YAML profile file.
- `src/apply-profile.ts` resolves selectors, updates the selected settings layer, flushes settings, and switches the active session model when required.
- `src/roles.ts` obtains ordered role IDs, display names, tags, and current assignments from OMP.
- `test/` contains behavior-focused Bun tests and test settings helpers.
- `docs/` contains public documentation assets.
- `package.json` declares `src/index.ts` as the OMP extension entrypoint.

Keep runtime extension code under `src/`. Keep tests, package metadata, and documentation at the repository root.

## Persistent data

Profiles are stored in `model-profiles.yml` under the active OMP agent directory returned by `getAgentDir()`. This makes profile storage follow the active OMP profile, XDG configuration, and `PI_CODING_AGENT_DIR`.

The file uses schema version 1:

```yaml
version: 1
profiles:
  - id: 00000000-0000-4000-8000-000000000000
    name: Example
    models:
      default: provider/model:high
    lastUsedAt: 1735689600000
```

Storage invariants:

- Preserve selector strings exactly, including thinking-level suffixes.
- Reject unknown schema keys, malformed IDs, duplicate names, and invalid timestamps.
- Treat a missing profile file as an empty store; do not create it until the first mutation.
- Serialize writes atomically with `replaceFileAtomically`.
- Hold `withFileLock` while checking and replacing the file.
- Abort if the on-disk bytes changed since the last load or successful write. Never silently overwrite another OMP session.
- Profile deletion does not revert already-applied OMP settings.

User profile data lives outside this repository. Relinking, upgrading, or reinstalling the extension must not delete or rewrite `model-profiles.yml` unless the user performs a profile mutation through the extension.

## OMP integration contracts

Minimum supported OMP version: 18.1.11.

Use these upstream APIs directly:

- `@oh-my-pi/pi-coding-agent/config/model-roles`
  - `getKnownRoleIds(settings)`
  - `getRoleInfo(role, settings)`
- `@oh-my-pi/pi-coding-agent/config/model-resolver`
  - `parseModelString`
- `@oh-my-pi/pi-coding-agent/config/settings`
  - `Settings.setModelRole`
  - `Settings.setProjectModelRole`
  - `Settings.clearProjectModelRole`
  - `Settings.flush`
  - `settings.get("modelRoleStorage")`
- `@oh-my-pi/pi-coding-agent/utils/atomic-file`
  - `replaceFileAtomically`
- `@oh-my-pi/pi-utils`
  - `getAgentDir`
  - `withFileLock`

Missing exports are compatibility failures. Do not add local fallback implementations that conceal an unsupported OMP version.

Role handling must remain dynamic:

- Never copy or maintain a built-in role enum in this extension.
- Include built-in roles, configured custom roles, cycle-order roles, model-tag roles, and profile-only roles.
- Resolve role labels and tags through `getRoleInfo`.
- Preserve profile-only roles even when the current OMP configuration no longer knows them.

Settings handling:

- Use the host's live `Settings` instance exposed by the extension API. Do not create a second settings store.
- Respect `modelRoleStorage`: update either the global layer or the project layer selected by OMP.
- Treat a profile as a complete assignment set for that layer, not as a partial patch.
- Flush settings before reporting a successful apply.
- Resolve every non-empty selector before mutating settings, so an invalid profile cannot be partially applied.

## TUI behavior

The profile list and role details are separate focus panels. Preserve the controls documented in `README.md` and the footer shown by the dialog.

When changing the UI:

- Keep every mode within the supplied terminal width and height.
- Use OMP theme colors instead of hard-coded terminal colors.
- Keep active, focused, and selected states distinguishable.
- Preserve keyboard-only operation.
- Keep destructive actions behind confirmation.
- Surface storage, resolution, and settings failures in the dialog without closing it.
- Reuse OMP's native model browser and thinking-effort metadata rather than recreating model lists.

## Development workflow

1. Install dependencies from the repository root:

   ```sh
   bun install
   ```

2. Read the affected source and tests before editing. For OMP behavior, inspect the installed upstream API instead of assuming a contract.
3. Make the smallest complete change. Update every affected caller and remove code made obsolete by that change.
4. Add or update tests only for observable behavior, boundaries, state transitions, conflict handling, or real error paths. Do not test source text or implementation wiring.
5. Run the static and automated checks:

   ```sh
   bun run typecheck
   bun test
   ```

6. Refresh the linked OMP installation:

   ```sh
   omp plugin link .
   omp plugin list --json
   ```

7. In a live OMP session, run:

   ```text
   /reload-plugins
   /profiles
   ```

8. Exercise the changed path in the actual TUI. For interaction changes, verify navigation, rendering, the action result, and the relevant error or cancel path.

Do not consider a change complete after tests alone. The extension must also load through OMP and the changed behavior must work in the live TUI.

## Updating the user's OMP installation

### Linked checkout: current installation flow

This repository is currently installed with `omp plugin link .`. OMP creates a user-level link to the working tree instead of copying the source. Source edits therefore do not require a package reinstall, but the running OMP process must reload the extension.

After updating the checkout, run from the repository root:

```sh
git pull --ff-only
bun install
omp plugin link .
omp plugin list --json
```

Then reload the running OMP session:

```text
/reload-plugins
```

If reload is unavailable or fails, restart OMP. Open `/profiles` once to confirm that the extension loads and stored profiles remain available.

Notes:

- `bun install` is required when `package.json` or `bun.lock` changed and is safe to run for every update.
- `omp plugin link .` is idempotent. Run it after every update so manifest or entrypoint changes are reflected in the installation.
- `omp plugin list --json` must show exactly one enabled entry named `omp-model-profiles`, with `./src/index.ts` in `manifest.extensions`, pointing to the intended checkout.
- Do not copy source files into OMP's plugin directory manually. That creates version drift and bypasses the linked workflow.
- Do not delete `model-profiles.yml` during an update; it is user data and is not part of the checkout.

### Marketplace installation: future distribution flow

`omp plugin upgrade` upgrades marketplace-managed plugins, not linked checkouts. If this extension is published to an OMP marketplace, users should update it with:

```sh
omp plugin upgrade omp-model-profiles@<marketplace>
```

Use `--scope user` or `--scope project` only when a specific installation scope must be targeted. Reload plugins or restart OMP after the upgrade, then verify `/profiles`.

For the direct GitHub installation documented in `README.md`, reinstall the same source to update the user's installed copy:

```sh
omp plugin install github:MRGRD56/omp-model-profiles --force
```

Then reload plugins or restart OMP and verify `/profiles`. The GitHub shorthand is `github:user/repo`; do not add `@` before the GitHub username. Direct npm package syntax such as `@scope/package` requires a separately published npm package and must not be documented unless that package exists.

## Required completion gate

After every repository change:

1. If `package.json` or `bun.lock` changed, run `bun install`.
2. Run `bun run typecheck` and require zero errors.
3. Run `bun test` and require all tests to pass.
4. Run `omp plugin link .` from the repository root.
5. Run `omp plugin list --json` and verify the enabled entry, repository link, and `./src/index.ts` manifest entrypoint.
6. Reload a live OMP session with `/reload-plugins` or restart OMP.
7. Open `/profiles` and smoke-test the behavior affected by the change.

The linked working tree is the installed extension. Never maintain a separate copied build.
