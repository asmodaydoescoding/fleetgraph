---
name: fleet-bot-advisor
description: Suggest specialist bots from repeated local workflows.
version: 0.1.0
author: Asmoday (asmodaydoescoding), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [Fleetgraph, profiles, recommendations, privacy]
    related_skills: []
---

# Fleet Bot Advisor Skill

Suggests specialist Hermes profiles when the user repeatedly performs a
recognizable class of work. This skill is advisory: it never creates, clones,
installs, or wires a bot without an explicit approval for that recommendation.
It uses coarse local activity signals by default and does not build a raw
transcript archive.

## When to Use

Use when the user asks for:

- recurring-work analysis;
- recommended specialist bots;
- setup-time fleet suggestions;
- a review of whether a new profile would remove repeated manual work.

Do not use for silent background monitoring, automatic profile creation, or
analysis of message content the user has not asked to inspect.

## Prerequisites

- The user explicitly requested recommendations or opted into setup analysis.
- Hermes local insights are available through `terminal`.
- The Fleetgraph roster is available for capability and duplicate checks.
- A proposed clone source is identified before any approval request.

## Procedure

1. Establish scope. Ask for a bounded window only when it was not supplied;
   otherwise use 30 days. Never expand to all history by default.
2. Collect coarse usage evidence with
   `terminal(command="hermes insights --days 30")`. Prefer tool-pattern,
   activity, and category counts over raw message text.
3. Read the current profile inventory with
   `terminal(command="hermes profile list")` and compare it with the Fleet
   Graph roster. Treat canonical Hermes profile names as authoritative.
4. Form a recommendation only when a workflow cluster has at least three
   occurrences or a clearly repeated multi-step pattern. Merge aliases and
   ignore one-off tasks.
5. Produce a recommendation table with:
   - proposed profile name and role;
   - evidence count and time window;
   - existing profiles that already cover the role;
   - source profile to clone;
   - skills/toolsets the new profile would need;
   - proposed Fleetgraph supervisor;
   - privacy notes and unresolved ambiguity.
6. Stop for explicit approval. Present one recommendation per approval unit;
   a batch approval must list every profile that will be created.
7. After approval, use Fleetgraph's Create flow so the canonical
   `profiles.create` RPC receives the chosen `clone_from` source and the new
   profile is wired into the graph. Do not substitute filesystem copying.
8. Read back the Hermes profile inventory and Fleetgraph roster. Report the
   created profile name, clone source, graph position, and any failed step.

## Fleetgraph Surface

When the Fleetgraph Desktop plugin is enabled, these actions are available from
**Fleet workflows**:

- **Review advisor** calls `/advisor/preview` and Hermes `insights.get` for a
  bounded, coarse summary. It is read-only and stops before profile creation.
- **Build hierarchy** calls `/hierarchy/preview` for a read-only validated diff.
  The separate **Approve & apply hierarchy** action calls
  `/hierarchy/apply` with explicit confirmation and uses the locked graph-save
  path for one atomic topology write.

The plugin never sends raw transcripts, credential values, or tool payloads to
these workflow endpoints.

## Output Contract

```text
Recommendation: <profile>
Role: <one sentence>
Evidence: <count> related activities in <window>
Clone source: <canonical profile>
Graph position: <supervisor or root>
Changes after approval: <exact profile + graph mutations>
```

## Privacy and Safety Rules

- Keep the activity summary local unless the user explicitly requests export.
- Do not store raw prompts, transcript bodies, credentials, file contents, or
  provider responses in an advisor artifact.
- Do not infer a sensitive personal category as a bot recommendation.
- Do not recommend a profile that duplicates an existing capability without
  explaining the difference.
- A recommendation is not permission. Creation requires a separate approval.
- If profile inventory and graph state disagree, offer adoption or cloning
  explicitly; never repair the disagreement by recreating a profile.

## Verification

A run is complete only when the recommendation evidence is visible, the user
approved the exact mutation, the `clone_from` source is recorded, the profile
exists in Hermes, and the Fleetgraph readback shows the intended node without
unapproved topology changes.
