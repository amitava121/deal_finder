#!/bin/bash
set -e

echo "================================="
echo "  Persistent Tunnel Setup         "
echo "================================="
echo ""

TUNNEL_NAME="deal-finder"
TUNNEL_DIR="$HOME/.cloudflared"
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# Check cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "Installing cloudflared..."
    brew install cloudflared
fi

# Check if already logged in
if [ ! -f "$TUNNEL_DIR/cert.pem" ]; then
    echo "You need to authenticate cloudflared with your Cloudflare account."
    echo "Running: cloudflared tunnel login"
    echo ""
    cloudflared tunnel login
fi

# Create tunnel if it doesn't exist
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo "Tunnel '$TUNNEL_NAME' already exists."
else
    echo "Creating named tunnel: $TUNNEL_NAME"
    cloudflared tunnel create "$TUNNEL_NAME"
    echo "Tunnel created!"
fi

# Get tunnel UUID
TUNNEL_UUID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo ""
echo "Your tunnel UUID is: $TUNNEL_UUID"
echo ""

# Copy credentials to project
mkdir -p "$PROJECT_ROOT/.cloudflared"
CRED_FILE="$TUNNEL_DIR/$TUNNEL_UUID.json"
if [ -f "$CRED_FILE" ]; then
    cp "$CRED_FILE" "$PROJECT_ROOT/.cloudflared/"
    echo "Copied credentials to project"
fi

# Update config with real UUID
CONFIG_FILE="$PROJECT_ROOT/.cloudflared/config.yml"
if [ -f "$CONFIG_FILE" ]; then
    sed -i '' "s|<YOUR_TUNNEL_UUID>|$TUNNEL_UUID|g" "$CONFIG_FILE"
    echo "Updated config.yml with tunnel UUID"
fi

echo ""
echo "================================="
echo "  Next Steps                     "
echo "================================="
echo ""
echo "1. Buy a cheap domain (e.g., from Namecheap ~\$5/year)"
echo "   Suggested: yourname-deals.com, smart-deals.xyz, etc."
echo ""
echo "2. Add your domain to Cloudflare:"
echo "   - Go to dash.cloudflare.com"
echo "   - Add Site -> Enter your domain"
echo "   - Change nameservers at your registrar to Cloudflare's"
echo "   - Wait ~5 min for DNS to propagate"
echo ""
echo "3. Configure tunnel hostnames:"
echo "   - Cloudflare Dashboard -> Zero Trust -> Networks -> Tunnels"
echo "   - Click '$TUNNEL_NAME' -> Public Hostname tab"
echo "   - Add: deals.yourdomain.com -> http://localhost:8080"
echo "   - Add: api.yourdomain.com   -> http://localhost:8000"
echo ""
echo "4. Update config.yml with your domain:"
echo "   Edit: $CONFIG_FILE"
echo "   Replace 'yourdomain.com' with your actual domain"
echo ""
echo "5. Add your domain to Firebase ONCE:"
echo "   Firebase Console -> Authentication -> Settings"
echo "   -> Authorized domains -> Add: yourdomain.com"
echo ""
echo "6. Start the persistent tunnel:"
echo "   ./tunnel.sh persistent"
echo ""
echo "================================="
