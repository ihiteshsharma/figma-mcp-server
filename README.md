# Figma MCP Server

A tool that lets Claude create and edit designs directly in Figma.

## What This Does

This tool connects Claude with Figma, allowing you to:

- Create new Figma designs by describing them to Claude
- Edit existing Figma designs with simple instructions
- Generate complete wireframes and UI elements
- Export your designs

## How It Works

1. **Claude**: Understands your design requests
2. **Figma Plugin**: Creates the designs in Figma
3. **Server**: Connects Claude to Figma (runs automatically)

## Quick Start Guide

### For Users

1. **Install the Figma Plugin**:
   - Open Figma Desktop app
   - Go to Plugins > Development > Import plugin from manifest
   - Select the `figma-plugin/manifest.json` file from this project

2. **Configure Figma MCP Server in Claude config**:
   - Check where MCP Config json is located on your system. This may depend on your operating system.
   - Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
         "figma": {
         "command": "docker",
            "args": [
               "run",
               "-i",
               "-p",
               "9000:9000",
               "--rm",
               "mcp/hs-figma"
            ],
            "env": {
               "NODE_ENV": "production",
               "WEBSOCKET_MODE": "true",
               "WS_PORT": "9000"
            }
         }
     }
   }

2. **Use with Claude**:
   - Open Claude
   - The Figma tool should appear in Claude's tools menu
   - Ask Claude to create designs in Figma, like:
     - "Create a login screen in Figma"
     - "Design a blue button with rounded corners in Figma"
     - "Make a simple landing page layout in Figma"

### For Technical Setup (IT/Developers)

<details>
<summary>Click to expand technical setup instructions</summary>

#### Prerequisites

- Node.js (>= 16)
- npm
- Docker (installed on the machine running Claude)
- Figma Desktop app

#### Installation

1. **Clone and Install**:
   ```
   git clone <repository-url>
   cd figma-mcp-server
   npm install
   ```

2. **Build**:
   ```
   npm run build
   npm run build:figma-plugin
   ```

3. **Build Docker Image & Figma Plugin**:
   ```
   docker build -t mcp/hs-figma .
   
   npm run build:figma-plugin
   ```

4. **Configure Claude**:
   Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:
   ```json
   {
     "mcpServers": {
         "figma": {
         "command": "docker",
            "args": [
               "run",
               "-i",
               "-p",
               "9000:9000",
               "--rm",
               "mcp/hs-figma"
            ],
            "env": {
               "NODE_ENV": "production",
               "WEBSOCKET_MODE": "true",
               "WS_PORT": "9000"
            }
         }
     }
   }
   ```
   
   Once this configuration is added, Claude will automatically start the server when needed.
</details>

## Design Capabilities

You can ask Claude to:

- Create rectangles, circles, text, and frames
- Design buttons, cards, and other UI components
- Arrange layouts for web pages and apps
- Style elements with colors, shadows, and effects
- Export designs as images

## Troubleshooting

### Common Issues

1. **Claude can't connect to Figma**
   - Make sure the Figma plugin is running
   - Make sure you've correctly set up the Claude configuration file
   - Restart Claude and try again

2. **Shapes don't appear as expected**
   - Try being more specific in your instructions to Claude
   - For colors, use common names like "blue" or hex codes like "#0000FF"

3. **Plugin not working**
   - Make sure you've opened a Figma file
   - Reinstall the plugin if needed

For technical troubleshooting, see the "Technical Issues" section below.

<details>
<summary>Technical Issues</summary>

1. **WebSocket Connection Failure**
   - Check that port 9000 is not blocked by firewalls
   - Verify WS_PORT setting in both server and plugin configurations

2. **Plugin Loading Issues**
   - Ensure TypeScript files are compiled correctly
   - Check console errors in Figma's developer tools

3. **Color Format Issues**
   - Color objects should use opacity instead of alpha ('a') property
</details>

## Examples

Try asking Claude:

- "Create a simple app homepage in Figma with a header, hero section, and footer"
- "Design a user profile card with an avatar, name, and bio in Figma"
- "Make a set of navigation buttons in Figma"

## License

MIT 