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
  ProgressNotificationSchema
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
import * as path from 'path';
import * as fs from 'fs';

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

// Define logging utilities for structured JSON logs
interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  context?: any;
  error?: {
    message: string;
    stack?: string;
  };
}

// Logger utility that outputs structured JSON
class Logger {
  private serviceName: string;
  private startTime: number;
  private debugMode: boolean;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.startTime = Date.now();
    this.debugMode = process.env.DEBUG === 'true';
  }

  private formatLog(level: LogEntry['level'], message: string, context?: any, error?: Error): string {
    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    // Add service metadata
    const metadata = {
      service: this.serviceName,
      uptime: (Date.now() - this.startTime) / 1000,
      pid: process.pid
    };

    // Add context if provided
    if (context) {
      logEntry.context = context;
    }

    // Add error details if provided
    if (error) {
      logEntry.error = {
        message: error.message
      };
      
      // Only add stack in non-production environments
      if (process.env.NODE_ENV !== 'production') {
        logEntry.error.stack = error.stack;
      }
    }

    // Return as JSON string with metadata
    return JSON.stringify({ ...logEntry, ...metadata });
  }

  // Write logs to another file descriptor to avoid interfering with StdioServerTransport
  private writeLog(logString: string): void {
    // In Docker/container environments, we want to write to a separate FD
    // or use process.stderr with a prefix that can be filtered
    
    // Option 1: Write to process.stderr with a prefix
    process.stderr.write(`FIGMA_MCP_LOG: ${logString}\n`);
    
    // Option 2: If in debug mode, also write to console for local development
    if (this.debugMode && process.env.NODE_ENV !== 'production') {
      console.log(`DEBUG LOG: ${logString}`);
    }
  }

  info(message: string, context?: any): void {
    this.writeLog(this.formatLog('info', message, context));
  }

  warn(message: string, context?: any, error?: Error): void {
    this.writeLog(this.formatLog('warn', message, context, error));
  }

  error(message: string, error?: Error, context?: any): void {
    this.writeLog(this.formatLog('error', message, context, error));
  }

  debug(message: string, context?: any): void {
    // Only log debug in non-production environments or when debug mode is enabled
    if (process.env.NODE_ENV !== 'production' || this.debugMode) {
      this.writeLog(this.formatLog('debug', message, context));
    }
  }
}

// Create logger instance
const logger = new Logger('figma-mcp-server');

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

// Parse command line arguments
const args = process.argv.slice(2);
const useRealMode = args.includes('--real') || args.includes('-r') || process.env.WEBSOCKET_MODE === 'true';
const wsPort = parseInt(process.env.WS_PORT || '9000', 10);
const wsHost = process.env.WS_HOST || '0.0.0.0';

