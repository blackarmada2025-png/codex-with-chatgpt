# Canonical Source Reconstruction V1

This branch is a new canonical source, rooted at Git commit
`6627921c26016f37fc4491856e5f771d819bd4b2`. It is not a claim to have
recovered the historical source of the active R3 artifact.

## Historical boundary

- `HISTORICAL_R3_SOURCE_COMMIT = UNKNOWN`
- The `c10739f` label was a removed worktree label, not a Git commit.
- R3 is retained only as a reference runtime artifact.

## R3 differential scope

Compared with this baseline, the R3 dist artifact differs in these runtime
areas: bridge server, CLI, MCP HTTP handler, daemon lifecycle, named/quick
tunnel handling, and workspace manager. The reconstruction does not attempt
byte-identical recovery. Each future behavior change must be justified by a
test or a separately recorded runtime observation.

## Deployment provenance contract

Every future deployment must retain a generated `artifacts/build-manifest.json`
linking the Git commit, lockfile hash, Node version, full dist hash manifest,
test result, deployment target, and the active PID readback. A deployment must
inherit its existing AuthStore; it must not create empty OAuth state or revoke
clients during cutover.
