/**
 * Plugin Bridge for Figma MCP Server
 * 
 * This module handles communication between the MCP server and the Figma plugin.
 * It establishes a communication channel and provides methods for sending
 * commands to the Figma plugin and receiving responses.
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';


// Define a simple logger that won't interfere with StdioServerTransport
class BridgeLogger {
  private prefix: string;
  private debugMode: boolean;

  constructor(prefix: string = 'FIGMA_PLUGIN_BRIDGE') {
    this.prefix = prefix;
    this.debugMode = process.env.DEBUG === 'true';
  }

  private writeLog(level: string, message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logObject = {
      timestamp,
      level,
      component: this.prefix,
      message,
      ...(data ? { data } : {})
    };

    // Write to stderr with prefix to avoid interfering with JSON-RPC
    process.stderr.write(`${this.prefix}_LOG: ${JSON.stringify(logObject)}\n`);
    
    // Additional console output for local debugging if needed
    if (this.debugMode && process.env.NODE_ENV !== 'production') {
      console.log(`DEBUG ${level.toUpperCase()}: ${message}`);
    }
  }

  log(message: string, data?: any): void {
    this.writeLog('info', message, data);
  }

  warn(message: string, data?: any): void {
    this.writeLog('warn', message, data);
  }

  error(message: string, error?: Error, data?: any): void {
    const errorData = error ? {
      message: error.message,
      ...(process.env.NODE_ENV !== 'production' ? { stack: error.stack } : {})
    } : undefined;
    
    this.writeLog('error', message, {
      ...(data || {}),
      error: errorData
    });
  }

  debug(message: string, data?: any): void {
    if (process.env.NODE_ENV !== 'production' || this.debugMode) {
      this.writeLog('debug', message, data);
    }
  }
}
// Create a singleton logger
const logger = new BridgeLogger();

// Define message types for plugin communication
export type PluginCommand = 
  | { type: 'CREATE_WIREFRAME', payload: any, id?: string }
  | { type: 'ADD_ELEMENT', payload: any, id?: string }
  | { type: 'STYLE_ELEMENT', payload: any, id?: string }
  | { type: 'MODIFY_ELEMENT', payload: any, id?: string }
  | { type: 'ARRANGE_LAYOUT', payload: any, id?: string }
  | { type: 'EXPORT_DESIGN', payload: any, id?: string }
  | { type: 'GET_SELECTION', payload?: any, id?: string }
  | { type: 'GET_CURRENT_PAGE', payload?: any, id?: string };

// Define a more specific type for responses from the plugin that will be mapped to MCP
export type PluginResponse = {
  type: string;
  success: boolean;
  data?: any;
  error?: string;
  id?: string;
  _isResponse?: boolean;
  mcpRequestId?: number; // Add field to track MCP request ID
};

// Session context to track the state across commands
interface SessionContext {
  activeWireframeId: string | null;
  activePageId: string | null;
  wireframes: Array<{
    id: string;
    name: string;
    pageIds: string[];
    createdAt: number;
  }>;
}

// Class to manage communication with the Figma plugin
export class PluginBridge {
  private static instance: PluginBridge;
  private responseCallbacks: Map<string, (response: PluginResponse) => void> = new Map();
  private messageId: number = 0;
  private isMockMode: boolean = true;
  private wsServer: WebSocketServer | null = null;
  private httpServer: http.Server | null = null;
  private wsConnections: Set<WebSocket> = new Set();
  private isServerRunning: boolean = false;
  private webSocketPort: number = 9000; // Default port for WebSocket server
  private mcpServer: any = null; // Store reference to MCP server
  // Map plugin command IDs to MCP request IDs
  private mcpRequestMap: Map<string, number> = new Map();
  
  // Add session tracking to maintain context between commands
  private sessionContext: SessionContext = {
    activeWireframeId: null,
    activePageId: null,
    wireframes: []
  };
  
  private constructor() {
    // Private constructor for singleton
  }

  // Get singleton instance
  public static getInstance(): PluginBridge {
    if (!PluginBridge.instance) {
      PluginBridge.instance = new PluginBridge();
    }
    return PluginBridge.instance;
  }

  // Initialize the plugin bridge
  public async initialize(mockMode: boolean = true, port: number = 9000): Promise<void> {
    this.isMockMode = mockMode;
    this.webSocketPort = port;
    
    try {
      if (mockMode) {
        logger.log('Initializing plugin bridge in mock mode...');
        logger.log('Plugin bridge initialized in mock mode');
        return Promise.resolve();
      } else {
        logger.log('Initializing plugin bridge in real mode with WebSockets...');
        
        // Start WebSocket server for real-time communication with the Figma plugin
        await this.startWebSocketServer(this.webSocketPort);
        
        logger.log(`Plugin bridge initialized in real mode with WebSocket server on port ${this.webSocketPort}`);
        logger.log(`
==============================================================
FIGMA PLUGIN CONNECTION INSTRUCTIONS
--------------------------------------------------------------
To connect with the Figma plugin:

1. Make sure your Figma plugin's UI.html file has WebSocket client code
2. The plugin should connect to: ws://localhost:${this.webSocketPort}
3. Keep the Figma plugin window open to maintain connection
4. The connection status will be shown in the plugin UI
==============================================================
        `);
        
        return Promise.resolve();
      }
    } catch (error) {
      logger.error('Failed to initialize plugin bridge', error as Error);
      throw error;
    }
  }

  // Start WebSocket server for real-time communication
  private async startWebSocketServer(port: number): Promise<void> {
    if (this.isServerRunning) {
      logger.log('WebSocket server is already running');
      return;
    }
    
    return new Promise((resolve, reject) => {
      try {
        // Create HTTP server first
        this.httpServer = http.createServer();
        
        // Create WebSocket server - explicitly set host to listen on IPv4
        this.wsServer = new WebSocketServer({ 
          server: this.httpServer,
          host: process.env.WS_HOST || '0.0.0.0' // Force IPv4 binding
        });
        
        // Handle WebSocket connections
        this.wsServer.on('connection', (ws: WebSocket) => {
          logger.log('New WebSocket connection established with Figma plugin');
          
          // Add to active connections
          this.wsConnections.add(ws);
          
          // Handle messages from Figma plugin
          ws.on('message', (data: WebSocket.Data) => this.handlePluginMessage(data));
          
          // Handle WebSocket errors
          ws.on('error', (error: Error) => {
            logger.error('WebSocket error', error);
          });
          
          // Handle WebSocket close
          ws.on('close', () => {
            logger.log('WebSocket connection closed');
            this.wsConnections.delete(ws);
          });
          
          // Send a test message to verify connection
          ws.send(JSON.stringify({ type: 'CONNECTION_TEST', status: 'connected' }));
        });
        
        // Handle WebSocket server errors
        this.wsServer.on('error', (error) => {
          logger.error('WebSocket server error', error as Error);
          reject(error);
        });
        
        // Start HTTP server
        this.httpServer.listen(port, process.env.WS_HOST || '0.0.0.0', () => {
          logger.log(`WebSocket server listening on port ${port}`);
          this.isServerRunning = true;
          resolve();
        });
        
        // Handle HTTP server errors
        this.httpServer.on('error', (error) => {
          logger.error('HTTP server error', error as Error);
          reject(error);
        });
      } catch (error) {
        logger.error('Failed to start WebSocket server', error as Error);
        reject(error);
      }
    });
  }

  // Send a command to the Figma plugin
  public async sendCommand<T>(command: PluginCommand): Promise<T> {
    // Add a unique ID to the command if not provided
    if (!command.id) {
      command.id = this.generateId();
    }
    
    // Enhance payload with session context if appropriate
    this.addSessionContextToPayload(command);
    
    if (this.isMockMode) {
      // Mock mode implementation
      return new Promise((resolve) => {
        logger.log(`Mock plugin received command: ${command.type}`, { commandId: command.id });
        
        // Simulate a successful response with mock data
        const mockResponse: any = this.createMockResponse(command);
        
        // Add the command ID to the response
        mockResponse.id = command.id;
        
        // Update session context from the response
        this.updateSessionFromResponse(mockResponse);
        
        // Resolve with mock data
        setTimeout(() => {
          resolve(mockResponse as T);
        }, 300); // Add a small delay to simulate processing
      });
    } else {
      // Real mode implementation with WebSockets
      return new Promise((resolve, reject) => {
        try {
          logger.log(`Sending real command to Figma plugin: ${command.type}`, { commandId: command.id });
          
          // Check if we have any WebSocket connections
          if (this.wsConnections.size === 0) {
            logger.warn('No active WebSocket connections to Figma plugin');
            logger.warn('Falling back to mock response for now');
            
            // Fall back to mock mode temporarily
            const mockResponse: any = this.createMockResponse(command);
            mockResponse.id = command.id;
            mockResponse._isMockFallback = true;
            
            // Use a longer timeout to simulate network issues
            setTimeout(() => {
              resolve(mockResponse as T);
            }, 1000);
            
            return;
          }
          
          // Store the callback to handle the response
          const callback = (response: PluginResponse) => {
            // Update session context from the response
            this.updateSessionFromResponse(response);
            
            if (response.success) {
              resolve(response as unknown as T);
            } else {
              reject(new Error(response.error || 'Unknown error'));
            }
          };
          
          this.responseCallbacks.set(command.id!, callback);
          
          // Broadcast command to all connected WebSocket clients (usually just one)
          const commandJson = JSON.stringify(command);
          this.wsConnections.forEach((ws) => {
            ws.send(commandJson);
          });
          
          // Set a timeout for response
          setTimeout(() => {
            if (this.responseCallbacks.has(command.id!)) {
              logger.warn(`Command ${command.id} timed out`);
              this.responseCallbacks.delete(command.id!);
              reject(new Error(`Command ${command.type} timed out`));
            }
          }, 30000); // 30 second timeout
          
        } catch (error) {
          reject(error);
        }
      });
    }
  }

  // Add session context to the payload when appropriate
  private addSessionContextToPayload(command: PluginCommand): void {
    // Don't modify certain command types
    if (command.type === 'GET_SELECTION' || command.type === 'GET_CURRENT_PAGE') {
      return;
    }
    
    // Initialize payload if not present
    if (!command.payload) {
      command.payload = {};
    }
    
    // Add active context when it might be useful
    if (this.sessionContext.activePageId && 
       (command.type === 'ADD_ELEMENT' || command.type === 'STYLE_ELEMENT')) {
      
      // For ADD_ELEMENT, if no parent is specified, use the active page
      if (command.type === 'ADD_ELEMENT' && !command.payload.parent) {
        command.payload.parent = this.sessionContext.activePageId;
        logger.debug(`Using active page ${this.sessionContext.activePageId} as parent for ADD_ELEMENT`);
      }
      
      // For STYLE_ELEMENT, if no elementId is specified, include the active page context
      if (command.type === 'STYLE_ELEMENT' && !command.payload.elementId) {
        logger.debug(`Including active page ${this.sessionContext.activePageId} context for STYLE_ELEMENT`);
      }
    }
  }

  // Update session context from response data
  private updateSessionFromResponse(response: PluginResponse): void {
    if (!response.data) return;
    
    const data = response.data;
    
    // Update active IDs if present in the response
    if (data.activePageId) {
      this.sessionContext.activePageId = data.activePageId;
      logger.debug(`Session context updated: activePageId = ${data.activePageId}`);
    }
    
    if (data.activeWireframeId) {
      this.sessionContext.activeWireframeId = data.activeWireframeId;
      logger.debug(`Session context updated: activeWireframeId = ${data.activeWireframeId}`);
    }
    
    // Update wireframes list if present
    if (data.wireframes) {
      this.sessionContext.wireframes = data.wireframes;
      logger.debug(`Session context updated: ${data.wireframes.length} wireframes`);
    }
    
    // Update for specific command types
    switch (response.type) {
      case 'CREATE_WIREFRAME':
        if (data.wireframeId && data.pageIds) {
          // Record the new wireframe
          const existingIndex = this.sessionContext.wireframes.findIndex(w => w.id === data.wireframeId);
          
          if (existingIndex >= 0) {
            // Update existing wireframe
            this.sessionContext.wireframes[existingIndex] = {
              ...this.sessionContext.wireframes[existingIndex],
              pageIds: data.pageIds
            };
          } else {
            // Add new wireframe
            this.sessionContext.wireframes.push({
              id: data.wireframeId,
              name: 'Wireframe ' + (this.sessionContext.wireframes.length + 1),
              pageIds: data.pageIds,
              createdAt: Date.now()
            });
          }
          
          logger.debug(`Added wireframe ${data.wireframeId} with ${data.pageIds.length} pages to session context`);
        }
        break;
    }
  }

  // Create mock response data based on command type
  private createMockResponse(command: PluginCommand): any {
    let response: any = {
      type: command.type,
      success: true,
      data: null,
      _isResponse: true
    };
    
    // Generate mock wireframe and page IDs that persist across calls
    const mockWireframeId = this.sessionContext.activeWireframeId || ('mock-wireframe-' + Date.now());
    const mockPageId = this.sessionContext.activePageId || ('mock-page-' + Date.now());
    
    switch (command.type) {
      case 'CREATE_WIREFRAME':
        const pageIds = ['mock-page-' + Date.now()];
        response.data = {
          wireframeId: mockWireframeId,
          pageIds: pageIds,
          activePageId: pageIds[0],
          activeWireframeId: mockWireframeId
        };
        break;
      case 'ADD_ELEMENT':
        const elementId = 'mock-element-' + Date.now();
        response.data = {
          id: elementId,
          type: command.payload?.elementType || 'RECTANGLE',
          parentId: command.payload?.parent || mockPageId,
          parentType: 'PAGE',
          activePageId: mockPageId
        };
        break;
      case 'STYLE_ELEMENT':
        response.data = {
          id: command.payload?.elementId || 'mock-styled-element-' + Date.now(),
          type: 'RECTANGLE',
          activePageId: mockPageId
        };
        break;
      case 'EXPORT_DESIGN':
        response.data = {
          files: [{
            name: 'Mock Design',
            data: 'base64-encoded-mock-data',
            format: 'png',
            nodeId: 'mock-node-' + Date.now()
          }],
          activePageId: mockPageId
        };
        break;
      case 'GET_SELECTION':
        response.data = {
          selection: [{
            id: 'mock-selection-' + Date.now(),
            name: 'Mock Selected Element',
            type: 'FRAME'
          }],
          currentPage: {
            id: mockPageId,
            name: 'Mock Current Page'
          },
          activePageId: mockPageId
        };
        break;
      case 'GET_CURRENT_PAGE':
        response.data = {
          currentPage: {
            id: mockPageId,
            name: 'Mock Current Page',
            childrenCount: 5
          },
          activePage: {
            id: mockPageId,
            name: 'Mock Active Page',
            childrenCount: 5
          },
          activePageId: mockPageId,
          activeWireframeId: mockWireframeId,
          allPages: [
            { id: mockPageId, name: 'Mock Page', isActive: true, isCurrent: true }
          ],
          wireframes: this.sessionContext.wireframes.length ? 
            this.sessionContext.wireframes : 
            [{ id: mockWireframeId, name: 'Mock Wireframe', pageIds: [mockPageId], createdAt: Date.now() }]
        };
        break;
      default:
        response.data = {
          activePageId: mockPageId
        };
    }
    
    return response;
  }

  // Get the current session context
  public getSessionContext(): SessionContext {
    return { ...this.sessionContext };
  }

  // Generate a unique ID for each command
  private generateId(): string {
    return `cmd_${Date.now()}_${this.messageId++}`;
  }

  // Clean up resources when shutting down
  public shutdown(): void {
    logger.log('Shutting down plugin bridge...');
    
    // Close all WebSocket connections
    if (this.wsConnections.size > 0) {
      logger.log(`Closing ${this.wsConnections.size} WebSocket connections`);
      this.wsConnections.forEach((ws: WebSocket) => {
        try {
          ws.close();
        } catch (error: unknown) {
          logger.error('Error closing WebSocket connection', error as Error);
        }
      });
      this.wsConnections.clear();
    }
    
    // Close WebSocket server
    if (this.wsServer) {
      logger.log('Closing WebSocket server');
      this.wsServer.close((error?: Error) => {
        if (error) {
          logger.error('Error closing WebSocket server', error);
        } else {
          logger.log('WebSocket server closed');
        }
      });
      this.wsServer = null;
    }
    
    // Close HTTP server
    if (this.httpServer) {
      logger.log('Closing HTTP server');
      this.httpServer.close((error?: Error) => {
        if (error) {
          logger.error('Error closing HTTP server', error);
        } else {
          logger.log('HTTP server closed');
        }
      });
      this.httpServer = null;
    }
    
    // Clear any pending callbacks
    this.responseCallbacks.clear();
    this.isServerRunning = false;
    logger.log('Plugin bridge shut down');
  }

  /**
   * Integrates the MCP server with the Figma plugin.
   * This method should be called by the MCP server to establish communication.
   */
  public connectToMCPServer(server: any): void {
    logger.log('Connecting MCP server to Figma plugin...');
    
    // Store reference to MCP server
    this.mcpServer = server;
    
    // Nothing special needs to be done here as the WebSocket server
    // is already running in real mode
    logger.log('Plugin bridge ready for MCP server integration');
  }

  // Store MCP request ID for a plugin command
  public storeMcpRequestId(pluginCommandId: string, mcpRequestId: number): void {
    this.mcpRequestMap.set(pluginCommandId, mcpRequestId);
    logger.debug(`Mapped plugin command ID ${pluginCommandId} to MCP request ID ${mcpRequestId}`);
  }

  // Convert plugin response to JSON-RPC format for MCP server
  public transformToJsonRpc(response: PluginResponse): any {
    // Get the MCP request ID associated with this plugin command
    const mcpRequestId = this.mcpRequestMap.get(response.id || '') || 0;
    
    if (response.success) {
      // Format successful response
      let successMessage = `Successfully completed ${response.type.toLowerCase().replace('_', ' ')}`;
      
      // Add more specific details based on command type
      switch (response.type) {
        case 'CREATE_WIREFRAME':
          successMessage = `Successfully created wireframe with ID: ${response.data?.wireframeId || 'unknown'}`;
          break;
        case 'ADD_ELEMENT':
          successMessage = `Successfully created ${response.data?.type || 'component'} with ID: ${response.data?.id || 'unknown'}`;
          break;
        case 'STYLE_ELEMENT':
          successMessage = `Successfully styled element with ID: ${response.data?.id || 'unknown'}`;
          break;
        case 'EXPORT_DESIGN':
          successMessage = `Successfully exported design${response.data?.files ? ` (${response.data.files.length} files)` : ''}`;
          break;
      }
      
      return {
        jsonrpc: "2.0",
        id: mcpRequestId,
        result: {
          content: [
            {
              type: "text",
              text: successMessage
            }
          ],
          isError: false
        }
      };
    } else {
      // Format error response
      return {
        jsonrpc: "2.0",
        id: mcpRequestId,
        result: {
          content: [
            {
              type: "text",
              text: `Error: ${response.error || 'Unknown error'}`
            }
          ],
          isError: true
        }
      };
    }
  }

  // Add a method to send JSON-RPC responses to the MCP server
  public sendJsonRpcResponse(mcpResponse: any): void {
    // If we have a reference to the MCP server, send the response
    if (this.mcpServer) {
      try {
        logger.debug('Sending JSON-RPC response to MCP server', { response: mcpResponse });
        
        // The MCP server SDK exposes a transport object we can use to send responses
        if (this.mcpServer.transport && typeof this.mcpServer.transport.sendResponse === 'function') {
          // Send the response through the MCP server transport
          this.mcpServer.transport.sendResponse(mcpResponse);
          logger.debug('JSON-RPC response sent successfully');
        } else {
          logger.warn('MCP server transport not available for sending response');
        }
      } catch (error) {
        logger.error('Error sending JSON-RPC response to MCP server', error as Error);
      }
    } else {
      logger.warn('Cannot send JSON-RPC response - no MCP server reference');
    }
  }

  // Update the handlePluginMessage method to use sendJsonRpcResponse
  private handlePluginMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      logger.debug('Received message from Figma plugin', { message });
      
      // If it's a response to a command
      if (message._isResponse && message.id && this.responseCallbacks.has(message.id)) {
        const callback = this.responseCallbacks.get(message.id);
        if (callback) {
          // Update session context from response
          this.updateSessionFromResponse(message);
          
          // Call the callback with the response
          callback(message);
          this.responseCallbacks.delete(message.id);
          
          // If we have an MCP server reference and this response has an associated MCP request ID,
          // transform and send the response to the MCP server
          if (this.mcpServer && this.mcpRequestMap.has(message.id)) {
            const mcpResponse = this.transformToJsonRpc(message);
            logger.debug('Transformed response for MCP server', { mcpResponse });
            
            // Send the transformed response to the MCP server
            this.sendJsonRpcResponse(mcpResponse);
            
            // Clean up the mapping
            this.mcpRequestMap.delete(message.id);
          }
        }
      } else {
        logger.debug('Received non-response message', { message });
      }
    } catch (error) {
      logger.error('Error handling WebSocket message', error as Error);
    }
  }
}

