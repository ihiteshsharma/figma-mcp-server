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
      // Break down the prompt into individual UI elements to create
      const firstPageId = response.data.pageIds[0];
      logger.debug('Breaking down prompt into elements', { firstPageId, prompt });
      
      // Parse the prompt to determine what UI elements to create
      const elementsToCreate = breakDownPromptIntoElements(prompt, type, style);
      
      // Create each element in sequence
      for (const element of elementsToCreate) {
        try {
          logger.debug(`Creating element: ${element.type}`, element);
          
          await createFigmaComponent(
            element.type,
            element.description,
            style,
            firstPageId
          );
          
          // Small delay to allow Figma to process each element
          await new Promise(resolve => setTimeout(resolve, 200));
          
        } catch (elemError) {
          logger.warn(
            `Failed to create element: ${element.type}`,
            { element },
            elemError as Error
          );
          // Continue despite element creation errors
        }
      }
      
      logger.info('Added all components to design');
    }
    
    return response.data?.wireframeId || response.data?.pageIds?.[0] || 'unknown-id';
  } catch (error) {
    logger.error('Error generating design', error as Error, { prompt, type });
    throw error;
  }
}

// Helper function to break down a prompt into specific UI elements
function breakDownPromptIntoElements(prompt: string, type: string, style: string): Array<{
  type: string, 
  description: string,
  position?: {x: number, y: number, width?: number, height?: number},
  parentType?: string,
  childOf?: string,
  layoutPosition?: 'top' | 'bottom' | 'left' | 'right' | 'center',
  styles?: {[key: string]: any}
}> {
  const elements: Array<{
    type: string, 
    description: string,
    position?: {x: number, y: number, width?: number, height?: number},
    parentType?: string,
    childOf?: string,
    layoutPosition?: 'top' | 'bottom' | 'left' | 'right' | 'center',
    styles?: {[key: string]: any}
  }> = [];
  
  // Track rootContainer to use as parent for child elements
  let rootContainer = '';
  let currentY = 0;
  const defaultMargin = 24;
  const containerWidth = type === 'mobile app' ? 375 : 1200;
  const pageWidth = type === 'mobile app' ? 375 : 1440;
  
  // Default elements based on design type
  if (type === 'website' || type === 'landing page') {
    // Create main container first
    rootContainer = 'main-container';
    elements.push({
      type: 'frame',
      description: `Main ${type} layout container`,
      position: { 
        x: (pageWidth - containerWidth) / 2, 
        y: 0, 
        width: containerWidth, 
        height: 2000 // We'll adjust this based on content
      },
      styles: {
        fill: "#FFFFFF",
        cornerRadius: 0,
        layout: "VERTICAL",
        itemSpacing: 48,
        paddingTop: 0,
        paddingBottom: 64,
        paddingLeft: 0,
        paddingRight: 0
      }
    });
    
    currentY = 0;
    
    // Always add header/navbar first
    elements.push({
      type: 'navbar',
      description: `Navigation bar for ${type} with logo, links, and call to action`,
      position: { x: 0, y: currentY, width: containerWidth, height: 80 },
      childOf: rootContainer,
      layoutPosition: 'top',
      styles: {
        fill: style === 'minimal' ? "#FFFFFF" : "#F8F9FA",
        layout: "HORIZONTAL",
        itemSpacing: 24,
        paddingLeft: 24,
        paddingRight: 24,
        paddingTop: 16,
        paddingBottom: 16,
        justifyContent: "SPACE_BETWEEN"
      }
    });
    
    currentY += 80 + defaultMargin;
    
    // Check for specific sections in the prompt
    if (prompt.toLowerCase().includes('hero') || !prompt.toLowerCase().includes('section')) {
      elements.push({
        type: 'frame',
        description: `Hero section with headline, subheading, and main CTA button`,
        position: { x: 0, y: currentY, width: containerWidth, height: 400 },
        childOf: rootContainer,
        layoutPosition: 'top',
        styles: {
          fill: style === 'minimal' ? "#FFFFFF" : "#F8F9FA",
          cornerRadius: 8,
          layout: "VERTICAL",
          itemSpacing: 24,
          paddingTop: 64,
          paddingBottom: 64,
          paddingLeft: 24,
          paddingRight: 24,
          justifyContent: "CENTER",
          alignItems: "CENTER"
        }
      });
      
      currentY += 400 + defaultMargin;
    }
    
    if (prompt.toLowerCase().includes('feature') || prompt.toLowerCase().includes('product')) {
      elements.push({
        type: 'frame',
        description: `Features section with 3 columns of feature highlights`,
        position: { x: 0, y: currentY, width: containerWidth, height: 400 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 32,
          paddingTop: 64,
          paddingBottom: 64,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 400 + defaultMargin;
    }
    
    if (prompt.toLowerCase().includes('pricing')) {
      elements.push({
        type: 'frame',
        description: `Pricing section with 3 pricing tiers in card layout`,
        position: { x: 0, y: currentY, width: containerWidth, height: 500 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: style === 'minimal' ? "#FFFFFF" : "#F8F9FA",
          layout: "VERTICAL",
          itemSpacing: 32,
          paddingTop: 64,
          paddingBottom: 64,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 500 + defaultMargin;
    }
    
    if (prompt.toLowerCase().includes('testimonial') || prompt.toLowerCase().includes('review')) {
      elements.push({
        type: 'frame',
        description: `Testimonials section with customer quotes`,
        position: { x: 0, y: currentY, width: containerWidth, height: 300 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: style === 'minimal' ? "#F8F9FA" : "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 24,
          paddingTop: 48,
          paddingBottom: 48,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 300 + defaultMargin;
    }
    
    if (prompt.toLowerCase().includes('contact') || prompt.toLowerCase().includes('form')) {
      elements.push({
        type: 'form',
        description: `Contact form with name, email, subject and message fields`,
        position: { x: 0, y: currentY, width: containerWidth, height: 400 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          cornerRadius: 8,
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 32,
          paddingBottom: 32,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 400 + defaultMargin;
    }
    
    // Always add footer last
    elements.push({
      type: 'frame',
      description: `Footer with company info, navigation links, and social media icons`,
      position: { x: 0, y: currentY, width: containerWidth, height: 200 },
      childOf: rootContainer,
      layoutPosition: 'bottom',
      styles: {
        fill: "#212529",
        layout: "VERTICAL",
        itemSpacing: 24,
        paddingTop: 48,
        paddingBottom: 48,
        paddingLeft: 24,
        paddingRight: 24,
        color: "#FFFFFF"
      }
    });
    
    // Update the main container's height to fit all content
    elements[0].position!.height = currentY + 200 + defaultMargin;
  } 
  else if (type === 'mobile app') {
    // For mobile app designs, create a single-column layout
    rootContainer = 'app-container';
    elements.push({
      type: 'frame',
      description: `Mobile app screen container`,
      position: { 
        x: (pageWidth - 375) / 2, 
        y: 0, 
        width: 375, 
        height: 812 
      },
      styles: {
        fill: "#FFFFFF",
        cornerRadius: 0,
        layout: "VERTICAL",
        itemSpacing: 0,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0
      }
    });
    
    currentY = 0;
    
    // Status bar
    elements.push({
      type: 'frame',
      description: `Status bar and app header with title and navigation controls`,
      position: { x: 0, y: currentY, width: 375, height: 80 },
      childOf: rootContainer,
      layoutPosition: 'top',
      styles: {
        fill: style === 'minimal' ? "#FFFFFF" : "#F8F9FA",
        layout: "HORIZONTAL",
        itemSpacing: 16,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 16,
        paddingBottom: 16,
        justifyContent: "SPACE_BETWEEN"
      }
    });
    
    currentY += 80;
    
    if (prompt.toLowerCase().includes('login') || prompt.toLowerCase().includes('sign')) {
      elements.push({
        type: 'form',
        description: `Login form with username/email and password fields`,
        position: { x: 0, y: currentY, width: 375, height: 320 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 32,
          paddingBottom: 32,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 320;
    }
    
    if (prompt.toLowerCase().includes('feed') || prompt.toLowerCase().includes('timeline')) {
      elements.push({
        type: 'frame',
        description: `Content feed with scrollable items and interaction elements`,
        position: { x: 0, y: currentY, width: 375, height: 450 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16
        }
      });
      
      currentY += 450;
    }
    
    if (prompt.toLowerCase().includes('profile')) {
      elements.push({
        type: 'frame',
        description: `User profile section with avatar, user info, and stats`,
        position: { x: 0, y: currentY, width: 375, height: 400 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 400;
    }
    
    if (prompt.toLowerCase().includes('settings')) {
      elements.push({
        type: 'frame',
        description: `Settings screen with toggle switches and preference options`,
        position: { x: 0, y: currentY, width: 375, height: 400 },
        childOf: rootContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 24,
          paddingBottom: 24,
          paddingLeft: 24,
          paddingRight: 24
        }
      });
      
      currentY += 400;
    }
    
    // Tab bar
    elements.push({
      type: 'frame',
      description: `Bottom navigation bar with main app sections`,
      position: { x: 0, y: 732, width: 375, height: 80 },
      childOf: rootContainer,
      layoutPosition: 'bottom',
      styles: {
        fill: style === 'minimal' ? "#FFFFFF" : "#F8F9FA",
        layout: "HORIZONTAL",
        itemSpacing: 0,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        justifyContent: "SPACE_AROUND"
      }
    });
  }
  else if (type === 'dashboard') {
    // For dashboard designs
    rootContainer = 'dashboard-container';
    elements.push({
      type: 'frame',
      description: `Dashboard layout container`,
      position: { 
        x: 0, 
        y: 0, 
        width: pageWidth, 
        height: 900 
      },
      styles: {
        fill: style === 'minimal' ? "#F8F9FA" : "#FFFFFF",
        cornerRadius: 0,
        layout: "HORIZONTAL",
        itemSpacing: 0,
        paddingTop: 0,
        paddingBottom: 0,
        paddingLeft: 0,
        paddingRight: 0
      }
    });
    
    // Sidebar first (left side)
    elements.push({
      type: 'frame',
      description: `Sidebar navigation with main dashboard sections`,
      position: { x: 0, y: 0, width: 240, height: 900 },
      childOf: rootContainer,
      layoutPosition: 'left',
      styles: {
        fill: style === 'minimal' ? "#FFFFFF" : "#212529",
        layout: "VERTICAL",
        itemSpacing: 8,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 24,
        paddingBottom: 24,
        color: style === 'minimal' ? "#212529" : "#FFFFFF"
      }
    });
    
    // Header (top right)
    elements.push({
      type: 'navbar',
      description: `Dashboard header with logo, search, and user profile`,
      position: { x: 240, y: 0, width: pageWidth - 240, height: 64 },
      childOf: rootContainer,
      layoutPosition: 'top',
      styles: {
        fill: "#FFFFFF",
        layout: "HORIZONTAL",
        itemSpacing: 24,
        paddingLeft: 24,
        paddingRight: 24,
        paddingTop: 12,
        paddingBottom: 12,
        justifyContent: "SPACE_BETWEEN"
      }
    });
    
    // Main content container
    const mainContentContainer = 'dashboard-content';
    elements.push({
      type: 'frame',
      description: `Main dashboard content area`,
      position: { x: 240, y: 64, width: pageWidth - 240, height: 836 },
      childOf: rootContainer,
      layoutPosition: 'center',
      styles: {
        fill: "#F8F9FA",
        layout: "VERTICAL",
        itemSpacing: 24,
        paddingLeft: 24,
        paddingRight: 24,
        paddingTop: 24,
        paddingBottom: 24
      }
    });
    
    // Stats cards
    elements.push({
      type: 'frame',
      description: `Stats overview with 4 key metric cards`,
      position: { x: 0, y: 0, width: pageWidth - 240 - 48, height: 120 },
      childOf: mainContentContainer,
      layoutPosition: 'top',
      styles: {
        fill: "transparent",
        layout: "HORIZONTAL",
        itemSpacing: 24,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        justifyContent: "SPACE_BETWEEN"
      }
    });
    
    if (prompt.toLowerCase().includes('chart') || prompt.toLowerCase().includes('graph')) {
      elements.push({
        type: 'frame',
        description: `Chart section with multiple data visualizations`,
        position: { x: 0, y: 144, width: pageWidth - 240 - 48, height: 300 },
        childOf: mainContentContainer,
        layoutPosition: 'center',
        styles: {
          fill: "#FFFFFF",
          cornerRadius: 8,
          layout: "VERTICAL",
          itemSpacing: 16,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16
        }
      });
    }
    
    if (prompt.toLowerCase().includes('table') || prompt.toLowerCase().includes('list')) {
      elements.push({
        type: 'frame',
        description: `Data table with paginated results and sorting options`,
        position: { x: 0, y: 468, width: pageWidth - 240 - 48, height: 344 },
        childOf: mainContentContainer,
        layoutPosition: 'bottom',
        styles: {
          fill: "#FFFFFF",
          cornerRadius: 8,
          layout: "VERTICAL",
          itemSpacing: 0,
          paddingTop: 16,
          paddingBottom: 16,
          paddingLeft: 16,
          paddingRight: 16
        }
      });
    }
  }
  
  // Process elements mentioned in the prompt
  const lines = prompt.split('\n');
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Skip empty lines or numbered bullets without content
    if (!trimmedLine || /^\d+\.?\s*$/.test(trimmedLine)) continue;
    
    // Remove numbering from the start of the line
    const content = trimmedLine.replace(/^\d+\.?\s*/, '').trim();
    if (!content) continue;
    
    // Check for identifiable UI elements in this line
    if (content.toLowerCase().includes('header') && !elements.some(e => e.type === 'navbar')) {
      elements.unshift({
        type: 'navbar',
        description: content
      });
      continue;
    }
    
    if (content.toLowerCase().includes('footer') && !elements.some(e => e.description.toLowerCase().includes('footer'))) {
      elements.push({
        type: 'frame',
        description: content
      });
      continue;
    }
    
    if ((content.toLowerCase().includes('button') || content.toLowerCase().includes('cta')) && 
        !elements.some(e => e.type === 'button' && e.description.includes(content))) {
      elements.push({
        type: 'button',
        description: content
      });
      continue;
    }
    
    if ((content.toLowerCase().includes('form') || content.toLowerCase().includes('input') || 
         content.toLowerCase().includes('field')) && 
        !elements.some(e => e.type === 'form' && e.description.includes(content))) {
      elements.push({
        type: 'form',
        description: content
      });
      continue;
    }
    
    if ((content.toLowerCase().includes('navigation') || content.toLowerCase().includes('breadcrumb') || 
         content.toLowerCase().includes('menu')) && 
        !elements.some(e => e.type === 'navbar' && e.description.includes(content))) {
      elements.push({
        type: 'navbar',
        description: content
      });
      continue;
    }
    
    // If the line contains a description of a section but hasn't been categorized yet,
    // add it as a generic frame
    if (content.toLowerCase().includes('section') || 
        content.toLowerCase().includes('area') || 
        content.toLowerCase().includes('container') ||
        content.length > 20) {
      elements.push({
        type: 'frame',
        description: content
      });
    }
  }
  
  // Make sure all elements have appropriate IDs for parent-child relationships
  elements.forEach((element, index) => {
    if (!element.childOf && index > 0) {
      // If no parent is specified and it's not the root container,
      // set the parent to the root container
      element.childOf = rootContainer;
    }
  });
  
  logger.debug(`Broke down prompt into ${elements.length} elements with hierarchy`, { elements });
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
        const mcpRequestId = request.id; // Capture the MCP request ID
        logger.info('Handling tool call request', { toolName: name, mcpRequestId });
        
        if (!args) {
          logger.warn('No arguments provided for tool call', { toolName: name });
          throw new Error("No arguments provided");
        }

        // Create a command ID for Figma plugin that we can track
        const pluginCommandId = `mcp_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        
        // Get the plugin bridge instance to track MCP request IDs
        const pluginBridge = getPluginBridge();
        
        switch (name) {
          case "create_figma_frame": {
            if (!isCreateFrameArgs(args)) {
              logger.warn('Invalid arguments for create_figma_frame', { args });
              throw new Error("Invalid arguments for create_figma_frame");
            }
            const { name, width = 1920, height = 1080, background = "#FFFFFF" } = args;
            
            try {
              // Store the MCP request ID before making the plugin command call
              pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
              
              // Call the plugin with the tracked command ID
              const command: PluginCommand = {
                type: 'CREATE_WIREFRAME',
                payload: {
                  description: name,
                  pages: ['Home'],
                  style: 'minimal',
                  dimensions: { width, height },
                  designSystem: { background },
                  renamePage: false
                },
                id: pluginCommandId // Use our trackable ID
              };
              
              // For real-mode, send the command and let the plugin bridge handle the response
              // and transform it to JSON-RPC format
              if (!useRealMode) {
                // In mock mode, we need to handle it ourselves
                const frameId = await createFigmaFrame(name, width, height, background);
                logger.info('create_figma_frame tool completed successfully', { frameId });
                return {
                  content: [{ 
                    type: "text", 
                    text: `Successfully created frame "${name}" (${width}x${height}) with ID: ${frameId}` 
                  }],
                  isError: false,
                };
              } else {
                // In real mode, we send the command but don't wait for the response here
                // The plugin bridge will handle the response and send it to the MCP server
                sendPluginCommand(command).catch(error => {
                  logger.error('Error in plugin command execution', error as Error);
                });
                
                // Return a placeholder response that will be replaced when the real response comes in
                return {
                  content: [{ 
                    type: "text", 
                    text: `Processing request to create frame "${name}"...` 
                  }],
                  isError: false,
                  _isPlaceholder: true
                };
              }
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
              // Store the MCP request ID before making the plugin command call
              pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
              
              // Call the plugin with the tracked command ID
              const command: PluginCommand = {
                type: 'ADD_ELEMENT',
                payload: {
                  elementType: type.toUpperCase(),
                  parent: parentNodeId,
                  properties: {
                    name: `${type} - ${description.substring(0, 20)}...`,
                    text: description,
                    content: description,
                    style: style
                  }
                },
                id: pluginCommandId // Use our trackable ID
              };
              
              if (!useRealMode) {
                const componentId = await createFigmaComponent(type, description, style, parentNodeId);
                return {
                  content: [{ 
                    type: "text", 
                    text: `Successfully created ${type} component with ID: ${componentId}` 
                  }],
                  isError: false,
                };
              } else {
                // In real mode, send the command but don't wait for response here
                sendPluginCommand(command).catch(error => {
                  logger.error('Error in plugin command execution', error as Error);
                });
                
                return {
                  content: [{ 
                    type: "text", 
                    text: `Processing request to create ${type} component...` 
                  }],
                  isError: false,
                  _isPlaceholder: true
                };
              }
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
              // Store the MCP request ID before making the plugin command call
              pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
              
              // Call the plugin with the tracked command ID
              const command: PluginCommand = {
                type: 'STYLE_ELEMENT',
                payload: {
                  elementId: nodeId,
                  styles: {
                    description: styleDescription,
                    fill: fillColor,
                    stroke: strokeColor,
                    ...(textProperties || {})
                  }
                },
                id: pluginCommandId // Use our trackable ID
              };
              
              if (!useRealMode) {
                const styledNodeId = await styleFigmaNode(styleDescription, nodeId, fillColor, strokeColor, textProperties);
                return {
                  content: [{ 
                    type: "text", 
                    text: `Successfully styled node with ID: ${styledNodeId}` 
                  }],
                  isError: false,
                };
              } else {
                // In real mode, send the command but don't wait for response here
                sendPluginCommand(command).catch(error => {
                  logger.error('Error in plugin command execution', error as Error);
                });
                
                return {
                  content: [{ 
                    type: "text", 
                    text: `Processing request to style node...` 
                  }],
                  isError: false,
                  _isPlaceholder: true
                };
              }
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
              // Store the MCP request ID before making the plugin command call
              pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
              
              // First, create the wireframe
              const wireframeCommand: PluginCommand = {
                type: 'CREATE_WIREFRAME',
                payload: {
                  description: prompt.split('\n')[0] || prompt.substring(0, 50), // Use first line or first 50 chars
                  pages: ['Home'],
                  style: style,
                  designSystem: {
                    type: type
                  },
                  dimensions: {
                    width: type === 'mobile app' ? 375 : 1440,
                    height: type === 'mobile app' ? 812 : 900
                  },
                  renamePage: true
                },
                id: pluginCommandId // Use our trackable ID
              };
              
              if (!useRealMode) {
                const designId = await generateFigmaDesign(prompt, type, style);
                return {
                  content: [{ 
                    type: "text", 
                    text: `Successfully generated ${type} design based on prompt with root frame ID: ${designId}` 
                  }],
                  isError: false,
                };
              } else {
                // In real mode, send the wireframe command first
                const wireframeResponse = await sendPluginCommand<PluginResponse>(wireframeCommand);
                
                if (wireframeResponse.success && wireframeResponse.data?.pageIds && wireframeResponse.data.pageIds.length > 0) {
                  const pageId = wireframeResponse.data.pageIds[0];
                  
                  // Break down the prompt into individual UI elements with hierarchy
                  const elements = breakDownPromptIntoElements(prompt, type, style);
                  
                  logger.info(`Creating wireframe with ${elements.length} elements in a hierarchical structure...`);
                  
                  // Map to store created element IDs for parent-child relationships
                  const elementIdMap: {[key: string]: string} = {};
                  
                  // Create each element in sequence
                  for (let i = 0; i < elements.length; i++) {
                    const element = elements[i];
                    
                    // Generate a unique ID for each element command
                    const elementCommandId = `${pluginCommandId}_elem_${i}`;
                    
                    // Map to the same MCP request for the response
                    pluginBridge.storeMcpRequestId(elementCommandId, mcpRequestId);
                    
                    // Determine parent ID
                    let parentId = pageId;
                    if (element.childOf && elementIdMap[element.childOf]) {
                      parentId = elementIdMap[element.childOf];
                    }
                    
                    // Store element identifier for references
                    const elementKey = element.type + '-' + i;
                    
                    // Create the element command with positioning
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
                          styles: element.styles || {}
                        }
                      },
                      id: elementCommandId
                    };
                    
                    logger.info(`Creating element ${i+1}/${elements.length}: ${element.type} with parent ${parentId === pageId ? 'PAGE' : parentId}`);
                    
                    try {
                      // Send the command
                      const response = await sendPluginCommand<PluginResponse>(elementCommand);
                      
                      // Store the created element ID for future parent references
                      if (response.success && response.data?.id) {
                        elementIdMap[elementKey] = response.data.id;
                        
                        // If this is the root container for a type, store its ID
                        if (i === 0 || (element.childOf === undefined && element.type === 'frame')) {
                          // This is likely a container/main frame, register it with its proper name for child references
                          if (type === 'website' || type === 'landing page') {
                            elementIdMap['main-container'] = response.data.id;
                          } else if (type === 'mobile app') {
                            elementIdMap['app-container'] = response.data.id;
                          } else if (type === 'dashboard') {
                            elementIdMap['dashboard-container'] = response.data.id;
                          }
                          
                          if (element.description.includes('content')) {
                            elementIdMap['dashboard-content'] = response.data.id;
                          }
                        }
                        
                        logger.debug(`Created element ${elementKey} with ID ${response.data.id}`);
                      } else {
                        logger.warn(`Failed to create element ${elementKey}`, response.error);
                      }
                      
                      // Small delay to allow Figma to process each element
                      await new Promise(resolve => setTimeout(resolve, 300));
                    } catch (elemError) {
                      logger.warn(`Error creating element ${element.type}`, elemError as Error);
                      // Continue with other elements
                    }
                  }
                  
                  // Return success with reference to created element IDs map
                  return {
                    content: [{ 
                      type: "text", 
                      text: `Generated ${type} design with ${elements.length} properly positioned UI elements based on your description` 
                    }],
                    isError: false
                  };
                } else {
                  // If wireframe creation failed, just send the wireframe command but don't wait
                  sendPluginCommand(wireframeCommand).catch(error => {
                    logger.error('Error in plugin command execution', error as Error);
                  });
                  
                  return {
                    content: [{ 
                      type: "text", 
                      text: `Processing request to generate ${type} design...` 
                    }],
                    isError: false,
                    _isPlaceholder: true
                  };
                }
              }
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
              // Store the MCP request ID before making the plugin command call
              pluginBridge.storeMcpRequestId(pluginCommandId, mcpRequestId);
              
              // Call the plugin with the tracked command ID
              const command: PluginCommand = {
                type: 'EXPORT_DESIGN',
                payload: {
                  selection: nodeId ? [nodeId] : undefined,
                  settings: {
                    format: format.toUpperCase(),
                    constraint: {
                      type: 'SCALE',
                      value: scale
                    },
                    includeBackground
                  }
                },
                id: pluginCommandId // Use our trackable ID
              };
              
              if (!useRealMode) {
                const exportUrl = await exportFigmaDesign(nodeId, format, scale, includeBackground);
                return {
                  content: [{ 
                    type: "text", 
                    text: `Successfully exported design: ${exportUrl}` 
                  }],
                  isError: false,
                };
              } else {
                // In real mode, send the command but don't wait for response here
                sendPluginCommand(command).catch(error => {
                  logger.error('Error in plugin command execution', error as Error);
                });
                
                return {
                  content: [{ 
                    type: "text", 
                    text: `Processing request to export design...` 
                  }],
                  isError: false,
                  _isPlaceholder: true
                };
              }
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
