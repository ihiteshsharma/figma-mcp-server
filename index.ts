#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  Prompt,
  PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import { 
  PluginBridge, 
  sendPluginCommand, 
  getCurrentSelection, 
  getCurrentPage,
  PluginCommand,
  PluginResponse
} from "./plugin-bridge.js";
import { initializePluginBridge } from "./plugin-bridge.js";

// Define result interfaces
interface FigmaNodeResult {
  id: string;
  name?: string;
  type?: string;
  [key: string]: any;
}

interface FigmaExportResult {
  exportUrl: string;
  format?: string;
  width?: number;
  height?: number;
}

// Define Figma design tools
const CREATE_FRAME_TOOL: Tool = {
  name: "create_figma_frame",
  description:
    "Creates a new frame in Figma with specified dimensions and properties. " +
    "Use this to start a new design or add a new screen to an existing design. " +
    "The frame will be created at the root level of the current page.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the frame"
      },
      width: {
        type: "number",
        description: "Width of the frame in pixels",
        default: 1920
      },
      height: {
        type: "number",
        description: "Height of the frame in pixels",
        default: 1080
      },
      background: {
        type: "string",
        description: "Background color (hex, rgba, or name)",
        default: "#FFFFFF"
      }
    },
    required: ["name"],
  },
};

const CREATE_COMPONENT_TOOL: Tool = {
  name: "create_figma_component",
  description:
    "Creates a UI component in Figma based on a text description. " +
    "Supports common UI elements like buttons, cards, forms, and navigation elements. " +
    "The component will be created inside the selected frame or at the root level if no frame is selected.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "Type of component to create",
        enum: ["button", "card", "input", "form", "navigation", "custom"]
      },
      description: {
        type: "string",
        description: "Detailed description of how the component should look and function"
      },
      style: {
        type: "string",
        description: "Visual style (e.g., 'modern', 'minimal', 'colorful')",
        default: "modern"
      },
      parentNodeId: {
        type: "string",
        description: "Node ID where the component should be created (optional, will use current selection if not provided)"
      }
    },
    required: ["type", "description"],
  },
};

const STYLE_DESIGN_TOOL: Tool = {
  name: "style_figma_node",
  description:
    "Applies visual styling to a selected Figma node or nodes. " +
    "Can set fills, strokes, effects, typography, and other styling properties. " +
    "Use this to update the appearance of existing elements. " +
    "Will style the currently selected elements if no nodeId is provided.",
  inputSchema: {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "ID of the node to style (optional, will use current selection if not provided)"
      },
      styleDescription: {
        type: "string",
        description: "Natural language description of the desired style"
      },
      fillColor: {
        type: "string",
        description: "Color for fills (hex, rgba, or name)",
      },
      strokeColor: {
        type: "string",
        description: "Color for strokes (hex, rgba, or name)",
      },
      textProperties: {
        type: "object",
        description: "Text styling properties if applicable"
      }
    },
    required: ["styleDescription"],
  },
};

const PROMPT_TO_DESIGN_TOOL: Tool = {
  name: "generate_figma_design",
  description:
    "Generates a complete Figma design based on a text prompt. " +
    "This is a high-level tool that interprets the prompt and creates appropriate frames, " +
    "components, and styling to match the description. " +
    "Ideal for quickly creating design mockups from a text description.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed description of the design to create"
      },
      type: {
        type: "string",
        description: "Type of design (e.g., 'website', 'mobile app', 'dashboard')",
        enum: ["website", "mobile app", "dashboard", "landing page", "form", "custom"]
      },
      style: {
        type: "string",
        description: "Design style (e.g., 'minimal', 'colorful', 'corporate')",
        default: "modern"
      }
    },
    required: ["prompt", "type"],
  },
};

const EXPORT_DESIGN_TOOL: Tool = {
  name: "export_figma_design",
  description:
    "Exports the current Figma design or selection as an image. " +
    "Allows exporting specific nodes or the entire page in various formats and scales.",
  inputSchema: {
    type: "object",
    properties: {
      nodeId: {
        type: "string",
        description: "ID of the node to export (optional, will use current selection if not provided)"
      },
      format: {
        type: "string",
        description: "Export format",
        enum: ["png", "jpg", "svg", "pdf"],
        default: "png"
      },
      scale: {
        type: "number",
        description: "Export scale (1x, 2x, etc.)",
        default: 1
      },
      includeBackground: {
        type: "boolean",
        description: "Whether to include background in the export",
        default: true
      }
    },
    required: [],
  },
};

