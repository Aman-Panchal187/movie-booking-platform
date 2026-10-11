#!/bin/sh
# Production entrypoint: runs Nginx (public, $PORT) and Express (127.0.0.1:3000) in one container.
# If EITHER process dies the container exits non-zero so the platform restarts it; SIGTERM is forwarded
# to both for a graceful shutdown.
set -eu

export PORT="${PORT:-10000}"
export UPSTREAM="127.0.0.1:3000"

envsubst '${PORT} ${UPSTREAM}' < /etc/nginx/templates/default.conf.template > /etc/nginx/http.d/default.conf
rm -f /etc/nginx/http.d/default.conf.apk-new
nginx -t

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node dist/scripts/migrate.js
fi

# Optional one-time bootstrap from environment (both are idempotent and safe on every restart).
if [ -n "${ADMIN_EMAIL:-}" ] && [ -n "${ADMIN_PASSWORD:-}" ]; then
  node dist/scripts/createAdmin.js || echo "admin bootstrap failed" >&2
fi
if [ "${RUN_SEED:-false}" = "true" ]; then
  # Runs in the background so the API is reachable immediately; historical demo data can take minutes on a remote DB.
  (node dist/scripts/seed.js || echo "seed failed" >&2) &
fi

HOST=127.0.0.1 PORT=3000 node dist/server.js &
NODE_PID=$!
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
  kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
  wait "$NODE_PID" 2>/dev/null || true
  wait "$NGINX_PID" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

while kill -0 "$NODE_PID" 2>/dev/null && kill -0 "$NGINX_PID" 2>/dev/null; do
  sleep 2 &
  wait $! || true
done

echo "a critical process exited (node=$NODE_PID nginx=$NGINX_PID); stopping container" >&2
kill -TERM "$NODE_PID" "$NGINX_PID" 2>/dev/null || true
exit 1
