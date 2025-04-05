FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Compile TypeScript files
RUN npx tsc index.ts plugin-bridge.ts --skipLibCheck --module NodeNext --moduleResolution NodeNext

# Set environment variables
ENV NODE_ENV=production
ENV USE_MOCK_MODE=true
ENV DEBUG=false
ENV WS_PORT=9000
ENV WS_HOST=0.0.0.0

# Expose port for WebSocket connections
EXPOSE 9000

# The container needs to stay running and handle stdin properly for StdioServerTransport
# Check if WEBSOCKET_MODE is enabled, if so run with --real flag
ENTRYPOINT ["/bin/sh", "-c", "if [ \"$WEBSOCKET_MODE\" = \"true\" ]; then node index.js --real; else cat | node index.js; fi"]

# Make sure the container knows it should be interactive
STOPSIGNAL SIGINT