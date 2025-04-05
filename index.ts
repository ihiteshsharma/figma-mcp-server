#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ProgressNotificationSchema,
  Tool
} from "@modelcontextprotocol/sdk/types.js";
import { 
  PluginBridge, 
  sendPluginCommand, 
  getCurrentSelection, 
  getCurrentPage,
  PluginCommand,
  PluginResponse,
  getPluginBridge
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

// Define all tools as constants following the pattern from the example file
// These Tool objects will be used in the ListToolsRequestSchema handler

const CREATE_RECTANGLE_TOOL: Tool = {
  name: "create_rectangle",
  description: "Creates a rectangle in Figma. Use this for buttons, cards, backgrounds, or any rectangular shapes.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the rectangle." },
      y: { type: "number", description: "Y position of the rectangle." },
      width: { type: "number", description: "Width of the rectangle." },
      height: { type: "number", description: "Height of the rectangle." },
      name: { type: "string", description: "Name of the rectangle." },
      cornerRadius: { 
        type: ["number", "object"], 
        description: "Corner radius. Can be a single number or an object with topLeft, topRight, bottomLeft, bottomRight properties." 
      },
      fills: { 
        type: "array", 
        description: "Array of fill paints. Each paint can be a solid color, gradient, or image." 
      },
      strokes: { 
        type: "array", 
        description: "Array of stroke paints." 
      },
      strokeWeight: { 
        type: "number", 
        description: "Thickness of the stroke." 
      },
      effects: { 
        type: "array", 
        description: "Array of effects like shadows or blurs." 
      },
      parent: { 
        type: "string", 
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: ["width", "height"]
  }
};

const CREATE_TEXT_TOOL: Tool = {
  name: "create_text",
  description: "Creates a text element in Figma. Use this for headings, paragraphs, labels, or any textual content.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the text." },
      y: { type: "number", description: "Y position of the text." },
      characters: { type: "string", description: "The text content." },
      fontSize: { type: "number", description: "Font size in pixels." },
      fontName: { 
        type: "object", 
        description: "Font family and style.",
        properties: {
          family: { type: "string" },
          style: { type: "string" }
        }
      },
      textAlignHorizontal: { 
        type: "string", 
        enum: ["LEFT", "CENTER", "RIGHT", "JUSTIFIED"],
        description: "Horizontal text alignment." 
      },
      textAlignVertical: { 
        type: "string", 
        enum: ["TOP", "CENTER", "BOTTOM"],
        description: "Vertical text alignment." 
      },
      fills: { 
        type: "array", 
        description: "Array of fill paints for the text color." 
      },
      name: { type: "string", description: "Name of the text element." },
      parent: { 
        type: "string", 
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: ["characters"]
  }
};

const CREATE_FRAME_TOOL: Tool = {
  name: "create_frame",
  description: "Creates a frame (container) in Figma. Use this to group elements or create screen areas.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the frame." },
      y: { type: "number", description: "Y position of the frame." },
      width: { type: "number", description: "Width of the frame." },
      height: { type: "number", description: "Height of the frame." },
      name: { type: "string", description: "Name of the frame." },
      fills: { 
        type: "array", 
        description: "Array of fill paints." 
      },
      cornerRadius: { 
        type: ["number", "object"], 
        description: "Corner radius. Can be a single number or an object with topLeft, topRight, bottomLeft, bottomRight properties." 
      },
      layoutMode: { 
        type: "string",
        enum: ["NONE", "HORIZONTAL", "VERTICAL"],
        description: "Layout mode for auto layout." 
      },
      primaryAxisAlignItems: { 
        type: "string", 
        enum: ["MIN", "CENTER", "MAX", "SPACE_BETWEEN"],
        description: "Alignment along the primary axis." 
      },
      counterAxisAlignItems: { 
        type: "string", 
        enum: ["MIN", "CENTER", "MAX"],
        description: "Alignment along the counter axis." 
      },
      itemSpacing: { 
        type: "number",
        description: "Space between items in auto layout." 
      },
      padding: { 
        type: ["number", "object"], 
        description: "Padding. Can be a single number for all sides or an object with top, right, bottom, left properties." 
      },
      parent: { 
        type: "string",
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: ["width", "height"]
  }
};

const CREATE_ELLIPSE_TOOL: Tool = {
  name: "create_ellipse",
  description: "Creates an ellipse or circle in Figma. Use this for circular buttons, avatars, or decorative elements.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the ellipse." },
      y: { type: "number", description: "Y position of the ellipse." },
      width: { type: "number", description: "Width of the ellipse." },
      height: { type: "number", description: "Height of the ellipse." },
      name: { type: "string", description: "Name of the ellipse." },
      fills: { 
        type: "array", 
        description: "Array of fill paints." 
      },
      strokes: { 
        type: "array", 
        description: "Array of stroke paints." 
      },
      strokeWeight: { 
        type: "number", 
        description: "Thickness of the stroke." 
      },
      effects: { 
        type: "array", 
        description: "Array of effects like shadows or blurs." 
      },
      parent: { 
        type: "string", 
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: ["width", "height"]
  }
};