// Define prompts
const PROMPTS = [
  {
    name: "create-website-design",
    description: "Create a complete website design based on a description",
    arguments: [
      {
        name: "description",
        description: "Detailed description of the website purpose and content",
        required: true
      },
      {
        name: "style",
        description: "Design style (e.g., 'minimal', 'colorful', 'corporate')",
        required: false
      }
    ]
  },
  {
    name: "create-mobile-app",
    description: "Create a mobile app interface with key screens",
    arguments: [
      {
        name: "purpose",
        description: "Purpose and main functionality of the app",
        required: true
      },
      {
        name: "screens",
        description: "List of screens to create (e.g., 'login, home, profile')",
        required: false
      }
    ]
  },
  {
    name: "design-component-system",
    description: "Create a design system with common components",
    arguments: [
      {
        name: "brandName",
        description: "Name of the brand",
        required: true
      },
      {
        name: "primaryColor",
        description: "Primary brand color (hex)",
        required: false
      }
    ]
  }
];

// Server implementation
const server = new Server(
  {
    name: "figma-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
    },
  },
);

// Initialize plugin bridge
let pluginBridge: PluginBridge;

async function initializePlugin() {
  try {
    // Get the plugin bridge instance and initialize it
    // Using real mode (false) instead of mock mode
    pluginBridge = await initializePluginBridge(server, false); // false = use real plugin mode
    
    // Connect the bridge to the server
    pluginBridge.connectToMCPServer(server);
    
    console.error("Figma plugin bridge initialized in REAL mode");
    console.error("Please ensure Figma desktop app is running with your plugin installed");
  } catch (error) {
    console.error("Failed to initialize Figma plugin bridge:", error);
    process.exit(1);
  }
}

// Type guards for tool arguments
function isCreateFrameArgs(args: unknown): args is { 
  name: string; 
      width?: number;
      height?: number;
  background?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "name" in args &&
    typeof (args as { name: string }).name === "string"
  );
}

function isCreateComponentArgs(args: unknown): args is { 
  type: string; 
  description: string; 
  style?: string; 
  parentNodeId?: string; 
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "type" in args &&
    typeof (args as { type: string }).type === "string" &&
    "description" in args &&
    typeof (args as { description: string }).description === "string"
  );
}

function isStyleNodeArgs(args: unknown): args is { 
  nodeId?: string; 
  styleDescription: string; 
  fillColor?: string; 
  strokeColor?: string;
  textProperties?: object;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "styleDescription" in args &&
    typeof (args as { styleDescription: string }).styleDescription === "string"
  );
}

function isGenerateDesignArgs(args: unknown): args is { 
  prompt: string; 
  type: string; 
  style?: string;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "prompt" in args &&
    typeof (args as { prompt: string }).prompt === "string" &&
    "type" in args &&
    typeof (args as { type: string }).type === "string"
  );
}

function isExportDesignArgs(args: unknown): args is { 
  nodeId?: string; 
  format?: string; 
  scale?: number;
  includeBackground?: boolean;
} {
  return (
    typeof args === "object" &&
    args !== null
  );
}

// Tool implementation functions
async function createFigmaFrame(name: string, width: number = 1920, height: number = 1080, background: string = "#FFFFFF"): Promise<string> {
  try {
    console.error(`Creating Figma frame: ${name} (${width}x${height})`);
    
    const command: PluginCommand = {
      type: 'CREATE_WIREFRAME',
      payload: {
        description: name,  // Using 'description' as expected by plugin
        pages: ['Home'],    // Define at least one page
        style: 'minimal',   // Default style
        dimensions: { width, height },
        designSystem: { background }
      },
      id: `frame_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to create frame');
    }
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    console.error("Error creating frame:", error);
    throw error;
  }
}

async function createFigmaComponent(
  type: string, 
  description: string, 
  style: string = "modern", 
  parentNodeId?: string
): Promise<string> {
  try {
    console.error(`Creating Figma component: ${type} - ${description}`);
    
    // Make sure we have a valid parent
    if (!parentNodeId) {
      // Get current selection to find a parent
      const selection = await getCurrentSelection();
      if (selection && selection.length > 0) {
        parentNodeId = selection[0].id;
      } else {
        // If no selection, get current page
        const page = await getCurrentPage();
        if (page && page.id) {
          parentNodeId = page.id;
        } else {
          throw new Error('No parent node available. Please select a frame or page first.');
        }
      }
    }
    
    // Map component type to element type expected by plugin
    let elementType = 'RECTANGLE'; // default
    switch (type.toLowerCase()) {
      case 'button': elementType = 'BUTTON'; break;
      case 'card': elementType = 'CARD'; break;
      case 'input': elementType = 'INPUT'; break;
      case 'form': elementType = 'FRAME'; break; // Custom frame for form
      case 'navigation': elementType = 'NAVBAR'; break;
      default: elementType = type.toUpperCase(); break;
    }
    
    const command: PluginCommand = {
      type: 'ADD_ELEMENT',
      payload: {
        elementType,
        parent: parentNodeId,
        properties: {
          name: `${type} - ${description.substring(0, 20)}...`,
          text: description,
          content: description,
          style: style
        }
      },
      id: `component_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to create component');
    }
    
    return typeof response.data === 'string' ? response.data : response.data?.id || 'unknown-id';
  } catch (error) {
    console.error("Error creating component:", error);
    throw error;
  }
}

