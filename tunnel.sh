#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_PORT=8000
FRONTEND_PORT=8080

# Config paths
TUNNEL_DIR="$PROJECT_ROOT/.cloudflared"
TUNNEL_CONFIG="$TUNNEL_DIR/config.yml"
TUNNEL_NAME="deal-finder"

# Usage helper
usage() {
    cat <<EOF
Usage: $0 [MODE]

Modes:
  quick      Start temporary tunnels with random URLs (default)
             URLs change every time. You must update Firebase each time.

  persistent Start a named tunnel with stable URLs
             Requires a one-time setup. URL never changes.

Setup persistent tunnel:
  1. Buy a domain (Namecheap ~\$5/year, or any registrar)
  2. Point domain nameservers to Cloudflare (free)
  3. Run: cloudflared tunnel create $TUNNEL_NAME
  4. Copy the tunnel UUID into $TUNNEL_CONFIG
  5. Add Public Hostnames in Cloudflare Dashboard:
       deals.yourdomain.com  -> http://localhost:$FRONTEND_PORT
       api.yourdomain.com    -> http://localhost:$BACKEND_PORT
  6. Add your domain to Firebase Authorized Domains once
  7. Run: ./tunnel.sh persistent

EOF
    exit 0
}

MODE="${1:-quick}"

if [ "$MODE" == "--help" ] || [ "$MODE" == "-h" ]; then
    usage
fi

echo "================================="
echo "  Cloudflare Tunnel - Share Dev  "
echo "  Mode: $MODE"
echo "================================="
echo ""

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "cloudflared not found. Installing..."
    brew install cloudflared
fi

# ============================================================
# PERSISTENT MODE (named tunnel + custom domain)
# ============================================================
if [ "$MODE" == "persistent" ]; then
    if [ ! -f "$TUNNEL_CONFIG" ]; then
        echo "ERROR: Tunnel config not found at $TUNNEL_CONFIG"
        echo "Run first: cloudflared tunnel create $TUNNEL_NAME"
        echo "See ./tunnel.sh --help for setup steps"
        exit 1
    fi

    # Check if config has been edited
    if grep -q "<YOUR_TUNNEL_UUID>" "$TUNNEL_CONFIG"; then
        echo "ERROR: Please edit $TUNNEL_CONFIG first"
        echo "Replace <YOUR_TUNNEL_UUID> with your actual tunnel UUID"
        echo "Replace yourdomain.com with your real domain"
        exit 1
    fi

    echo "[1/2] Starting named tunnel: $TUNNEL_NAME"
    echo "      Reading config from $TUNNEL_CONFIG"
    cloudflared tunnel run "$TUNNEL_NAME" --config "$TUNNEL_CONFIG" &
    TUNNEL_PID=$!

    echo ""
    echo "================================="
    echo "  Named tunnel is running!       "
    echo "================================="
    echo ""
    echo "  Make sure these are configured:"
    echo "    deals.yourdomain.com -> http://localhost:$FRONTEND_PORT"
    echo "    api.yourdomain.com   -> http://localhost:$BACKEND_PORT"
    echo ""
    echo "  Add 'yourdomain.com' to Firebase Authorized Domains ONCE"
    echo ""
    echo "  Press Ctrl+C to stop"
    echo "================================="

    trap '
        echo ""
        echo "Stopping named tunnel..."
        kill $TUNNEL_PID 2>/dev/null
        echo "Stopped."
        exit 0
    ' INT

    wait $TUNNEL_PID
    exit 0
fi

# ============================================================
# QUICK MODE (temporary random URLs)
# ============================================================
if [ "$MODE" != "quick" ]; then
    echo "Unknown mode: $MODE"
    usage
fi

# Start backend tunnel in background
echo "[1/3] Starting backend tunnel (port $BACKEND_PORT)..."
nohup cloudflared tunnel --url "http://localhost:$BACKEND_PORT" > "$PROJECT_ROOT/tunnel-backend.log" 2>&1 &
BACKEND_TUNNEL_PID=$!

# Wait for URL
echo "    Waiting for backend URL..."
for i in {1..30}; do
    BACKEND_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$PROJECT_ROOT/tunnel-backend.log" | head -1)
    if [ -n "$BACKEND_URL" ]; then
        break
    fi
    sleep 1
done

if [ -z "$BACKEND_URL" ]; then
    echo "ERROR: Backend tunnel failed to start"
    cat "$PROJECT_ROOT/tunnel-backend.log"
    exit 1
fi

echo "    Backend: $BACKEND_URL"

# Update frontend API_BASE
echo "[2/3] Updating frontend to use backend tunnel..."
FRONTEND_SCRIPT="$PROJECT_ROOT/frontend/smart-deal-finder/script.js"
if [ -f "$FRONTEND_SCRIPT" ]; then
    sed -i '' "s|return isLocal ? \"http://127.0.0.1:8000\" : \"[^\"]*\";|return isLocal ? \"http://127.0.0.1:8000\" : \"$BACKEND_URL\";|" "$FRONTEND_SCRIPT"
    echo "    API_BASE updated: $BACKEND_URL"
else
    echo "    WARNING: script.js not found at $FRONTEND_SCRIPT"
fi

# Start frontend tunnel in background
echo "[3/3] Starting frontend tunnel (port $FRONTEND_PORT)..."
nohup cloudflared tunnel --url "http://localhost:$FRONTEND_PORT" > "$PROJECT_ROOT/tunnel-frontend.log" 2>&1 &
FRONTEND_TUNNEL_PID=$!

# Wait for URL
echo "    Waiting for frontend URL..."
for i in {1..30}; do
    FRONTEND_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$PROJECT_ROOT/tunnel-frontend.log" | head -1)
    if [ -n "$FRONTEND_URL" ]; then
        break
    fi
    sleep 1
done

if [ -z "$FRONTEND_URL" ]; then
    echo "ERROR: Frontend tunnel failed to start"
    cat "$PROJECT_ROOT/tunnel-frontend.log"
    exit 1
fi

echo ""
echo "================================="
echo "  Tunnels Active!               "
echo "  URLs change every restart!   "
echo "================================="
echo ""
echo "  Send your friend this link:"
echo ""
echo "  $FRONTEND_URL"
echo ""
echo "  Backend API: $BACKEND_URL"
echo ""
echo "  Add this to Firebase Console:"
echo "    -> Authentication -> Settings -> Authorized domains"
echo "    -> Add: $FRONTEND_URL"
echo ""
echo "  Press Ctrl+C to stop tunnels"
echo "================================="

# Save PIDs for cleanup
echo "$BACKEND_TUNNEL_PID" > "$PROJECT_ROOT/tunnel-backend.pid"
echo "$FRONTEND_TUNNEL_PID" > "$PROJECT_ROOT/tunnel-frontend.pid"

# Wait for interrupt
trap "
    echo ''
    echo 'Stopping tunnels...'
    kill \$(cat '$PROJECT_ROOT/tunnel-backend.pid') 2>/dev/null
    kill \$(cat '$PROJECT_ROOT/tunnel-frontend.pid') 2>/dev/null
    rm -f '$PROJECT_ROOT/tunnel-backend.pid' '$PROJECT_ROOT/tunnel-frontend.pid'
    echo 'Tunnels stopped.'
    exit 0
" INT

while true; do
    sleep 1
done
