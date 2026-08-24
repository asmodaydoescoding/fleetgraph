# Starfleet Complement

An optional Fleetgraph starter topology based on the fleet proposed in
[Fleetgraph PR #5](https://github.com/asmodaydoescoding/fleetgraph/pull/5).
It contains a 75-node command structure covering command, sciences,
engineering, security/nightwatch, medical/counsel, red-team review, and
legal/ethics.

## Attribution

The profile personas come from Teknium's MIT-licensed
[Hermes Star Trek Profiles](https://github.com/teknium1/hermes-star-trek-profiles)
collection.

The Fleetgraph topology was assembled and contributed by
[Baal-TehDriverman (@TheDriverMan)](https://github.com/TheDriverMan) in
[PR #5](https://github.com/asmodaydoescoding/fleetgraph/pull/5).

See `ATTRIBUTION.md` for the complete notice.

## Install safely

This pack is data only. It does not execute the upstream profile installer.

1. Install or obtain the source profiles separately from the upstream MIT
   repository.
2. Back up the current Fleetgraph topology.
3. Preview `fleet_graph.example.yaml` and select the departments you want.
4. Apply it through Fleetgraph's reviewed graph-save flow.
5. Reconcile any missing profiles as roots before connecting them.

The topology is intentionally optional. It should never overwrite a user's
existing graph or create profiles without explicit approval.

## Included structure

- High Command and Staff/Core
- Sciences
- Engineering
- Security / Nightwatch
- Medical & Counsel
- Command School advisors
- Red Team / Illumination Directorate
- Legal & Ethics

The source profile collection and this topology are separate artifacts: a
profile can be installed without adopting the topology, and the topology can
be previewed before any profile is created or wired.