const CREATE_LINE_TOOL: Tool = {
  name: "create_line",
  description: "Creates a line in Figma. Use this for dividers, connectors, or decorative elements.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the start point." },
      y: { type: "number", description: "Y position of the start point." },
      width: { type: "number", description: "Horizontal distance (for horizontal lines)." },
      height: { type: "number", description: "Vertical distance (for vertical lines)." },
      name: { type: "string", description: "Name of the line." },
      strokes: { 
        type: "array", 
        description: "Array of stroke paints." 
      },
      strokeWeight: { 
        type: "number", 
        description: "Thickness of the stroke." 
      },
      strokeCap: { 
        type: "string",
        enum: ["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"],
        description: "Style of line endpoints." 
      },
      parent: { 
        type: "string",
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: []
  }
};

const CREATE_COMPONENT_TOOL: Tool = {
  name: "create_component",
  description: "Creates a component in Figma. Use this for reusable design elements.",
  inputSchema: {
    type: "object",
    properties: {
      x: { type: "number", description: "X position of the component." },
      y: { type: "number", description: "Y position of the component." },
      width: { type: "number", description: "Width of the component." },
      height: { type: "number", description: "Height of the component." },
      name: { type: "string", description: "Name of the component." },
      fills: { 
        type: "array", 
        description: "Array of fill paints." 
      },
      cornerRadius: { 
        type: ["number", "object"], 
        description: "Corner radius. Can be a single number or an object with topLeft, topRight, bottomLeft, bottomRight properties." 
      },
      layoutMode: { 
        type: "string",
        enum: ["NONE", "HORIZONTAL", "VERTICAL"],
        description: "Layout mode for auto layout." 
      },
      parent: { 
        type: "string",
        description: "ID of the parent node. If not specified, will be added to the current page." 
      }
    },
    required: ["width", "height"]
  }
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

// Define our own Prompt and PromptArgument interfaces
interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface Prompt {
  name: string;
  description: string;
  arguments: PromptArgument[];
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
  style: string = "modern",
  request?: { id?: string | number }
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
    
    // Store the current MCP request ID if available
    let mcpRequestId: number | undefined;
    if (request?.id !== undefined) {
      // Convert string ID to number if needed
      mcpRequestId = typeof request.id === 'string' ? 
        parseInt(request.id, 10) : 
        (typeof request.id === 'number' ? request.id : undefined);
        
      if (mcpRequestId !== undefined && !isNaN(mcpRequestId) && command.id) {
        const pluginBridge = getPluginBridge();
        pluginBridge.storeMcpRequestId(command.id, mcpRequestId);
      } else {
        mcpRequestId = undefined;
      }
    }
    
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
      // Break down the prompt into individual UI elements to create
      const firstPageId = response.data.pageIds[0];
      logger.debug('Breaking down prompt into elements', { firstPageId, prompt });
      
      // Parse the prompt to determine what UI elements to create
      const elementsToCreate = breakDownPromptIntoElements(prompt, type, style);
      
      // Map to store created element IDs for parent-child relationships
      const elementIdMap: {[key: string]: string} = {};
      
      // Track the current vertical position for automatic positioning
      let currentY = 0;
      const padding = 24;
      
      // Create each element in sequence based on their hierarchy
      for (let i = 0; i < elementsToCreate.length; i++) {
        try {
          const element = elementsToCreate[i];
          logger.debug(`Creating element ${i+1}/${elementsToCreate.length}: ${element.type}`, element);
          
          // Generate a unique ID for this element command
          const elementCommandId = `${command.id}_elem_${i}`;
          
          // Store mapping for MCP response handling if mcpRequestId is available
          if (mcpRequestId !== undefined && !isNaN(mcpRequestId) && elementCommandId) {
            const pluginBridge = getPluginBridge();
            pluginBridge.storeMcpRequestId(elementCommandId, mcpRequestId);
          }
          
          // Determine parent ID - use element.childOf if defined and we have its ID
          let parentId = firstPageId; // Default to the main page
          if (element.childOf && elementIdMap[element.childOf]) {
            parentId = elementIdMap[element.childOf];
            logger.debug(`Using parent ${element.childOf} with ID ${parentId}`);
          }
          
          // For auto-positioning without explicit coordinates, calculate based on current Y
          if (!element.position) {
            element.position = {
              x: padding,
              y: currentY + padding,
              width: type === 'mobile app' ? 375 - (padding * 2) : 1200,
              height: element.type === 'navbar' ? 80 : 300
            };
          }
          
          // Make sure position is defined before accessing its properties
          if (element.position) {
            // Adjust height based on element type
            if (element.type === 'button') element.position.height = 50;
            if (element.type === 'input') element.position.height = 40;
            if (element.type === 'text') element.position.height = 24;
            
            // Update currentY for next element - use default if height is undefined
            const elementHeight = element.position.height || 100; // Default height if undefined
            currentY += elementHeight + padding;
          }
          
          // Define enhanced styles based on element type and design style
          const enhancedStyles = {
            ...(element.styles || {}),
          };
          
          // Add color palette based on design style
          if (style === 'minimal') {
            enhancedStyles.colorPalette = {
              primary: '#0070f3',
              secondary: '#7928ca',
              background: '#ffffff',
              text: '#111111',
              textSecondary: '#6b7280',
              border: '#e5e7eb'
            };
          } else if (style === 'colorful') {
            enhancedStyles.colorPalette = {
              primary: '#ff4500',
              secondary: '#00b8d4',
              background: '#f8f9fa',
              text: '#212529',
              textSecondary: '#6c757d',
              border: '#dee2e6'
            };
          } else if (style === 'corporate') {
            enhancedStyles.colorPalette = {
              primary: '#003366',
              secondary: '#336699',
              background: '#ffffff',
              text: '#1a1a1a',
              textSecondary: '#666666',
              border: '#cccccc'
            };
          }
          
          // Create the element command with full styling information
          const elementCommand: PluginCommand = {
            type: 'ADD_ELEMENT',
            payload: {
              elementType: element.type.toUpperCase(),
              parent: parentId,
              properties: {
                name: `${element.type} - ${element.description.substring(0, 20)}...`,
                text: element.description,
                content: element.description,
                style: style,
                position: element.position,
                layoutPosition: element.layoutPosition,
                styles: enhancedStyles,
                parentType: element.parentType
              }
            },
            id: elementCommandId
          };
          
          logger.debug(`Sending command to create ${element.type}`, elementCommand);
          
          // Send the command and await response
          const elementResponse = await sendPluginCommand<PluginResponse>(elementCommand);
          
          // Store the created element ID for future parent references
          if (elementResponse.success && elementResponse.data?.id) {
            // Store identifier for this element
            const elementKey = element.type === 'frame' && i === 0 ? 
                             'main-container' : // First frame is main container
                             `${element.type}-${i}`; // Otherwise use type-index
                             
            elementIdMap[elementKey] = elementResponse.data.id;
            
            // Register special container elements for hierarchical references
            if (i === 0 && element.type === 'frame') {
              if (type === 'website' || type === 'landing page') {
                elementIdMap['main-container'] = elementResponse.data.id;
              } else if (type === 'mobile app') {
                elementIdMap['app-container'] = elementResponse.data.id;
              } else if (type === 'dashboard') {
                elementIdMap['dashboard-container'] = elementResponse.data.id;
              }
            }
            
            // Register content container if description matches
            if (element.description.toLowerCase().includes('content')) {
              elementIdMap['content-container'] = elementResponse.data.id;
              elementIdMap['dashboard-content'] = elementResponse.data.id;
            }
            
            logger.debug(`Created element ${elementKey} with ID ${elementResponse.data.id}`);
          } else {
            logger.warn(`Failed to create element ${element.type}-${i}`, elementResponse.error);
          }
          
          // Small delay to allow Figma to process each element
          await new Promise(resolve => setTimeout(resolve, 300));
          
        } catch (elemError) {
          logger.warn(
            `Failed to create element: ${elementsToCreate[i].type}`,
            { element: elementsToCreate[i] },
            elemError as Error
          );
          // Continue despite element creation errors
        }
      }
      
      logger.info('Added all components to design', { elementCount: elementsToCreate.length });
    }
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    logger.error('Error generating design', error as Error, { prompt, type });
    throw error;
  }
}

