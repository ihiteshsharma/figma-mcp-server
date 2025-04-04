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

export type PluginResponse = {
  type: string;
  success: boolean;
  data?: any;
  error?: string;
  id?: string;
  _isResponse?: boolean;
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
  private pluginProcess: ChildProcess | null = null;
  private responseCallbacks: Map<string, (response: PluginResponse) => void> = new Map();
  private messageBuffer: string = '';
  private messageId: number = 0;
  private isMockMode: boolean = true;
  
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
  public async initialize(mockMode: boolean = true): Promise<void> {
    this.isMockMode = mockMode;
    
    try {
      if (mockMode) {
        console.log('Initializing plugin bridge in mock mode...');
        console.log('Plugin bridge initialized in mock mode');
        return Promise.resolve();
      } else {
        console.log('Initializing plugin bridge in real mode...');
        
        // Check if Figma CLI is installed
        let figmaCliInstalled = false;
        
        try {
          // Try to execute figma --version
          const childProcess = spawn('figma', ['--version']);
          await new Promise<void>((resolve) => {
            childProcess.on('close', (code) => {
              figmaCliInstalled = code === 0;
              resolve();
            });
          });
        } catch (e) {
          console.warn('Could not check for Figma CLI: ', e);
        }
        
        if (figmaCliInstalled) {
          console.log('Figma CLI detected, attempting to connect to plugin...');
          // Path to the plugin directory
          const pluginDir = path.resolve(__dirname, '../figma-plugin');
          
          if (!fs.existsSync(pluginDir)) {
            throw new Error(`Plugin directory not found: ${pluginDir}`);
          }
          
          // Try to run the plugin using Figma CLI
          try {
            // Launch the Figma plugin in a separate process
            this.pluginProcess = spawn('figma', ['run', '--target=plugin', '--verbose', pluginDir]);
            
            // Handle process output
            if (this.pluginProcess.stdout) {
              this.pluginProcess.stdout.on('data', (data: Buffer) => {
                const output = data.toString();
                console.log('Plugin output:', output);
                this.handlePluginOutput(output);
              });
            }
            
            if (this.pluginProcess.stderr) {
              this.pluginProcess.stderr.on('data', (data: Buffer) => {
                console.error('Plugin error:', data.toString());
              });
            }
            
            this.pluginProcess.on('close', (code) => {
              console.log(`Plugin process exited with code ${code}`);
              this.pluginProcess = null;
            });
            
            console.log('Figma plugin process started');
          } catch (error) {
            console.error('Failed to start Figma plugin process:', error);
            this.pluginProcess = null;
          }
        } else {
          console.warn('Figma CLI not found. You will need to run the plugin manually in Figma.');
          console.warn(`
==============================================================
MANUAL PLUGIN ACTIVATION REQUIRED
--------------------------------------------------------------
To connect with the Figma plugin:

1. Open the Figma desktop application
2. Open a design file (or create a new one)
3. Run the Figma MCP Server plugin from the plugins menu
4. The plugin UI will appear and start receiving commands
==============================================================
          `);
        }
        
        console.log('Plugin bridge initialized in real mode');
        return Promise.resolve();
      }
    } catch (error) {
      console.error('Failed to initialize plugin bridge:', error);
      throw error;
    }
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
        console.log(`Mock plugin received command: ${command.type}`);
        
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
      // Real mode implementation
      return new Promise((resolve, reject) => {
        try {
          console.log(`Sending real command to Figma plugin: ${command.type}`);
          
          // In real mode, we need to establish a connection to the actual Figma plugin
          // Since Figma plugins run in the browser and not as standalone processes,
          // we need to find an alternative approach
          
          // Option 1: Use Figma Plugin CLI if available
          if (this.pluginProcess) {
            console.log(`Sending command via plugin process: ${command.type}`);
            
            // Store the callback to handle the response
            const callback = (response: PluginResponse) => {
              // Update session context from the response
              this.updateSessionFromResponse(response);
              
              if (response.success) {
                resolve(response.data as T);
              } else {
                reject(new Error(response.error || 'Unknown error'));
              }
            };
            
            this.responseCallbacks.set(command.id!, callback);
            
            // Send the command to the plugin
            const commandJson = JSON.stringify(command) + '\n';
            if (this.pluginProcess.stdin) {
              this.pluginProcess.stdin.write(commandJson);
            } else {
              return reject(new Error('Plugin process stdin not available'));
            }
            
            return; // Exit early as we've handled the command
          }
          
          // Option 2: Launch the Figma desktop app with instructions
          console.log(`
==========================================================
REAL FIGMA PLUGIN COMMAND REQUESTED: ${command.type}
----------------------------------------------------------
To execute this in Figma:

1. Open Figma desktop app
2. Run your plugin from the plugins menu
3. The plugin should now receive and process this command:
   ${JSON.stringify(command, null, 2)}

The command will be processed when you run the plugin in Figma.
==========================================================
          `);
          
          // For now, simulate response to allow development without blocking
          const tempResponse: any = {
            type: command.type,
            success: true,
            data: {},
            id: command.id
          };
          
          // Return simulated data but with a longer delay and a warning
          setTimeout(() => {
            console.warn(`⚠️ USING SIMULATED RESPONSE - Plugin communication not fully implemented!`);
            console.warn(`⚠️ Open Figma and run the plugin for real results`);
            resolve(tempResponse as T);
          }, 2000);
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
        console.log(`Using active page ${this.sessionContext.activePageId} as parent for ADD_ELEMENT`);
      }
      
      // For STYLE_ELEMENT, if no elementId is specified, include the active page context
      if (command.type === 'STYLE_ELEMENT' && !command.payload.elementId) {
        console.log(`Including active page ${this.sessionContext.activePageId} context for STYLE_ELEMENT`);
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
      console.log(`Session context updated: activePageId = ${data.activePageId}`);
    }
    
    if (data.activeWireframeId) {
      this.sessionContext.activeWireframeId = data.activeWireframeId;
      console.log(`Session context updated: activeWireframeId = ${data.activeWireframeId}`);
    }
    
    // Update wireframes list if present
    if (data.wireframes) {
      this.sessionContext.wireframes = data.wireframes;
      console.log(`Session context updated: ${data.wireframes.length} wireframes`);
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
          
          console.log(`Added wireframe ${data.wireframeId} with ${data.pageIds.length} pages to session context`);
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

  // Process output from the plugin
  private handlePluginOutput(data: string): void {
    // Add new data to the buffer
    this.messageBuffer += data;
    
    // Process complete messages (separated by newlines)
    const lines = this.messageBuffer.split('\n');
    
    // Keep the last incomplete line in the buffer
    this.messageBuffer = lines.pop() || '';
    
    // Process each complete line
    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line) as PluginResponse;
          
          // If there's a response ID, call the corresponding callback
          if (response.id && this.responseCallbacks.has(response.id)) {
            const callback = this.responseCallbacks.get(response.id);
            if (callback) {
              callback(response);
              this.responseCallbacks.delete(response.id);
            }
          } else {
            console.log('Received message without callback:', response);
          }
        } catch (error) {
          console.error('Error parsing plugin response:', error, 'Raw data:', line);
        }
      }
    }
  }

  // Generate a unique ID for each command
  private generateId(): string {
    return `cmd_${Date.now()}_${this.messageId++}`;
  }

  // Check if Figma CLI is installed - replaced with mock implementation
  private async isFigmaCliInstalled(): Promise<boolean> {
    // Always return true since we're using a mock approach
    return Promise.resolve(true);
  }

  // Clean up resources when shutting down
  public shutdown(): void {
    console.log('Shutting down plugin bridge...');
    
    if (this.pluginProcess) {
      console.log('Terminating Figma plugin process');
      this.pluginProcess.kill();
      this.pluginProcess = null;
    }
    
    // Clear any pending callbacks
    this.responseCallbacks.clear();
    console.log('Plugin bridge shut down');
  }

  /**
   * Integrates the MCP server with the Figma plugin.
   * This method should be called by the MCP server to establish communication.
   */
  public connectToMCPServer(server: any): void {
    console.log('Connecting MCP server to Figma plugin...');
    
    // If we're in real mode, we'd set up direct communication here
    if (!this.isMockMode && this.pluginProcess) {
      console.log('Setting up real communication between MCP server and Figma plugin');
      
      // In a real implementation, we'd set up event handlers here
      // to forward messages between the MCP server and the Figma plugin
    } else {
      console.log('Using mock mode for MCP server to Figma plugin communication');
      
      // In mock mode, we don't need to do anything special
      // as the sendCommand method will handle everything
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
  
  console.log(`Sending command to plugin: ${command.type}`, command);
  
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
export async function initializePluginBridge(server: any, useMockMode: boolean = true): Promise<PluginBridge> {
  const bridge = getPluginBridge();
  
  try {
    await bridge.initialize(useMockMode);
    bridge.connectToMCPServer(server);
    return bridge;
  } catch (error) {
    console.error('Failed to initialize plugin bridge:', error);
    throw error;
  }
}

/**
 * Alternative approach to communicate with Figma plugin using a local web server
 * 
 * To use this approach:
 * 1. Run the MCP server with real mode
 * 2. The server will start a WebSocket server
 * 3. Open Figma and run the plugin
 * 4. The plugin will connect to the WebSocket server
 * 5. Commands and responses will be sent over the WebSocket connection
 */
export async function startWebSocketServer(port: number = 8080): Promise<void> {
  try {
    // This is a placeholder for implementing WebSocket communication
    // In a real implementation, you would:
    // 1. Start a WebSocket server on the specified port
    // 2. Accept connections from the Figma plugin
    // 3. Exchange messages between the MCP server and the plugin
    
    console.log(`
==============================================================
WEBSOCKET SERVER MODE
--------------------------------------------------------------
To connect with the Figma plugin via WebSocket:

1. Add WebSocket client code to your Figma plugin
2. Connect to ws://localhost:${port} from the plugin
3. Exchange messages using the same format as the existing API
4. Handle responses in both the plugin and the MCP server
==============================================================
    `);
    
    // This would be implemented with a WebSocket server library
    // For example using 'ws' or 'socket.io'
    
    return Promise.resolve();
  } catch (error) {
    console.error('Failed to start WebSocket server:', error);
    throw error;
  }
} 