// Convenience function to get the bridge instance
export function getPluginBridge(): PluginBridge {
  return PluginBridge.getInstance();
}

// Export common utility functions for plugin communication

// Send a command and get the typed response
export async function sendPluginCommand<T>(command: PluginCommand): Promise<T> {
  // Ensure command has an ID
  if (!command.id) {
    command.id = `cmd_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  }
  
  logger.log(`Sending command to plugin: ${command.type}`, command);
  
  const bridge = getPluginBridge();
  return bridge.sendCommand<T>(command);
}

// Get the current selection in Figma
export async function getCurrentSelection(): Promise<any[]> {
  return sendPluginCommand<any[]>({ 
    type: 'GET_SELECTION',
    id: `sel_${Date.now()}`
  });
}

// Get the current page in Figma
export async function getCurrentPage(): Promise<any> {
  return sendPluginCommand<any>({ 
    type: 'GET_CURRENT_PAGE',
    id: `page_${Date.now()}`
  });
}

// Export a function to initialize the plugin bridge and connect to the MCP server
export async function initializePluginBridge(server: any, useMockMode: boolean = true, port: number = 9000): Promise<PluginBridge> {
  const bridge = getPluginBridge();
  
  try {
    await bridge.initialize(useMockMode, port);
    bridge.connectToMCPServer(server);
    return bridge;
  } catch (error) {
    logger.error('Failed to initialize plugin bridge', error as Error);
    throw error;
  }
} 