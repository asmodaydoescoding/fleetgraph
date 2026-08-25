# Changelog

## 0.8.0 — 2026-08-24

### Added

- **Release 0.8.0 follow-up hardening.** Starter-pack installation now compensates
  newly created profiles if the graph commit fails; Hermes route remounting uses
  a versioned protocol; and the advisor/hierarchy workflows are reachable from
  the plugin through explicit preview and approval actions.
- **Starfleet Complement starter pack.** Added an optional, inert 75-node
  topology extracted from PR #5, with attribution to Teknium for the original
  MIT-licensed profile collection and Baal-TehDriverman for the Fleetgraph
  topology contribution. Download and preview do not execute profile code or
  mutate the graph.
- **Fleet Bot Advisor skill.** Added a local-only, coarse-signal workflow that
  observes, summarizes, recommends, asks for approval, and only then creates
  selected profiles through the canonical clone/adoption flow.
- **Fleet Hierarchy Builder skill.** Added an on-demand draft-and-diff workflow
  for existing Hermes profiles. It validates cycles, unknown supervisors, and
  duplicates before an explicit topology-only apply.
- **Profile import.** Added an explicit discovery/import flow for Hermes profiles
  already present on disk, with metadata seeding, collision-safe canonical alias
  handling, configurable profile-root support, and isolated regression coverage.
- **Live dashboard route remount.** Hermes now exposes confirmed
  `plugins.manage` → `reload_dashboard_routes`; Fleetgraph uses it to recover
  from the enabled-but-unmounted 404 state without restarting the backend.
- **Installation contract.** Documented the Hermes-native Git installer, the
  exact v0.8.0 pin, manifest/file verification, the required desktop-entry
  symlink, separate backend/desktop activation, archive extraction boundaries,
  and the fact that runtime users do not install development dependencies.

## 0.7.0 — 2026-08-24

Fleetgraph 0.7.0 is a release-hardening update focused on trustworthy topology
state, profile lifecycle synchronization, messaging delivery, and operator
recovery paths.

### Added

- **Profile cloning at birth.** New members query Hermes' canonical profile
  inventory and pass the selected source through `profiles.create` as
  `clone_from`; Hermes copies the source config, skills, and persona before
  Fleetgraph wires the new member into the hierarchy.
- **Existing-profile adoption.** `Adopt & wire in` attaches a Hermes profile
  already represented by the graph without recreating it, then applies only
  the explicit description, SOUL, model, skill, and toolset edits.
- **Deletion reconciliation.** Hermes' built-in Bots/Profiles inventory is the
  authority for profile existence. Deleted profiles disappear from the graph,
  hierarchy controls, relation choices, and deck without allowing stale open
  tabs to resurrect them.
- **Hierarchy controls.** Supervisor changes, report attachment/detachment,
  peer editing, demotion to root, explicit hierarchy removal, report-retention
  checks, and later profile adoption/reattachment are handled as distinct
  operations.
- **Atomic topology saves.** Graph writes use collision-safe temporary files,
  cross-process locking, merge semantics, and explicit removal lists. A stale
  client cannot silently wipe newer nodes or relations.
- **Live activity refresh.** Completion events invalidate the broad transcript
  and overview queries; polling remains available for older or remote gateways.
- **Messaging composer.** The inspector's Message tab supports validated
  `talk`, `delegate`, and `supervisor` frames, peer selection, inbox-only
  delivery, success/error feedback, and cache refresh after delivery.
- **Actionable validation errors.** Hierarchy-save refusals distinguish a real
  Hermes profile that is not yet a fleet member from a name with no matching
  profile, and list current fleet members accurately.

### Fixed

- Graph saves no longer wrap the payload under a bogus nested `nodes` member.
- Repaired graph-only metadata handling so `_meta` remains metadata rather than
  rendering as a phantom node.
- **Inbox alias delivery.** Graph-facing aliases now resolve to canonical Hermes
  profile inboxes for sends, reads, drains, and unread watermarks. A successful
  send cannot disappear into an alias-named file that the profile never drains.
- Stale peer-recipient selections are revalidated server-side before any inbox
  write.
- Empty message bodies and unknown message frames are rejected before graph or
  inbox mutation.
- Transcript rendering uses deterministic fallback keys and detects content
  changes even when message counts stay constant.
- Create-flow and host harnesses now match the current plugin SDK and exercise
  adoption behavior instead of only checking the dialog label.
- Corrected desktop loader documentation and static verification to match
  Hermes' syntax-anchored ESM import matcher, including its compatibility rule
  against import-declaration-shaped text in plugin comments and strings.
- Public release checks enforce one version across the plugin manifest, desktop
  badge, dashboard manifest, README, and release payload.
- Generated test dependencies and temporary files are excluded from release
  payloads.

### Verification

The release includes regression coverage for profile deletion, alias inbox
routing, stale saves, concurrent writes, hierarchy removal, message guards,
message recipient selection, create/adoption flow, rendering, theme tokens,
and public-release privacy checks. The canonical release checklist runs Python
and JavaScript syntax checks, backend adversarial/integration suites, and all
UI harnesses from the `tests/` directory.

## 0.6.1

Initial public Fleetgraph release with the interactive graph, Fleet Command
deck, inspector, inbox read-state, semantic routing, discussion glow, message
composer, SOUL editor, member creation, and topology editing.
