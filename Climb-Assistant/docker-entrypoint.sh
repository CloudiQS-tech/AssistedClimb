#!/bin/bash
# Runs pending database migrations, then starts the server (passed as "$@").
#
# The compiled server bundle (dist/index.mjs) is launched directly by the
# Dockerfile's CMD, bypassing npm/pnpm lifecycle hooks - so
# artifacts/api-server's "prestart" script (which normally runs migrations
# via `pnpm --filter @workspace/db run migrate`) never fires in this
# container. This entrypoint runs the same migration script directly so
# migrations are still applied before the server starts accepting traffic.
set -e

echo "Running database migrations..."
node /app/lib/db/scripts/run-migrations.mjs

echo "Migrations complete. Starting server..."
exec "$@"
