#!/bin/bash

# SmartDeals Full-Stack Launcher
# Usage: ./start.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Paths
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_ROOT/backend/deal-finder-mvp-api"
FRONTEND_DIR="$PROJECT_ROOT/frontend/smart-deal-finder"
VENV_DIR="$BACKEND_DIR/venv"

BACKEND_PORT=8000
FRONTEND_PORT=8080

echo -e "${BLUE}=================================${NC}"
echo -e "${BLUE}  SmartDeals - Full Stack Start  ${NC}"
echo -e "${BLUE}=================================${NC}"

# ==========================
# 1. Kill existing processes on ports
# ==========================
echo -e "\n${YELLOW}[1/5] Cleaning ports $BACKEND_PORT and $FRONTEND_PORT...${NC}"

# Kill anything on backend port
lsof -ti tcp:$BACKEND_PORT | xargs kill -9 2>/dev/null || true
# Kill anything on frontend port
lsof -ti tcp:$FRONTEND_PORT | xargs kill -9 2>/dev/null || true

echo -e "${GREEN}Ports cleaned.${NC}"

# ==========================
# 2. Setup Python venv (create if missing)
# ==========================
echo -e "\n${YELLOW}[2/5] Setting up Python virtual environment...${NC}"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating venv at $VENV_DIR..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# Only install requirements if requirements.txt changed or marker missing
REQ_MARKER="$VENV_DIR/.requirements_installed"
REQ_HASH=$(md5 -q "$BACKEND_DIR/requirements.txt" 2>/dev/null || md5sum "$BACKEND_DIR/requirements.txt" | awk '{print $1}')

if [ ! -f "$REQ_MARKER" ] || [ "$(cat "$REQ_MARKER")" != "$REQ_HASH" ]; then
    echo "Installing/updating backend dependencies..."
    pip install -q --upgrade pip
    pip install -q -r "$BACKEND_DIR/requirements.txt"
    echo "$REQ_HASH" > "$REQ_MARKER"
    echo -e "${GREEN}Backend dependencies installed.${NC}"
else
    echo -e "${GREEN}Backend dependencies already up to date (skipping install).${NC}"
fi

# ==========================
# 3. Start Backend (Uvicorn)
# ==========================
echo -e "\n${YELLOW}[3/5] Starting Backend on port $BACKEND_PORT...${NC}"

cd "$BACKEND_DIR"
nohup python3 -m uvicorn main:app --host 127.0.0.1 --port $BACKEND_PORT > "$PROJECT_ROOT/backend.log" 2>&1 &
BACKEND_PID=$!

echo -e "${GREEN}Backend started (PID: $BACKEND_PID). Logs: $PROJECT_ROOT/backend.log${NC}"

# Wait briefly for backend to be ready
sleep 2

# ==========================
# 4. Start Frontend (HTTP Server)
# ==========================
echo -e "\n${YELLOW}[4/5] Starting Frontend on port $FRONTEND_PORT...${NC}"

cd "$FRONTEND_DIR"
# Use custom no-cache server to prevent Chrome caching issues
if [ -f "$FRONTEND_DIR/serve.py" ]; then
    nohup python3 "$FRONTEND_DIR/serve.py" > "$PROJECT_ROOT/frontend.log" 2>&1 &
else
    nohup python3 -m http.server $FRONTEND_PORT --bind 127.0.0.1 > "$PROJECT_ROOT/frontend.log" 2>&1 &
fi
FRONTEND_PID=$!

echo -e "${GREEN}Frontend started (PID: $FRONTEND_PID). Logs: $PROJECT_ROOT/frontend.log${NC}"

# Wait briefly for frontend to be ready
sleep 1

# ==========================
# 5. Health Check & Summary
# ==========================
echo -e "\n${YELLOW}[5/5] Running health checks...${NC}"

BACKEND_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$BACKEND_PORT/" || echo "000")
FRONTEND_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$FRONTEND_PORT/" || echo "000")

echo -e "\n${GREEN}=================================${NC}"
echo -e "${GREEN}  All Systems Operational!       ${NC}"
echo -e "${GREEN}=================================${NC}"
echo ""
echo "  Backend:  http://127.0.0.1:$BACKEND_PORT/  (Status: $BACKEND_HEALTH)"
echo "  Frontend: http://127.0.0.1:$FRONTEND_PORT/  (Status: $FRONTEND_HEALTH)"
echo ""
echo "  Backend PID:  $BACKEND_PID"
echo "  Frontend PID: $FRONTEND_PID"
echo ""
echo "  Logs:"
echo "    Backend:  $PROJECT_ROOT/backend.log"
echo "    Frontend: $PROJECT_ROOT/frontend.log"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop both servers.${NC}"
echo ""

# Keep script alive until Ctrl+C
trap 'echo -e "\n${RED}Stopping servers...${NC}"; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null || true; exit 0' INT
wait