// Initialize the plugin bridge with real or mock mode
async function initializePlugin() {
  try {
    logger.info(`Initializing plugin bridge in ${useRealMode ? 'real' : 'mock'} mode`);
    
    if (useRealMode) {
      logger.info(`Starting WebSocket server on ${wsHost}:${wsPort}`);
    }
    
    const plugin = await initializePluginBridge(null, !useRealMode, wsPort);
    
    // Add shutdown handler
    process.on('SIGINT', () => {
      logger.info('Shutting down plugin bridge...');
      plugin.shutdown();
      process.exit(0);
    });
    
    process.on('SIGTERM', () => {
      logger.info('Shutting down plugin bridge...');
      plugin.shutdown();
      process.exit(0);
    });
    
    logger.info('Plugin bridge initialized successfully');
    return plugin;
  } catch (error) {
    logger.error('Failed to initialize plugin bridge', error as Error);
    throw error;
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
    logger.info('Creating Figma frame', { 
      name, 
      dimensions: { width, height }, 
      background 
    });
    
    const command: PluginCommand = {
      type: 'CREATE_WIREFRAME',
      payload: {
        description: name,  // Using 'description' as expected by plugin
        pages: ['Home'],    // Define at least one page
        style: 'minimal',   // Default style
        dimensions: { width, height },
        designSystem: { background },
        renamePage: false   // Don't rename the current page by default
      },
      id: `frame_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      const errorMsg = response.error || 'Failed to create frame';
      logger.error('Frame creation failed', new Error(errorMsg), { command });
      throw new Error(errorMsg);
    }
    
    // Log success
    logger.info('Frame created successfully', {
      wireframeId: response.data?.wireframeId,
      activePageId: response.data?.activePageId,
      pageIds: response.data?.pageIds
    });
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    logger.error('Error creating frame', error as Error, { name, width, height });
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
    logger.info('Creating Figma component', { 
      type, 
      description, 
      style, 
      parentNodeId 
    });
    
    // If parentNodeId is explicitly provided as "current-selection", set it to null
    // so the plugin will use its prioritized parent resolution logic
    if (parentNodeId === "current-selection") {
      parentNodeId = undefined;
      logger.debug('Using current selection as parent');
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
        parent: parentNodeId, // This can be undefined - plugin will handle it
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
      const errorMsg = response.error || 'Failed to create component';
      logger.error('Component creation failed', new Error(errorMsg), { command });
      throw new Error(errorMsg);
    }
    
    // Log success
    logger.info('Component created successfully', {
      id: response.data?.id,
      type: response.data?.type,
      parentId: response.data?.parentId,
      parentType: response.data?.parentType,
      activePageId: response.data?.activePageId
    });
    
    return response.data?.id || 'unknown-id';
  } catch (error) {
    logger.error('Error creating component', error as Error, { type, description });
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
    logger.info('Styling Figma node', { 
      styleDescription, 
      nodeId: nodeId || 'current-selection',
      fillColor,
      strokeColor,
      textProperties 
    });
    
    // If nodeId is explicitly provided as "current-selection", set it to null
    // so the plugin will use the current selection
    if (nodeId === "current-selection") {
      nodeId = undefined;
      logger.debug('Using current selection for styling');
    }
    
    // Convert text properties to expected format
    const textProps: any = {};
    if (textProperties) {
      Object.assign(textProps, textProperties);
    }
    
    // If we have a style description but no explicit properties, 
    // add it as content for text nodes
    if (styleDescription && (!textProps.content && !textProps.text)) {
      textProps.text = styleDescription;
    }
    
    const command: PluginCommand = {
      type: 'STYLE_ELEMENT',
      payload: {
        elementId: nodeId, // This can be undefined - plugin will use selection
        styles: {
          description: styleDescription,
          fill: fillColor,
          stroke: strokeColor,
          ...textProps
        }
      },
      id: `style_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      const errorMsg = response.error || 'Failed to style node';
      logger.error('Node styling failed', new Error(errorMsg), { command });
      throw new Error(errorMsg);
    }
    
    // Log success
    logger.info('Node styled successfully', {
      id: response.data?.id,
      type: response.data?.type,
      activePageId: response.data?.activePageId
    });
    
    return response.data?.id || nodeId || 'unknown-id';
  } catch (error) {
    logger.error('Error styling node', error as Error, { styleDescription, nodeId });
    throw error;
  }
}

async function generateFigmaDesign(
  prompt: string,
  type: string,
  style: string = "modern"
): Promise<string> {
  try {
    logger.info('Generating Figma design', { 
      prompt, 
      type, 
      style 
    });
    
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
    
    logger.debug('Design will include pages', { pages });
    
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
        },
        renamePage: true // Rename the page with the prompt description for this tool
      },
      id: `design_${Date.now()}`
    };
    
    const response = await sendPluginCommand<PluginResponse>(command);
    
    if (!response.success) {
      const errorMsg = response.error || 'Failed to generate design';
      logger.error('Design generation failed', new Error(errorMsg), { command });
      throw new Error(errorMsg);
    }
    
    // Log success
    logger.info('Design generated successfully', {
      wireframeId: response.data?.wireframeId,
      activePageId: response.data?.activePageId,
      pageIds: response.data?.pageIds
    });
    
    // After creating the wireframe, populate each page with appropriate elements
    if (response.data?.pageIds && response.data.pageIds.length > 0) {
      // Add elements to pages based on design type
      // We'll use the first page to add a header
      try {
        const firstPageId = response.data.pageIds[0];
        logger.debug('Adding components to first page', { firstPageId });
        
        await createFigmaComponent('navbar', `${type} navigation`, style, firstPageId);
        
        // For website or dashboard, add a hero section
        if (type === 'website' || type === 'dashboard') {
          await createFigmaComponent('frame', `Hero section for ${prompt}`, style, firstPageId);
        }
        
        logger.info('Added initial components to design');
      } catch (elemError) {
        logger.warn(
          'Created wireframe but failed to add elements',
          { designContext: response.data },  // Context object as second parameter
          elemError as Error  // Error as third parameter
        );
        // Continue despite element creation errors
      }
    }
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    logger.error('Error generating design', error as Error, { prompt, type });
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
    logger.info('Exporting Figma design', { 
      nodeId: nodeId || 'current-selection', 
      format, 
      scale, 
      includeBackground 
    });
    
    // If nodeId is explicitly provided as "current-selection", set it to null
    if (nodeId === "current-selection") {
      nodeId = undefined;
      logger.debug('Using current selection for export');
    }
    
    // If no node ID provided, use current selection or active page
    let selection: string[] = [];
    if (nodeId) {
      selection = [nodeId];
    }
    // Otherwise, leave selection empty to let the plugin use current selection
    
    const command: PluginCommand = {
      type: 'EXPORT_DESIGN',
      payload: {
        selection: selection.length > 0 ? selection : undefined,
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
      const errorMsg = response.error || 'Failed to export design';
      logger.error('Design export failed', new Error(errorMsg), { command });
      throw new Error(errorMsg);
    }
    
    // Log success but don't include the base64 data to avoid polluting logs
    logger.info('Design exported successfully', {
      fileCount: response.data?.files?.length || 0,
      activePageId: response.data?.activePageId,
      fileTypes: response.data?.files?.map((f: any) => f.format)
    });
    
    // Return the first file URL or a placeholder
    if (response.data?.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      const fileName = typeof file.name === 'string' ? file.name : 'file';
      const fileFormat = typeof file.format === 'string' ? file.format : format;
      return `Exported ${fileName} as ${fileFormat} (data available in base64)`;
    }
    
    return 'Export completed but no files returned';
  } catch (error) {
    logger.error('Error exporting design', error as Error, { nodeId, format });
    throw error;
  }
}