async function styleFigmaNode(
  styleDescription: string,
  nodeId?: string,
  fillColor?: string,
  strokeColor?: string,
  textProperties?: object
): Promise<string> {
  try {
    console.error(`Styling Figma node: ${nodeId || 'current selection'}`);
    
    // If no node ID provided, get current selection
    if (!nodeId) {
      const selection = await getCurrentSelection();
      if (selection && selection.length > 0) {
        nodeId = selection[0].id;
      } else {
        throw new Error('No node selected to style');
      }
    }
    
    const command: PluginCommand = {
      type: 'STYLE_ELEMENT',
      payload: {
        elementId: nodeId,
        styles: {
          description: styleDescription,
          fill: fillColor,
          stroke: strokeColor,
          text: textProperties
        }
      },
      id: `style_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to style node');
    }
    
    return nodeId!;
  } catch (error) {
    console.error("Error styling node:", error);
    throw error;
  }
}

async function generateFigmaDesign(
  prompt: string,
  type: string,
  style: string = "modern"
): Promise<string> {
  try {
    console.error(`Generating Figma design from prompt: ${prompt}`);
    
    // For a complete design, we'll create a wireframe with multiple pages
    const pages = ['Home'];
    
    // Add more pages based on the design type
    if (type === 'website') {
      pages.push('About', 'Contact', 'Services');
    } else if (type === 'mobile app') {
      pages.push('Login', 'Profile', 'Settings');
    } else if (type === 'dashboard') {
      pages.push('Analytics', 'Reports', 'Settings');
    }
    
    const command: PluginCommand = {
      type: 'CREATE_WIREFRAME',
      payload: {
        description: prompt,
        pages: pages,
        style: style,
        designSystem: {
          type: type
        },
        dimensions: {
          width: type === 'mobile app' ? 375 : 1440,
          height: type === 'mobile app' ? 812 : 900
        }
      },
      id: `design_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to generate design');
    }
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    console.error("Error generating design:", error);
    throw error;
  }
}

