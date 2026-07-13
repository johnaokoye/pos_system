#!/bin/sh
set -e

# ./data and ./uploads are bind-mounted from the host and may not exist yet
# on a fresh deploy — Docker auto-creates them owned by root, which the
# non-root `app` user can't write to (SQLITE_CANTOPEN on pos.db). Fix
# ownership here, while still root, then drop to `app` for the real process.
chown -R app:app /app/data /app/uploads

exec su-exec app "$@"
