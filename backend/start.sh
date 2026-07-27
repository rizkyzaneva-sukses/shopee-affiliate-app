#!/bin/sh
# Run migrations before starting the app
node src/db-init.js 2>/dev/null || echo "[STARTUP] Migrations skipped (db-init error)"
exec node src/index.js
