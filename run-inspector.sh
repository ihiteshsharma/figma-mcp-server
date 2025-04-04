#!/bin/bash

# Build and start the server in background
npm run build
node dist/index.js &
SERVER_PID=$!

# Cleanup on exit
trap "kill $SERVER_PID" EXIT

# Give the server some time to start
sleep 2

# Open browser to localhost:3000 (or whatever port your server uses)
open http://localhost:3000

# Keep script running until user presses Ctrl+C
echo "Server running at http://localhost:3000"
echo "Press Ctrl+C to stop"
wait $SERVER_PID 