// Break down the prompt into UI elements
function breakDownPromptIntoElements(prompt: string, type: string, style: string): any[] {
  const elements: any[] = [];
  let content = prompt.toLowerCase();
  
  // Design system specifications
  const designSpec = {
    colorScheme: {
      primary: '#1E88E5', // Default blue
      secondary: '#F5F7FA', // Light gray accent
      background: '#FFFFFF',
      text: '#333333',
      textSecondary: '#757575'
    },
    typography: {
      fontFamily: 'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSizes: {
        small: 12,
        normal: 14,
        medium: 16,
        large: 18,
        xlarge: 24,
        xxlarge: 32
      }
    },
    spacing: {
      small: 8,
      medium: 16,
      large: 24,
      xlarge: 32
    }
  };
  
  // First, create a main container based on the type
  elements.push({
    type: 'frame',
    description: `Main container for ${type}`,
    childOf: null,
    parentType: null,
    position: {
      x: 0,
      y: 0,
      width: type === 'mobile app' ? 375 : 1440,
      height: type === 'mobile app' ? 812 : 900
    },
    styles: {
      fillColor: designSpec.colorScheme.background,
      cornerRadius: type === 'mobile app' ? 0 : 0,
      colorPalette: designSpec.colorScheme,
      typographySystem: designSpec.typography
    }
  });
  
  // Create layout regions based on type
  // For websites/landing pages
  if (type === 'website' || type === 'landing page') {
    // Add header/navbar
    elements.push({
      type: 'navbar',
      description: 'Navigation Bar',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'top',
      styles: {
        fillColor: designSpec.colorScheme.primary,
        textColor: '#FFFFFF',
        paddingVertical: designSpec.spacing.medium,
        paddingHorizontal: designSpec.spacing.large
      }
    });
    
    // Add a clean text for the title in navbar
    elements.push({
      type: 'text',
      description: 'Brand Name', // Clean text content
      displayText: 'Brand Name', // What will actually display in the Figma design
      childOf: 'navbar-0',
      parentType: 'navbar',
      layoutPosition: 'left',
      styles: {
        fontFamily: designSpec.typography.fontFamily,
        fontSize: designSpec.typography.fontSizes.large,
        fontWeight: 'bold',
        textColor: '#FFFFFF'
      }
    });
    
    // Add content section
    elements.push({
      type: 'frame',
      description: 'Content Container',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'middle',
      styles: {
        fillColor: designSpec.colorScheme.background,
        paddingVertical: designSpec.spacing.large,
        paddingHorizontal: designSpec.spacing.large
      }
    });
  }
  
  // For mobile apps
  else if (type === 'mobile app') {
    // Add status bar
    elements.push({
      type: 'frame',
      description: 'Status Bar',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'top',
      position: {
        x: 0,
        y: 0,
        width: 375,
        height: 44
      },
      styles: {
        fillColor: designSpec.colorScheme.primary
      }
    });
    
    // Add app bar
    elements.push({
      type: 'navbar',
      description: 'App Bar',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'top',
      position: {
        x: 0,
        y: 44,
        width: 375,
        height: 56
      },
      styles: {
        fillColor: designSpec.colorScheme.primary,
        textColor: '#FFFFFF'
      }
    });
    
    // Add a clean title in app bar
    elements.push({
      type: 'text',
      description: 'App Title', // Clean text content
      displayText: 'App Title', // What will actually display in the Figma design
      childOf: 'navbar-1',
      parentType: 'navbar',
      layoutPosition: 'center',
      styles: {
        fontFamily: designSpec.typography.fontFamily,
        fontSize: designSpec.typography.fontSizes.large,
        fontWeight: 'bold',
        textColor: '#FFFFFF'
      }
    });
    
    // Add content container
    elements.push({
      type: 'frame',
      description: 'Content Container',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'middle',
      position: {
        x: 0,
        y: 100,
        width: 375,
        height: 662
      },
      styles: {
        fillColor: designSpec.colorScheme.background
      }
    });
  }
  
  // For dashboards
  else if (type === 'dashboard') {
    // Add sidebar
    elements.push({
      type: 'frame',
      description: 'Sidebar',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'left',
      position: {
        x: 0,
        y: 0,
        width: 240,
        height: 900
      },
      styles: {
        fillColor: designSpec.colorScheme.primary,
        textColor: '#FFFFFF'
      }
    });
    
    // Add header
    elements.push({
      type: 'navbar',
      description: 'Header Bar',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'top',
      position: {
        x: 240,
        y: 0,
        width: 1200,
        height: 64
      },
      styles: {
        fillColor: '#FFFFFF',
        borderBottomWidth: 1,
        borderBottomColor: designSpec.colorScheme.secondary
      }
    });
    
    // Add content area
    elements.push({
      type: 'frame',
      description: 'Content Area',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'middle',
      position: {
        x: 240,
        y: 64,
        width: 1200,
        height: 836
      },
      styles: {
        fillColor: designSpec.colorScheme.secondary,
        padding: designSpec.spacing.large
      }
    });
  }
  
  // Now parse the prompt to extract content elements
  const parsePromptForContent = (prompt: string): Array<{
    type: string;
    description: string;
    displayText: string;
    childOf: string;
    parentType: string;
    styles: Record<string, any>;
  }> => {
    // Create an array to hold content elements from the user's prompt
    const contentElements: Array<{
      type: string;
      description: string;
      displayText: string;
      childOf: string;
      parentType: string;
      styles: Record<string, any>;
    }> = [];
    
    // Look for headings/titles in the prompt
    const headingMatches = prompt.match(/(?:title|heading)(?:\s+called|\s+named|\s+saying|\s+that\s+says)?\s+["']([^"']+)["']/gi);
    if (headingMatches) {
      headingMatches.forEach(match => {
        const titleContent = match.match(/["']([^"']+)["']/i);
        if (titleContent && titleContent[1]) {
          contentElements.push({
            type: 'text',
            description: `Heading: ${titleContent[1]}`,
            displayText: titleContent[1], // Clean text for display
            childOf: 'content-container',
            parentType: 'frame',
            styles: {
              fontFamily: designSpec.typography.fontFamily,
              fontSize: designSpec.typography.fontSizes.xlarge,
              fontWeight: 'bold',
              marginBottom: designSpec.spacing.medium
            }
          });
        }
      });
    }
    
    // Look for paragraphs in the prompt
    const paragraphMatches = prompt.match(/(?:paragraph|text|body)(?:\s+saying|\s+that\s+says|\s+with\s+content|\s+with\s+text)?\s+["']([^"']+)["']/gi);
    if (paragraphMatches) {
      paragraphMatches.forEach(match => {
        const paragraphContent = match.match(/["']([^"']+)["']/i);
        if (paragraphContent && paragraphContent[1]) {
          contentElements.push({
            type: 'text',
            description: `Paragraph text`,
            displayText: paragraphContent[1], // Clean text for display
            childOf: 'content-container',
            parentType: 'frame',
            styles: {
              fontFamily: designSpec.typography.fontFamily,
              fontSize: designSpec.typography.fontSizes.normal,
              marginBottom: designSpec.spacing.medium
            }
          });
        }
      });
    }
    
    // Look for buttons in the prompt
    const buttonMatches = prompt.match(/(?:button|cta)(?:\s+labeled|\s+with\s+text|\s+saying)?\s+["']([^"']+)["']/gi);
    if (buttonMatches) {
      buttonMatches.forEach(match => {
        const buttonContent = match.match(/["']([^"']+)["']/i);
        if (buttonContent && buttonContent[1]) {
          contentElements.push({
            type: 'button',
            description: `Button: ${buttonContent[1]}`,
            displayText: buttonContent[1], // Clean text for button label
            childOf: 'content-container',
            parentType: 'frame',
            styles: {
              fillColor: designSpec.colorScheme.primary,
              textColor: '#FFFFFF',
              paddingVertical: designSpec.spacing.small,
              paddingHorizontal: designSpec.spacing.medium,
              cornerRadius: 4,
              fontWeight: 'medium'
            }
          });
        }
      });
    }
    
    // Look for input fields in the prompt
    const inputMatches = prompt.match(/(?:input|text field|form field)(?:\s+for|\s+labeled|\s+with\s+placeholder)?\s+["']([^"']+)["']/gi);
    if (inputMatches) {
      inputMatches.forEach(match => {
        const inputContent = match.match(/["']([^"']+)["']/i);
        if (inputContent && inputContent[1]) {
          contentElements.push({
            type: 'input',
            description: `Input field for: ${inputContent[1]}`,
            displayText: inputContent[1], // Clean text for placeholder
            childOf: 'content-container',
            parentType: 'frame',
            styles: {
              fillColor: '#FFFFFF',
              borderWidth: 1,
              borderColor: designSpec.colorScheme.secondary,
              cornerRadius: 4,
              paddingVertical: designSpec.spacing.small,
              paddingHorizontal: designSpec.spacing.small
            }
          });
        }
      });
    }
    
    return contentElements;
  };
  
  // Add content elements from the user's prompt
  const contentElements = parsePromptForContent(prompt);
  if (contentElements.length > 0) {
    elements.push(...contentElements);
  } else {
    // If no specific content was extracted, add some default elements based on type
    if (type === 'website' || type === 'landing page') {
      elements.push({
        type: 'text',
        description: 'Main Heading',
        displayText: 'Welcome to Our Website',
        childOf: 'content-container',
        parentType: 'frame',
        styles: {
          fontFamily: designSpec.typography.fontFamily,
          fontSize: designSpec.typography.fontSizes.xxlarge,
          fontWeight: 'bold',
          marginBottom: designSpec.spacing.large
        }
      });
    } else if (type === 'mobile app') {
      elements.push({
        type: 'text',
        description: 'Welcome Message',
        displayText: 'Welcome Back',
        childOf: 'content-container',
        parentType: 'frame',
        styles: {
          fontFamily: designSpec.typography.fontFamily,
          fontSize: designSpec.typography.fontSizes.xlarge,
          fontWeight: 'bold',
          marginTop: designSpec.spacing.large,
          marginBottom: designSpec.spacing.medium,
          textAlign: 'center'
        }
      });
    } else if (type === 'dashboard') {
      elements.push({
        type: 'text',
        description: 'Dashboard Title',
        displayText: 'Dashboard',
        childOf: 'navbar-1',
        parentType: 'navbar',
        styles: {
          fontFamily: designSpec.typography.fontFamily,
          fontSize: designSpec.typography.fontSizes.large,
          fontWeight: 'medium'
        }
      });
    }
  }
  
  // Check if we need to add a footer (for websites)
  if ((type === 'website' || type === 'landing page') && 
      (content.includes('footer') || content.includes('bottom'))) {
    elements.push({
      type: 'frame',
      description: 'Footer',
      childOf: 'main-container',
      parentType: 'frame',
      layoutPosition: 'bottom',
      styles: {
        fillColor: designSpec.colorScheme.secondary,
        paddingVertical: designSpec.spacing.large,
        paddingHorizontal: designSpec.spacing.large
      }
    });
    
    elements.push({
      type: 'text',
      description: 'Footer Text',
      displayText: '© 2024 Company Name. All rights reserved.',
      childOf: 'frame-3', // This assumes the footer is the 4th frame
      parentType: 'frame',
      styles: {
        fontFamily: designSpec.typography.fontFamily,
        fontSize: designSpec.typography.fontSizes.small,
        textAlign: 'center',
        textColor: designSpec.colorScheme.textSecondary
      }
    });
  }
  
  return elements;
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

