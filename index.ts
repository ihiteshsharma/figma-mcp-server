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
            logger.warn(`Failed to create element ${i}`, elementResponse.error);
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
