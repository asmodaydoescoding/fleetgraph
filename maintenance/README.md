# Fleet Graph Maintenance

Operational tooling that closes two documented v0.6.1 known limitations:

## `fleet-maint prune` — profile-deletion cleanup

Deleting a Hermes profile used to leave stale entries in `fleet_graph.yaml`,
peer relations, inboxes, and read watermarks forever. `prune` removes every
trace of a deleted profile in one atomic topology write.

```bash
python3 maintenance/fleet_maint.py prune --dry-run   # see what would go
python3 maintenance/fleet_maint.py prune             # do it
```

- Auto-detects stale nodes (graph nodes whose canonical profile no longer
  exists on disk), or target specific ones with `--profile NAME` (repeatable).
- Strips pruned nodes from supervisors' `subordinates` lists and both sides
  of peer relations before saving through `fleet_graph_core.save_graph`, so
  all validation and atomic-rename guarantees are inherited.
- Cleans up `<profile>.jsonl` inboxes and `.read/` watermarks.
- The default profile can never be pruned; unknown targets are refused.

## `fleet-maint rotate` — inbox capping

Inbox JSONL files grew unboundedly. `rotate` caps each inbox at
`FLEET_INBOX_MAX` (default 500) newest messages with an atomic temp-file
rename, and clamps each read watermark so unread badges stay correct.

```bash
python3 maintenance/fleet_maint.py rotate --dry-run
python3 maintenance/fleet_maint.py rotate --keep 200
```

Malformed (non-JSON) lines are purged during rotation even when the file is
under cap. Rotation is idempotent.

## `fleet-maint status` — health snapshot

Read-only: stale profiles, per-inbox sizes, over-cap flags.

```bash
python3 maintenance/fleet_maint.py status
```

## Tests

Hermetic, same conventions as `tests/public_integration_test.py`
(temp-dir storage redirection before core import):

```bash
python3 maintenance/test_fleet_maint.py
# expect: MAINT SUMMARY: 24 passed, 0 failed
```

## Environment

Honors the documented fleet-graph overrides: `FLEET_HOME`,
`FLEET_GRAPH_PATH`, `FLEET_INBOX_DIR`, `FLEET_PROFILES_DIR`, plus a new
`FLEET_INBOX_MAX` (rotation cap, default 500).