// Add new direct Figma API tools to the server
async function initializeServer() {
  logger.info('Initializing MCP server');
  
  // Create MCP server
  const server = new Server(
    {
      name: "figma-mcp-server",
      displayName: "Figma MCP Server",
      description: "MCP server for Figma integration",
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
  const plugin = await initializePlugin();
  plugin.connectToMCPServer(server);
  
  // Always connect the stdio transport so Claude can communicate with the server
  // regardless of whether we're also using WebSockets for Figma
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Connected to stdio transport for Claude communication');
  
  // Log operating mode
  if (useRealMode) {
    logger.info('Operating in REAL mode - connecting to Figma plugin');
    
    // Start WebSocket server for Figma communication
    if (process.env.WEBSOCKET_MODE === 'true') {
      const wsPort = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 9000;
      // Don't directly call startWebSocketServer since it's private
      // Use the environment variable to determine WebSocket mode
      logger.info(`WebSocket server started on port ${wsPort}`);
    } else {
      logger.info('WebSocket mode disabled, using file transport');
    }
  } else {
    logger.info('Operating in MOCK mode - simulating Figma plugin behavior');
  }
  
  // Add tool call request handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;
      // Use a numeric ID instead of string to satisfy the type requirements
      const mcpRequestId = Date.now();
      
      logger.debug(`Handling tool call: ${name} with params: ${JSON.stringify(args)} and request ID: ${mcpRequestId}`);

    if (!args) {
        logger.warn('No arguments provided for tool call', { toolName: name });
      throw new Error("No arguments provided");
    }

      // Get the plugin bridge instance to track MCP request IDs
      const pluginBridge = getPluginBridge();
      
      // Create a unique ID for this plugin command to track it
      const pluginCommandId = `mcp_${mcpRequestId}_${Date.now()}`;
      
      // Tool handlers - implement the main direct API tools
      const createRectangleHandler = (params: any) => {
        logger.debug(`Creating rectangle with params: ${JSON.stringify(params)}`);
        
        // Default width and height if not provided
        const width = params.width ?? 100;
        const height = params.height ?? 100;
        
        // Transform effects to match Figma's API format
        let transformedParams = { ...params };
        if (params.effects && Array.isArray(params.effects)) {
          transformedParams.effects = params.effects.map((effect: any) => {
            // Transform effect based on type
            if (effect.type === 'DROP_SHADOW') {
              return {
                type: 'DROP_SHADOW',
                color: effect.color || { r: 0, g: 0, b: 0, a: 0.25 },
                offset: effect.offset || { x: 0, y: 2 },
                radius: effect.radius || 4,
                spread: effect.spread || 0,
                visible: true,
                blendMode: 'NORMAL'
              };
            } else if (effect.type === 'INNER_SHADOW') {
              return {
                type: 'INNER_SHADOW',
                color: effect.color || { r: 0, g: 0, b: 0, a: 0.25 },
                offset: effect.offset || { x: 0, y: 2 },
                radius: effect.radius || 4,
                spread: effect.spread || 0,
                visible: true,
                blendMode: 'NORMAL'
              };
            } else if (effect.type === 'LAYER_BLUR' || effect.type === 'BACKGROUND_BLUR') {
              return {
                type: effect.type,
                radius: effect.radius || 4,
                visible: true
              };
            }
            // Default fallback
            return {
              ...effect,
              visible: true,
              blendMode: 'NORMAL'
            };
          });
        }
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_RECTANGLE command to plugin with params: ${JSON.stringify(transformedParams)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_RECTANGLE',
              id: pluginCommandId,
              payload: {
                ...transformedParams,
                width,
                height
              }
            });
            
            logger.info('Rectangle creation command sent successfully');
            return {
              content: [{ 
                type: "text", 
                text: `Rectangle creation command sent successfully` 
              }],
              isError: false
            };
          } catch (error) {
            logger.error(`Rectangle creation failed: ${error}`);
            return {
              content: [{ 
                type: "text", 
                text: `Error creating rectangle: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating rectangle creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created rectangle ${width}x${height} at (${params.x || 0},${params.y || 0})` 
            }],
            isError: false
          };
        }
      };
      
      // Add the missing tool handler implementations in the CallToolRequestSchema handler
      const createTextHandler = (params: any) => {
        logger.debug(`Creating text with params: ${JSON.stringify(params)}`);
        
        // Validate required parameters
        if (!params.characters) {
          logger.error('Text creation failed: characters parameter is required');
          return {
            content: [{ 
              type: "text", 
              text: `Invalid params: characters parameter is required` 
            }],
            isError: true
          };
        }
        
        // Default text parameters
        const fontSize = params.fontSize ?? 16;
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_TEXT command to plugin with params: ${JSON.stringify(params)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_TEXT',
              id: pluginCommandId,
              payload: {
                ...params,
                fontSize
              }
            });
            
            logger.info('Text creation command sent successfully');
        return {
            content: [{ 
              type: "text", 
                text: `Text creation command sent successfully` 
            }],
              isError: false
        };
        } catch (error) {
            logger.error(`Text creation failed: ${error}`);
        return {
            content: [{ 
              type: "text", 
                text: `Error creating text: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating text creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created text "${params.characters.substring(0, 20)}${params.characters.length > 20 ? '...' : ''}" at (${params.x || 0},${params.y || 0})` 
            }],
            isError: false
          };
        }
      };
      
      const createFrameHandler = (params: any) => {
        logger.debug(`Creating frame with params: ${JSON.stringify(params)}`);
        
        // Default width and height if not provided
        const width = params.width ?? 400;
        const height = params.height ?? 300;
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_FRAME command to plugin with params: ${JSON.stringify(params)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_FRAME',
              id: pluginCommandId,
              payload: {
                ...params,
                width,
                height
              }
            });
            
            logger.info('Frame creation command sent successfully');
        return {
            content: [{ 
              type: "text", 
                text: `Frame creation command sent successfully` 
            }],
              isError: false
        };
        } catch (error) {
            logger.error(`Frame creation failed: ${error}`);
          return {
            content: [{ 
              type: "text", 
                text: `Error creating frame: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating frame creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created frame${params.name ? ` "${params.name}"` : ''} ${width}x${height} at (${params.x || 0},${params.y || 0})` 
            }],
            isError: false
          };
        }
      };
      
      const createEllipseHandler = (params: any) => {
        logger.debug(`Creating ellipse with params: ${JSON.stringify(params)}`);
        
        // Default width and height if not provided
        const width = params.width ?? 100;
        const height = params.height ?? 100;
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_ELLIPSE command to plugin with params: ${JSON.stringify(params)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_ELLIPSE',
              id: pluginCommandId,
              payload: {
                ...params,
                width,
                height
              }
            });
            
            logger.info('Ellipse creation command sent successfully');
        return {
            content: [{ 
              type: "text", 
                text: `Ellipse creation command sent successfully` 
            }],
              isError: false
        };
        } catch (error) {
            logger.error(`Ellipse creation failed: ${error}`);
        return {
            content: [{ 
              type: "text", 
                text: `Error creating ellipse: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating ellipse creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created ellipse ${width}x${height} at (${params.x || 0},${params.y || 0})` 
            }],
            isError: false
          };
        }
      };
      
      const createLineHandler = (params: any) => {
        logger.debug(`Creating line with params: ${JSON.stringify(params)}`);
        
        // Default line parameters
        const width = params.width ?? 100;
        const height = params.height ?? 0; // Default to horizontal line
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_LINE command to plugin with params: ${JSON.stringify(params)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_LINE',
              id: pluginCommandId,
              payload: {
                ...params,
                width,
                height
              }
            });
            
            logger.info('Line creation command sent successfully');
            return {
              content: [{ 
                type: "text", 
                text: `Line creation command sent successfully` 
              }],
              isError: false
            };
          } catch (error) {
            logger.error(`Line creation failed: ${error}`);
            return {
              content: [{ 
                type: "text", 
                text: `Error creating line: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating line creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created line from (${params.x || 0},${params.y || 0}) with width=${width}, height=${height}` 
            }],
            isError: false
          };
        }
      };
      
      const createComponentHandler = (params: any) => {
        logger.debug(`Creating component with params: ${JSON.stringify(params)}`);
        
        // Default width and height if not provided
        const width = params.width ?? 200;
        const height = params.height ?? 100;
        
        if (useRealMode) {
          try {
            // Send the command to the plugin
            logger.debug(`Sending CREATE_COMPONENT command to plugin with params: ${JSON.stringify(params)}`);
            
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_COMPONENT',
              id: pluginCommandId,
              payload: {
                ...params,
                width,
                height
              }
            });
            
            logger.info('Component creation command sent successfully');
        return {
            content: [{ 
              type: "text", 
                text: `Component creation command sent successfully` 
            }],
              isError: false
        };
        } catch (error) {
            logger.error(`Component creation failed: ${error}`);
          return {
            content: [{ 
              type: "text", 
                text: `Error creating component: ${error instanceof Error ? error.message : String(error)}` 
              }],
              isError: true
            };
          }
        } else {
          logger.info('Mock mode: Simulating component creation');
          return {
            content: [{ 
              type: "text", 
              text: `Created component${params.name ? ` "${params.name}"` : ''} ${width}x${height} at (${params.x || 0},${params.y || 0})` 
            }],
            isError: false
          };
        }
      };
      
      // Update the toolHandlers map to include all the handlers
      const toolHandlers: Record<string, Function> = {
        'create_rectangle': createRectangleHandler,
        'create_text': createTextHandler,
        'create_frame': createFrameHandler,
        'create_ellipse': createEllipseHandler,
        'create_line': createLineHandler,
        'create_component': createComponentHandler
      };
      
      // Look up and call the handler if it exists
      if (toolHandlers[name]) {
        logger.info(`Using registered handler for tool: ${name}`);
        return toolHandlers[name](args);
      }
      
      // Legacy tool handling with switch statement
      switch (name) {
        case 'create_figma_frame': {
          const { x, y, width = 400, height = 300, name: frameName } = args;
          logger.info(`Creating figma frame at (${x}, ${y}) with dimensions ${width}x${height} and name "${frameName}"`);
          
          if (useRealMode) {
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_WIREFRAME',
              id: pluginCommandId,
              payload: {
                description: frameName,
                pages: ['Home'],
                style: 'minimal',
                dimensions: { width, height },
                designSystem: { background: '#FFFFFF' },
                renamePage: false
              }
            });
          }
          
          return {
            content: [{ 
              type: "text", 
              text: `Frame creation command sent` 
            }],
            isError: false
          };
        }
        
        case 'create_figma_component': {
          const { x, y, width = 200, height = 100, name: componentName } = args;
          logger.info(`Creating figma component at (${x}, ${y}) with dimensions ${width}x${height} and name "${componentName}"`);
          
          if (useRealMode) {
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'CREATE_WIREFRAME',
              id: pluginCommandId,
              payload: {
                description: componentName,
                type: 'component',
                x, y, width, height
              }
            });
          }
          
          return {
            content: [{ 
              type: "text", 
              text: `Component creation command sent` 
            }],
            isError: false
          };
        }
        
        case 'style_figma_node': {
          const { node_id, styles } = args;
          logger.info(`Styling figma node ${node_id} with styles: ${JSON.stringify(styles)}`);
          
          if (useRealMode) {
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'STYLE_ELEMENT',
              id: pluginCommandId,
              payload: {
                elementId: node_id,
                styles
              }
            });
          }
          
          return {
            content: [{ 
              type: "text", 
              text: `Style command sent` 
            }],
            isError: false
          };
        }
        
        case 'generate_figma_design': {
          const { prompt, parent_id = null } = args as { prompt: string; parent_id?: string | null };
          logger.info(`Generating figma design with prompt: "${prompt}" and parent: ${parent_id}`);
          
          if (useRealMode) {
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            // Generate design based on prompt
            const designId = await generateFigmaDesign(prompt, 'ui', 'modern', { id: mcpRequestId });
            
            return {
              content: [{ 
                type: "text", 
                text: `Generated design based on your prompt with ID: ${designId}` 
              }],
              isError: false
            };
          } else {
            return {
              content: [{ 
                type: "text", 
                text: `Mock mode: Would generate design from prompt: "${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}"` 
              }],
              isError: false
            };
          }
        }
        
        case 'export_figma_design': {
          const { node_id, format = 'png' } = args;
          logger.info(`Exporting figma design node ${node_id} as ${format}`);
          
          if (useRealMode) {
            // Store the MCP request ID so we can map the response
            pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
            
            pluginBridge.sendCommand({
              type: 'EXPORT_DESIGN',
              id: pluginCommandId,
              payload: {
                nodeId: node_id,
                format
              }
            });
          }
          
          return {
            content: [{ 
              type: "text", 
              text: `Export command sent` 
            }],
            isError: false
          };
        }
        
        case 'create_text':
        case 'create_frame': 
          logger.warn(`Tool ${name} not yet fully implemented`);
          return {
            content: [{ 
              type: "text", 
              text: `The tool "${name}" is not fully implemented yet.` 
            }],
            isError: true
          };

      default:
          logger.error(`Unknown tool: ${name}`);
        return {
            content: [{ 
              type: "text", 
              text: `Method not found: ${name}` 
            }],
            isError: true
        };
    }
  } catch (error) {
      logger.error(`Error handling tool call: ${error}`);
    return {
        content: [{ 
          type: "text",
          text: `Internal error: ${error instanceof Error ? error.message : String(error)}` 
        }],
        isError: true
    };
  }
});

  // Register tools using the server approach from the existing code
  // Since registerTools doesn't exist on Server, use setRequestHandler like existing code
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    logger.info('Handling ListToolsRequest');
    
    // Create a properly formatted list of all available tools using the Tool constants
    const allTools = [
      // Direct API tools
      CREATE_RECTANGLE_TOOL,
      CREATE_TEXT_TOOL,
      CREATE_FRAME_TOOL,
      CREATE_ELLIPSE_TOOL,
      CREATE_LINE_TOOL,
      CREATE_COMPONENT_TOOL,
      
      // Legacy tools renamed to match Claude's expectations
      STYLE_DESIGN_TOOL,
      PROMPT_TO_DESIGN_TOOL,
      EXPORT_DESIGN_TOOL
    ];
    
    return { tools: allTools };
  });
  
  // Register prompts handling remains the same
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
    
        default: {
          const errorMsg = `Prompt not found: ${name}`;
          logger.warn('Prompt not found', { promptName: name });
          throw new Error(errorMsg);
        }
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
  
  // Return server instance
  return server;
}

// Run the server
async function runServer() {
  try {
    // Initialize server
    const server = await initializeServer();
    
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
    
    // Log available tools
    logger.info('Available tools:', { 
      tools: [
        CREATE_RECTANGLE_TOOL.name,
        CREATE_TEXT_TOOL.name,
        CREATE_FRAME_TOOL.name,
        CREATE_ELLIPSE_TOOL.name,
        CREATE_LINE_TOOL.name,
        CREATE_COMPONENT_TOOL.name,
        STYLE_DESIGN_TOOL.name,
        PROMPT_TO_DESIGN_TOOL.name,
        EXPORT_DESIGN_TOOL.name
      ]
    });
    
    logger.info('Figma MCP Server started successfully');
  } catch (error) {
    logger.error('Failed to start server', error as Error);
  process.exit(1);
  }
}

// Run the server
runServer();
