# Figma MCP Server

An MCP (Model Context Protocol) server that allows AI assistants like Claude to create and manipulate Figma designs based on text prompts. This implementation uses a direct connection to a Figma plugin to provide real-time design capabilities.

## Features

- Create frames with specified dimensions
- Generate UI components based on descriptions
- Apply styling to existing design elements
- Generate complete designs from text prompts
- Export designs as images

## Architecture

This MCP server uses a plugin-based approach with three main components:

1. **MCP Server**: Handles communication with Claude and other MCP-compatible assistants
2. **Plugin Bridge**: Manages communication between the MCP server and the Figma plugin
3. **Figma Plugin**: Performs the actual design operations within Figma

This approach provides several advantages:
- Real-time design changes directly in the Figma UI
- Full access to Figma's plugin API capabilities
- Visual feedback as designs are created

## Installation

### Prerequisites

- Node.js 16 or higher
- Figma desktop application
- Figma plugin CLI (install with `npm install -g @figma/plugin-cli`)

### Setup

1. Clone this repository
2. Install dependencies:

```bash
npm install
```

3. Install the Figma plugin:
   - Open Figma
   - Go to Plugins > Development > Import plugin from manifest
   - Select the `figma-plugin/manifest.json` file from this repo

## Usage

### Running the server

1. Start Figma and open a file where you want to create designs
2. Run the Figma plugin from the Plugins menu
3. Start the MCP server:

```bash
npm start
```

### Connecting to Claude Desktop

1. In Claude Desktop, go to Preferences
2. Navigate to the Plugins section
3. Add a new plugin with the following configuration:
   - Name: Figma MCP
   - Command: `/path/to/node /path/to/index.js`
   - Make sure to use absolute paths

### Available Tools

The server provides the following tools:

1. **create_figma_frame**: Creates a new frame with specified dimensions
2. **create_figma_component**: Creates UI components from text descriptions
3. **style_figma_node**: Applies styling to existing nodes
4. **generate_figma_design**: Creates complete designs from text prompts
5. **export_figma_design**: Exports designs as images

### Prompt Templates

The server includes several preset prompt templates:

1. **create-website-design**: Creates a complete website design based on a description
2. **create-mobile-app**: Creates a mobile app interface with multiple screens
3. **design-component-system**: Creates a design system with consistent components

### Example Prompts

Try asking Claude:

- "Create a new frame for a mobile app home screen"
- "Generate a modern login form component with username and password fields"
- "Design a minimal dashboard layout for a financial app"
- "Export my current selection as a PNG image"

## Development

### Project Structure

```
/
├── index.ts              # Main MCP server
├── plugin-bridge.ts      # Communication with Figma plugin
├── figma-plugin/         # Figma plugin files
│   ├── manifest.json     # Plugin manifest
│   ├── code.ts           # Plugin code
│   └── ui.html           # Plugin UI
├── package.json          # Project configuration
└── README.md             # Documentation
```

### How It Works

1. The MCP server receives requests from Claude
2. These requests are translated to Figma plugin commands
3. The plugin bridge sends commands to the Figma plugin
4. The Figma plugin executes the commands in the Figma UI
5. Results are sent back through the plugin bridge to the MCP server
6. The MCP server returns the results to Claude

## Troubleshooting

- Make sure the Figma plugin is running before starting the MCP server
- Check that Figma has a document open for the plugin to work with
- If communication fails, try restarting both the plugin and the server

## License

MIT 