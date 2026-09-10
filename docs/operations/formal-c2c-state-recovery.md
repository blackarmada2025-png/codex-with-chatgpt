# Formal C2C state recovery contract

The canonical state root is supplied through `C2C_STATE_DIR`. On Windows production it is `C:\\codex-c2c-test\\state`; AuthStore resolves to `auth\\<workspaceId>.json` and runtime identity resolves to `runtime\\<workspaceId>.json` below that root.

Before a deployment, restart, watchdog recovery, or rollback, preserve this state root. Do not create a replacement AuthStore. For host migration, restore a hash-verified copy of the state root before the first Gateway start, configure the installer with the same `C2CStateDir`, then verify the existing AuthStore hash and client/token counts. If the destination AuthStore already exists, stop and investigate; never overwrite it.

Rollback changes deployment binaries only. It retains the same `C2C_STATE_DIR`, so existing clients and tokens continue to resolve through the same registry.
