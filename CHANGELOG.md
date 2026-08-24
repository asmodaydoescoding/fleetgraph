# Changelog

## 0.7.0 — 2026-08-24

Fleet Graph 0.7.0 is a release-hardening update focused on trustworthy topology
state, profile lifecycle synchronization, messaging delivery, and operator
recovery paths.

### Added

- **Profile cloning at birth.** New members query Hermes' canonical profile
  inventory and pass the selected source through `profiles.create` as
  `clone_from`; Hermes copies the source config, skills, and persona before
  Fleet Graph wires the new member into the hierarchy.
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

Initial public Fleet Graph release with the interactive graph, Fleet Command
deck, inspector, inbox read-state, semantic routing, discussion glow, message
composer, SOUL editor, member creation, and topology editing.
