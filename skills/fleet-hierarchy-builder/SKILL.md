---
name: fleet-hierarchy-builder
description: Draft and apply hierarchies for existing Hermes profiles.
version: 0.1.0
author: Asmoday (asmodaydoescoding), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Fleetgraph, hierarchy, profiles, topology]
    related_skills: []
---

# Fleet Hierarchy Builder Skill

Builds a proposed Fleetgraph hierarchy from profiles that already exist in
Hermes. It is request-driven and topology-only: analysis never edits profile
folders, SOUL files, providers, skills, or toolsets. Applying the proposal is a
separate, explicit operation.

## When to Use

Use only when the user asks to:

- organize existing profiles into a hierarchy;
- write or repair a Fleetgraph topology;
- map current profiles to supervisors, departments, and roots.

Do not use for automatic startup scans, profile creation, profile deletion, or
silent graph rewrites.

## Prerequisites

- A direct user request to draft or apply a hierarchy.
- Access to the canonical Hermes profile inventory through
  `terminal(command="hermes profile list")`.
- Permission to inspect only the profile metadata needed for capability
  summaries through `terminal(command="hermes profile show <name>")`.
- Fleetgraph's draft/apply save flow available for the final write.

## Procedure

1. Snapshot the current inventory with
   `terminal(command="hermes profile list")`. Preserve canonical names exactly.
2. For each candidate profile, inspect its displayed metadata with
   `terminal(command="hermes profile show <name>")`. Do not read or copy
   secrets, session history, or unrelated state.
3. Build capability summaries from declared descriptions, SOUL headings, and
   enabled skills/toolsets. Treat missing or ambiguous metadata as unknown,
   not as evidence.
4. Draft a topology with:
   - every existing profile represented at most once;
   - explicit roots for profiles without a justified supervisor;
   - supervisor edges only where capability, workflow, or the user's stated
     authority supports them;
   - peer relations only when the user requests or clearly describes them;
   - an unresolved/needs-review list for ambiguous edges.
5. Validate the draft before showing it:
   - no cycles;
   - no supervisor that is absent from the inventory;
   - no duplicate canonical names;
   - no self-supervision;
   - deleted or missing profiles do not get resurrected;
   - direct reports of a removed supervisor become roots.
6. Show a graph diff before writing. Include added edges, removed edges,
   roots, peer relations, unresolved decisions, and the exact number of nodes.
7. Stop for explicit approval. “Draft it” authorizes analysis; it does not
   authorize applying the topology.
8. On approval, apply through Fleetgraph's locked graph-save path. Never edit
   `fleet_graph.yaml` with an ad-hoc filesystem write.
9. Read back the authoritative graph and profile inventory. Confirm that only
   topology changed and that every approved edge persisted.

## Fleetgraph Surface

The Desktop plugin exposes **Build hierarchy** under **Fleet workflows**. It
sends the current staged topology to `/hierarchy/preview`, which validates and
returns a graph diff without writing. Only the separate **Approve & apply
hierarchy** action sends `/hierarchy/apply` with `confirm: true`; that endpoint
uses the locked graph-save path for one atomic topology write.

## Output Contract

```text
Hierarchy draft: <name>
Profiles inspected: <count>
Roots: <list>
Supervisor edges: <count>
Peer edges: <count>
Unresolved decisions: <list>
Apply status: draft-only | applied | refused
```

## Safety Rules

- Existing Hermes profiles are adopted/wired; they are never recreated by this
  skill.
- Never delete a profile or modify its content as part of hierarchy work.
- Never use profile display aliases as canonical identities without resolving
  them through the Hermes inventory.
- Preserve unrelated unsaved graph edits when the UI draft has them.
- Refuse an apply when the authoritative graph changed since the draft was
  produced; regenerate the diff instead.

## Verification

A successful apply requires an exact pre/post graph diff, a successful locked
save, a readback with the approved node and edge counts, and a confirmation
that no profile directory or profile configuration file changed.
