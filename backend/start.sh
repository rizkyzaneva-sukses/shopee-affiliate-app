#!/bin/sh
# Run migrations before starting the app
# Errors stay visible in the log; the app still starts so a DB hiccup
# does not take the dashboard down.
node src/db-init.js || echo "[STARTUP] Migrasi GAGAL — lihat error [DB-INIT] di atas"
exec node src/index.js
