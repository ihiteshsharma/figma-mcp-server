#!/bin/bash
set -e

# Build the Docker image
echo "Building Figma MCP Server Docker image..."
docker build -t mcp/hs-figma .

echo ""
echo "==================================================="
echo "Docker image 'mcp/hs-figma' built successfully!"
echo "==================================================="
echo ""
echo "To connect Claude to this MCP server via stdio:"
echo ""
echo "1. Keep this terminal open"
echo "2. In Claude, open the MCP Inspector"
echo "3. Set transport to 'Stdio'"
echo "4. Set command to: docker"
echo "5. Set arguments to: run -i --rm mcp/hs-figma"
echo "6. Click 'Connect'"
echo ""
echo "To run with WebSocket support for real Figma plugin communication:"
echo ""
echo "docker run -p 9000:9000 -e WEBSOCKET_MODE=true --rm mcp/hs-figma"
echo ""
echo "Then connect from the Figma plugin UI using the WebSocket URL:"
echo "ws://localhost:9000"
echo ""
echo "The following command can also be used to test the server directly:"
echo "docker run -i --rm mcp/hs-figma"
echo ""