// Update the main server function
async function runServer() {
  try {
    // Initialize plugin
    const plugin = await initializePlugin();
    
    // Log server mode
    if (useRealMode) {
      logger.info(`Server running in WebSocket mode on ${wsHost}:${wsPort}`);
      logger.info('WebSocket server is ready for Figma plugin connections');
      logger.info('Connect from Figma plugin UI using the WebSocket URL');
    } else {
      logger.info('Server running in Stdio mode (mock)');
      logger.info('To connect Claude to this MCP server:');
      logger.info('1. In Claude\'s MCP inspector, select "Stdio" transport');
      logger.info('2. Enter command: "node dist/index.js" (local) or use Docker command');
    }
    
    // Create MCP server
    const server = new Server(
      {
        name: "figma-mcp-server",
        version: "0.1.0",
        vendor: "Custom Figma Plugin",
      },
      {
        capabilities: {
          tools: {
            list: true,
            call: true,
          },
          prompts: {
            list: true,
            get: true,
          },
        },
      }
    );
    
    // Connect plugin to server
    plugin.connectToMCPServer(server);
    
    // Always connect the stdio transport so Claude can communicate with the server
    // regardless of whether we're also using WebSockets for Figma
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Connected to stdio transport for Claude communication');
    
    // Log operating mode
    if (useRealMode) {
      logger.info('WebSocket server is also enabled for Figma plugin connections');
      logger.info(`Figma plugin should connect to: ws://localhost:${wsPort}`);
    }
    
    // Log available tools
    logger.info('Available tools:', { 
      tools: [
        CREATE_FRAME_TOOL.name,
        CREATE_COMPONENT_TOOL.name,
        STYLE_DESIGN_TOOL.name,
        PROMPT_TO_DESIGN_TOOL.name,
        EXPORT_DESIGN_TOOL.name
      ]
    });
    
    // Register tools handlers
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          CREATE_FRAME_TOOL,
          CREATE_COMPONENT_TOOL,
          STYLE_DESIGN_TOOL,
          PROMPT_TO_DESIGN_TOOL,
          EXPORT_DESIGN_TOOL
        ],
      };
    });
    
    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        const { name, arguments: args } = request.params;
        logger.info('Handling tool call request', { toolName: name });
        
        if (!args) {
          logger.warn('No arguments provided for tool call', { toolName: name });
          throw new Error("No arguments provided");
        }

        switch (name) {
          case "create_figma_frame": {
            if (!isCreateFrameArgs(args)) {
              logger.warn('Invalid arguments for create_figma_frame', { args });
              throw new Error("Invalid arguments for create_figma_frame");
            }
            const { name, width = 1920, height = 1080, background = "#FFFFFF" } = args;
            
            try {
              const frameId = await createFigmaFrame(name, width, height, background);
              logger.info('create_figma_frame tool completed successfully', { frameId });
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
            logger.warn('Unknown tool requested', { toolName: name });
            return {
              content: [{ type: "text", text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        logger.error('Error handling tool call', error as Error);
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
    
    // Register prompts
    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: PROMPTS
      };
    });
    
    server.setRequestHandler(GetPromptRequestSchema, async (request: any) => {
      const { name, arguments: args } = request.params;
      logger.info('Handling GetPrompt request', { promptName: name });
      
      try {
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
            const errorMsg = `Prompt not found: ${name}`;
            logger.warn('Prompt not found', { promptName: name });
            throw new Error(errorMsg);
        }
      } catch (error) {
        logger.error('Error handling GetPrompt request', error as Error);
        throw error; // Let the MCP SDK handle the error response
      }
    });
    
    // Register progress handler
    server.setNotificationHandler(ProgressNotificationSchema, (notification: any) => {
      const { toolCallId, progress } = notification.params;
      logger.info('Tool call progress notification', { toolCallId, progress });
    });
    
    logger.info('Figma MCP Server started successfully');
  } catch (error) {
    logger.error('Failed to start server', error as Error);
    process.exit(1);
  }
}

// Run the server
runServer();