async function exportFigmaDesign(
  nodeId?: string,
  format: string = "png",
  scale: number = 1,
  includeBackground: boolean = true
): Promise<string> {
  try {
    console.error(`Exporting Figma design: ${nodeId || 'current selection'}`);
    
    // If no node ID provided, use current selection
    let selection: string[] = [];
    if (!nodeId) {
      const selectionResult = await getCurrentSelection();
      if (selectionResult && selectionResult.length > 0) {
        selection = selectionResult.map(node => node.id);
      }
    } else {
      selection = [nodeId];
    }
    
    const command: PluginCommand = {
      type: 'EXPORT_DESIGN',
      payload: {
        selection: selection,
        settings: {
          format: format.toUpperCase(),
          constraint: {
            type: 'SCALE',
            value: scale
          },
          includeBackground
        }
      },
      id: `export_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      throw new Error(response.error || 'Failed to export design');
    }
    
    // Return the first file URL or a placeholder
    if (response.data?.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      const fileName = typeof file.name === 'string' ? file.name : 'file';
      const fileFormat = typeof file.format === 'string' ? file.format : format;
      return `Exported ${fileName} as ${fileFormat} (data available in base64)`;
    }
    
    return 'Export completed but no files returned';
  } catch (error) {
    console.error("Error exporting design:", error);
    throw error;
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [CREATE_FRAME_TOOL, CREATE_COMPONENT_TOOL, STYLE_DESIGN_TOOL, PROMPT_TO_DESIGN_TOOL, EXPORT_DESIGN_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    if (!args) {
      throw new Error("No arguments provided");
    }

    switch (name) {
      case "create_figma_frame": {
        if (!isCreateFrameArgs(args)) {
          throw new Error("Invalid arguments for create_figma_frame");
        }
        const { name, width = 1920, height = 1080, background = "#FFFFFF" } = args;
        
        try {
          const frameId = await createFigmaFrame(name, width, height, background);
        return {
            content: [{ 
              type: "text", 
              text: `Successfully created frame "${name}" (${width}x${height}) with ID: ${frameId}` 
            }],
          isError: false,
        };
        } catch (error) {
        return {
            content: [{ 
              type: "text", 
              text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}` 
            }],
            isError: true,
          };
        }
      }

      case "create_figma_component": {
        if (!isCreateComponentArgs(args)) {
          throw new Error("Invalid arguments for create_figma_component");
        }
        const { type, description, style = "modern", parentNodeId } = args;
        
        try {
          const componentId = await createFigmaComponent(type, description, style, parentNodeId);
        return {
            content: [{ 
              type: "text", 
              text: `Successfully created ${type} component with ID: ${componentId}` 
            }],
          isError: false,
        };
        } catch (error) {
        return {
            content: [{ 
              type: "text", 
              text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` 
            }],
            isError: true,
          };
        }
      }

      case "style_figma_node": {
        if (!isStyleNodeArgs(args)) {
          throw new Error("Invalid arguments for style_figma_node");
        }
        const { nodeId, styleDescription, fillColor, strokeColor, textProperties } = args;
        
        try {
          const styledNodeId = await styleFigmaNode(styleDescription, nodeId, fillColor, strokeColor, textProperties);
        return {
            content: [{ 
              type: "text", 
              text: `Successfully styled node with ID: ${styledNodeId}` 
            }],
          isError: false,
        };
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `Error styling node: ${error instanceof Error ? error.message : String(error)}` 
            }],
            isError: true,
          };
        }
      }

      case "generate_figma_design": {
        if (!isGenerateDesignArgs(args)) {
          throw new Error("Invalid arguments for generate_figma_design");
        }
        const { prompt, type, style = "modern" } = args;
        
        try {
          const designId = await generateFigmaDesign(prompt, type, style);
        return {
            content: [{ 
              type: "text", 
              text: `Successfully generated ${type} design based on prompt with root frame ID: ${designId}` 
            }],
          isError: false,
        };
        } catch (error) {
        return {
            content: [{ 
              type: "text", 
              text: `Error generating design: ${error instanceof Error ? error.message : String(error)}` 
            }],
            isError: true,
          };
        }
      }

      case "export_figma_design": {
        if (!isExportDesignArgs(args)) {
          throw new Error("Invalid arguments for export_figma_design");
        }
        const { nodeId, format = "png", scale = 1, includeBackground = true } = args;
        
        try {
          const exportUrl = await exportFigmaDesign(nodeId, format, scale, includeBackground);
        return {
            content: [{ 
              type: "text", 
              text: `Successfully exported design: ${exportUrl}` 
            }],
          isError: false,
        };
        } catch (error) {
          return {
            content: [{ 
              type: "text", 
              text: `Error exporting design: ${error instanceof Error ? error.message : String(error)}` 
            }],
            isError: true,
          };
        }
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

// Prompt handlers
server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PROMPTS
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  switch (name) {
    case "create-website-design": {
      const description = args?.description || "";
      const style = args?.style || "modern";
      
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Create a website design with the following details:\n\nDescription: ${description}\nStyle: ${style}\n\nPlease generate a clean, professional design that includes navigation, hero section, content blocks, and footer.`
            }
          }
        ]
      };
    }
    
    case "create-mobile-app": {
      const purpose = args?.purpose || "";
      const screens = args?.screens || "login, home, profile, settings";
      
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Design a mobile app with the following purpose: ${purpose}\n\nPlease create these screens: ${screens}\n\nEnsure the design is mobile-friendly with appropriate UI elements and navigation patterns.`
            }
          }
        ]
      };
    }
    
    case "design-component-system": {
      const brandName = args?.brandName || "";
      const primaryColor = args?.primaryColor || "#4285F4";
      
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Create a design system for ${brandName} with primary color ${primaryColor}.\n\nPlease include:\n- Color palette (primary, secondary, neutrals)\n- Typography scale\n- Button states\n- Form elements\n- Cards and containers`
            }
          }
        ]
      };
    }
    
    default:
      throw new Error(`Prompt not found: ${name}`);
  }
});

async function runServer() {
  try {
    console.error("Starting Figma MCP Server...");
    
    // First, set up the server transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("MCP Server connected to stdio transport");
    
    // Then initialize the plugin bridge
    await initializePlugin();
    
    console.error("Figma MCP Server running and ready to accept commands");
    
    // Log information about available tools
    console.error(`Available tools: ${[
      CREATE_FRAME_TOOL.name,
      CREATE_COMPONENT_TOOL.name, 
      STYLE_DESIGN_TOOL.name, 
      PROMPT_TO_DESIGN_TOOL.name, 
      EXPORT_DESIGN_TOOL.name
    ].join(', ')}`);
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.error('Shutting down Figma MCP server...');
  if (pluginBridge) {
    pluginBridge.shutdown();
  }
  process.exit(0);
});

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
