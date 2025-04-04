/**
 * Figma Plugin for MCP Server
 * 
 * This is the main plugin code that runs in the Figma environment
 * and communicates with the MCP server
 */

/// <reference types="@figma/plugin-typings" />

// Command types supported by the plugin
type CommandType = 
  | 'CREATE_WIREFRAME'
  | 'ADD_ELEMENT' 
  | 'STYLE_ELEMENT'
  | 'MODIFY_ELEMENT'
  | 'ARRANGE_LAYOUT'
  | 'EXPORT_DESIGN'
  | 'GET_SELECTION'
  | 'GET_CURRENT_PAGE';

// Message structure for communication
interface PluginMessage {
  type: CommandType;
  payload: any;
  id: string;
  _isResponse?: boolean;
}

// Response structure
interface PluginResponse {
  type: string;
  success: boolean;
  data?: any;
  error?: string;
  id?: string;
  _isResponse?: boolean;
}

// Session state to track created pages and active context
const sessionState = {
  // Store created pages with a mapping from their IDs to metadata
  createdPages: new Map<string, {
    name: string,
    wireframeId?: string,
    pageIds: string[],
    createdAt: number
  }>(),
  
  // Keep track of the currently active wireframe context
  activeWireframeId: null as string | null,
  activePageId: null as string | null,
  
  // Record the active wireframe
  setActiveWireframe(wireframeId: string, pageId: string, name: string) {
    this.activeWireframeId = wireframeId;
    this.activePageId = pageId;
    
    // Also store in the createdPages map if not already there
    if (!this.createdPages.has(wireframeId)) {
      this.createdPages.set(wireframeId, {
        name,
        wireframeId,
        pageIds: [pageId],
        createdAt: Date.now()
      });
    }
    
    console.log(`Set active wireframe: ${wireframeId}, page: ${pageId}, name: ${name}`);
  },
  
  // Get the active page ID - this should be used by all commands
  getActivePageId(): string | null {
    // If we have an active page ID, return it
    if (this.activePageId) {
      // Verify it still exists
      const page = figma.getNodeById(this.activePageId);
      if (page) {
        return this.activePageId;
      } else {
        console.warn(`Active page ${this.activePageId} no longer exists, resetting`);
        this.activePageId = null;
      }
    }
    
    // Fallback to current page
    return figma.currentPage.id;
  },
  
  // Switch to a specific page
  switchToPage(pageId: string): boolean {
    const page = figma.getNodeById(pageId);
    if (page && page.type === 'PAGE') {
      figma.currentPage = page as PageNode;
      this.activePageId = pageId;
      return true;
    }
    return false;
  },
  
  // Get list of all created wireframes
  getWireframes(): Array<{ id: string, name: string, pageIds: string[], createdAt: number }> {
    const result: Array<{ id: string, name: string, pageIds: string[], createdAt: number }> = [];
    
    this.createdPages.forEach((data, id) => {
      result.push({
        id,
        name: data.name,
        pageIds: data.pageIds,
        createdAt: data.createdAt
      });
    });
    
    return result;
  }
};

// Function to send a response back to the MCP server
function sendResponse(response: PluginResponse): void {
  // We don't need to check if UI is visible since figma.ui.show() is safe to call
  // even if the UI is already visible
  figma.ui.show();
  
  // Mark message as a response to avoid handling it as a new command when it echoes back
  response._isResponse = true;
  
  // Send the message to the UI
  figma.ui.postMessage(response);
}

// Handle messages from the MCP server
figma.ui.onmessage = async (message: PluginMessage | { type: string, _isResponse?: boolean }) => {
  console.log('Raw message received from UI:', message);
  
  // Skip if this is a response message (our own message echoed back)
  if (message._isResponse) {
    console.log('Ignoring echo of our own response message');
    return;
  }
  
  // Handle UI_READY message
  if (message.type === 'UI_READY') {
    console.log('UI is ready to receive messages');
    return;
  }
  
  // Continue with existing message handling for PluginMessage types
  const pluginMessage = message as PluginMessage;
  console.log('Plugin message:', pluginMessage);
  
  // Ensure payload exists - if not, create an empty object to prevent undefined errors
  if (!pluginMessage.payload) {
    console.error('Missing payload in message:', pluginMessage);
    pluginMessage.payload = {}; // Create empty payload to avoid null reference errors
  }
  
  try {
    switch (pluginMessage.type) {
      case 'CREATE_WIREFRAME':
        await handleCreateWireframe(pluginMessage);
        break;
      case 'ADD_ELEMENT':
        await handleAddElement(pluginMessage);
        break;
      case 'STYLE_ELEMENT':
        await handleStyleElement(pluginMessage);
        break;
      case 'MODIFY_ELEMENT':
        await handleModifyElement(pluginMessage);
        break;
      case 'ARRANGE_LAYOUT':
        await handleArrangeLayout(pluginMessage);
        break;
      case 'EXPORT_DESIGN':
        await handleExportDesign(pluginMessage);
        break;
      case 'GET_SELECTION':
        handleGetSelection(pluginMessage);
        break;
      case 'GET_CURRENT_PAGE':
        handleGetCurrentPage(pluginMessage);
        break;
      default:
        throw new Error(`Unknown command type: ${pluginMessage.type}`);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    sendResponse({
      type: pluginMessage.type,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      id: pluginMessage.id
    });
  }
};

/**
 * Creates a new wireframe based on the description and parameters
 */
async function handleCreateWireframe(message: PluginMessage): Promise<void> {
  console.log('Message received:', message);
  console.log('Creating wireframe with payload:', message.payload);
  console.log('Payload type:', typeof message.payload);
  console.log('Payload keys:', message.payload ? Object.keys(message.payload) : 'No keys');
  
  // Validate payload exists
  if (!message.payload) {
    throw new Error('No payload provided for CREATE_WIREFRAME command');
  }
  
  // Destructure with defaults to avoid errors
  const { 
    description = 'Untitled Wireframe', 
    pages = ['Home'], 
    style = 'minimal', 
    designSystem = {}, 
    dimensions = { width: 1440, height: 900 } 
  } = message.payload;
  
  console.log('Extracted values:', { description, pages, style, dimensions });
  
  // Use the current page instead of creating a new one
  const activePage = figma.currentPage;
  console.log(`Using current page: ${activePage.name} (${activePage.id})`);

  // Rename the current page to include wireframe name if requested
  const shouldRenamePage = message.payload.renamePage === true;
  if (shouldRenamePage) {
    activePage.name = `Wireframe: ${description.slice(0, 20)}${description.length > 20 ? '...' : ''}`;
    console.log(`Renamed current page to: ${activePage.name}`);
  }
  
  // Create frames for all the specified pages
  const pageFrames: FrameNode[] = [];
  const pageIds: string[] = [];
  
  // Default frame size
  const width = dimensions?.width || 1440;
  const height = dimensions?.height || 900;
  
  // Create a frame for each page
  for (const pageName of pages) {
    const frame = figma.createFrame();
    frame.name = pageName;
    frame.resize(width, height);
    frame.x = pageFrames.length * (width + 100); // Space frames apart
    
    // Add the frame to the current page
    activePage.appendChild(frame);
    
    // Apply base styling based on the specified style
    applyBaseStyle(frame, style, designSystem);
    
    pageFrames.push(frame);
    pageIds.push(frame.id);
  }
  
  // Update session state with this new wireframe - use the first frame as the wireframe ID
  const wireframeId = pageIds.length > 0 ? pageIds[0] : activePage.id;
  sessionState.setActiveWireframe(wireframeId, activePage.id, description);
  
  // Send success response with session context
  sendResponse({
    type: message.type,
    success: true,
    data: {
      wireframeId: wireframeId,
      pageIds: pageIds,
      activePageId: activePage.id,
      activeWireframeId: wireframeId
    },
    id: message.id
  });
}

/**
 * Applies base styling to a frame based on design parameters
 */
function applyBaseStyle(frame: FrameNode, style: string = 'minimal', designSystem?: any): void {
  // Set background color based on style
  switch (style.toLowerCase()) {
    case 'minimal':
      frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
      break;
    case 'dark':
      frame.fills = [{ type: 'SOLID', color: { r: 0.1, g: 0.1, b: 0.1 } }];
      break;
    case 'colorful':
      frame.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }];
      break;
    default:
      frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  }
}

/**
 * Adds a new element to the design
 */
async function handleAddElement(message: PluginMessage): Promise<void> {
  console.log('Message received for ADD_ELEMENT:', message);
  console.log('Add element payload:', message.payload);
  
  // Validate payload exists
  if (!message.payload) {
    console.error('No payload provided for ADD_ELEMENT command');
    throw new Error('No payload provided for ADD_ELEMENT command');
  }
  
  // Destructure with defaults to avoid errors
  const { 
    elementType = 'RECTANGLE', 
    parent = null, // Default to null so we can use session state
    properties = {} 
  } = message.payload;
  
  console.log('Extracted values for ADD_ELEMENT:', { elementType, parent, properties });
  
  // Get parent node based on prioritized logic:
  // 1. Use provided parent ID if valid
  // 2. Use active page from session if available
  // 3. Fall back to current page
  
  let parentNode: BaseNode | null = null;
  let parentSource = 'provided';
  
  // Try to use provided parent first
  if (parent) {
    parentNode = figma.getNodeById(parent);
    if (!parentNode) {
      console.warn(`Provided parent node ID ${parent} is invalid`);
      parentSource = 'invalid';
    }
  }
  
  // If no valid parent node yet, try active page from session
  if (!parentNode) {
    const activePageId = sessionState.getActivePageId();
    if (activePageId) {
      parentNode = figma.getNodeById(activePageId);
      if (parentNode) {
        parentSource = 'session';
        console.log(`Using active page from session: ${activePageId}`);
        
        // Ensure we're on that page by making it current
        if (parentNode.type === 'PAGE') {
          figma.currentPage = parentNode as PageNode;
        }
      }
    }
  }
  
  // If still no valid parent, use current page
  if (!parentNode) {
    parentNode = figma.currentPage;
    parentSource = 'current';
    console.log(`Using current page as parent: ${parentNode.id}`);
  }
  
  // Log parent resolution
  console.log(`Parent node resolved to ${parentNode.id} (${parentNode.type}) via ${parentSource}`);
  
  // Create the element
  let element: BaseNode | null = null;
  
  try {
    // Handle different parent types
    if (parentNode.type === 'PAGE') {
      // If parent is a page, create the element directly on the page
      const page = parentNode as PageNode;
      
      if (elementType === 'TEXT') {
        element = figma.createText();
        page.appendChild(element);
        if (properties.name) element.name = properties.name;
        
        // Load font before setting characters
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        
        if (properties.content || properties.text) {
          element.characters = properties.content || properties.text || 'Text';
        }
      } else if (elementType === 'RECTANGLE') {
        element = figma.createRectangle();
        page.appendChild(element);
        if (properties.name) element.name = properties.name;
        if (properties.width && properties.height) {
          element.resize(properties.width, properties.height);
        }
      } else {
        // For other types, try to use appropriate creation function or fallback to frame
        switch (elementType) {
          case 'BUTTON':
            element = await createButtonOnPage(page, properties);
            break;
          case 'INPUT':
            element = await createInputOnPage(page, properties);
            break;
          case 'FRAME':
            element = figma.createFrame();
            page.appendChild(element);
            element.name = properties.name || 'Frame';
            break;
          default:
            // Fallback for unsupported types
            element = figma.createFrame();
            page.appendChild(element);
            element.name = `${elementType} (fallback)`;
            break;
        }
      }
    } else if (parentNode.type === 'FRAME' || parentNode.type === 'GROUP' || 
               parentNode.type === 'COMPONENT' || parentNode.type === 'INSTANCE') {
      // If parent is a container node, use our existing creation functions
      const container = parentNode as FrameNode | GroupNode | ComponentNode | InstanceNode;
      
      switch (elementType) {
        case 'TEXT':
          element = await createTextElement(container, properties);
          break;
        case 'RECTANGLE':
          element = createRectangleElement(container, properties);
          break;
        case 'BUTTON':
          element = await createButtonElement(container, properties);
          break;
        case 'INPUT':
          element = await createInputElement(container, properties);
          break;
        case 'FRAME':
          element = createFrameElement(container, properties);
          break;
        case 'NAVBAR':
          element = await createNavbarElement(container, properties);
          break;
        case 'CARD':
          element = await createCardElement(container, properties);
          break;
        case 'FOOTER':
          element = await createFooterElement(container, properties);
          break;
        default:
          console.warn(`Unsupported element type: ${elementType}, creating rectangle instead`);
          element = createRectangleElement(container, {
            ...properties,
            name: `${elementType} (fallback)`
          });
      }
    } else {
      // For other parent types, fallback to current page
      console.warn(`Unsupported parent type: ${parentNode.type}, using current page instead`);
      const page = figma.currentPage;
      element = figma.createRectangle();
      page.appendChild(element);
      element.name = properties.name || `${elementType} (fallback)`;
    }
  } catch (error) {
    console.error('Error creating element:', error);
    throw new Error(`Failed to create ${elementType}: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  if (!element) {
    throw new Error(`Failed to create ${elementType}: Unknown error`);
  }
  
  // Send success response with context
  sendResponse({
    type: message.type,
    success: true,
    data: {
      id: element.id,
      type: element.type,
      parentId: parentNode.id,
      parentType: parentNode.type,
      activePageId: sessionState.getActivePageId()
    },
    id: message.id
  });
}

/**
 * Helper function to create a button directly on a page
 */
async function createButtonOnPage(page: PageNode, properties: any): Promise<FrameNode> {
  const button = figma.createFrame();
  button.name = properties.name || 'Button';
  page.appendChild(button);
  
  // Set button size
  const width = properties.width || 120;
  const height = properties.height || 40;
  button.resize(width, height);
  
  // Set button corner radius
  button.cornerRadius = properties.cornerRadius || 4;
  
  // Create button text
  const text = figma.createText();
  button.appendChild(text);
  
  // Load font before setting characters
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  text.characters = properties.text || 'Button';
  text.textAlignHorizontal = 'CENTER';
  text.textAlignVertical = 'CENTER';
  
  // Center the text in the button
  text.resize(width, height);
  
  return button;
}

/**
 * Helper function to create an input field directly on a page
 */
async function createInputOnPage(page: PageNode, properties: any): Promise<FrameNode> {
  const input = figma.createFrame();
  input.name = properties.name || 'Input Field';
  page.appendChild(input);
  
  // Set input size
  const width = properties.width || 240;
  const height = properties.height || 40;
  input.resize(width, height);
  
  // Set input corner radius
  input.cornerRadius = properties.cornerRadius || 4;
  
  // Create placeholder text
  const text = figma.createText();
  input.appendChild(text);
  
  // Load font before setting characters
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  text.characters = properties.placeholder || 'Enter text...';
  text.textAlignVertical = 'CENTER';
  
  // Position the text inside the input with padding
  text.x = 8;
  text.resize(width - 16, height);
  
  return input;
}

/**
 * Creates a text element with the specified properties
 */
async function createTextElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<TextNode> {
  const text = figma.createText();
  parent.appendChild(text);
  
  // Apply basic text properties
  if (properties.name) text.name = properties.name;
  if (properties.x !== undefined) text.x = properties.x;
  if (properties.y !== undefined) text.y = properties.y;
  if (properties.width !== undefined) text.resize(properties.width, text.height);
  
  // Load font before setting characters
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  // Apply text-specific properties
  if (properties.content) {
    text.characters = properties.content;
  }
  
  return text;
}

/**
 * Creates a rectangle element with the specified properties
 */
function createRectangleElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): RectangleNode {
  const rect = figma.createRectangle();
  parent.appendChild(rect);
  
  // Apply basic properties
  if (properties.name) rect.name = properties.name;
  if (properties.x !== undefined) rect.x = properties.x;
  if (properties.y !== undefined) rect.y = properties.y;
  if (properties.width !== undefined && properties.height !== undefined) {
    rect.resize(properties.width, properties.height);
  }
  
  return rect;
}

/**
 * Creates a button element with the specified properties
 */
async function createButtonElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<FrameNode> {
  // Create a frame for the button
  const button = figma.createFrame();
  button.name = properties.name || 'Button';
  parent.appendChild(button);
  
  // Apply basic properties
  if (properties.x !== undefined) button.x = properties.x;
  if (properties.y !== undefined) button.y = properties.y;
  
  // Set button size
  const width = properties.width || 120;
  const height = properties.height || 40;
  button.resize(width, height);
  
  // Set button corner radius
  if (properties.cornerRadius !== undefined) {
    button.cornerRadius = properties.cornerRadius;
  } else {
    button.cornerRadius = 4; // Default radius
  }
  
  // Create button text
  const text = figma.createText();
  button.appendChild(text);
  
  // Load font before setting characters
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  text.characters = properties.text || 'Button';
  text.textAlignHorizontal = 'CENTER';
  text.textAlignVertical = 'CENTER';
  
  // Center the text in the button
  text.resize(width, height);
  
  return button;
}

/**
 * Creates an input element with the specified properties
 */
async function createInputElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<FrameNode> {
  // Create a frame for the input
  const input = figma.createFrame();
  input.name = properties.name || 'Input Field';
  parent.appendChild(input);
  
  // Apply basic properties
  if (properties.x !== undefined) input.x = properties.x;
  if (properties.y !== undefined) input.y = properties.y;
  
  // Set input size
  const width = properties.width || 240;
  const height = properties.height || 40;
  input.resize(width, height);
  
  // Set input corner radius
  if (properties.cornerRadius !== undefined) {
    input.cornerRadius = properties.cornerRadius;
  } else {
    input.cornerRadius = 4; // Default radius
  }
  
  // Create placeholder text
  const text = figma.createText();
  input.appendChild(text);
  
  // Load font before setting characters
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  text.characters = properties.placeholder || 'Enter text...';
  text.textAlignVertical = 'CENTER';
  
  // Position the text inside the input with padding
  text.x = 8;
  text.resize(width - 16, height);
  
  return input;
}

/**
 * Creates a frame element with the specified properties
 */
function createFrameElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): FrameNode {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  
  // Apply basic properties
  if (properties.name) frame.name = properties.name;
  if (properties.x !== undefined) frame.x = properties.x;
  if (properties.y !== undefined) frame.y = properties.y;
  
  // Set frame size
  const width = properties.width || 200;
  const height = properties.height || 200;
  frame.resize(width, height);
  
  // Apply corner radius if specified
  if (properties.cornerRadius !== undefined) {
    frame.cornerRadius = properties.cornerRadius;
  }
  
  return frame;
}

/**
 * Creates a simple navbar element
 */
async function createNavbarElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<FrameNode> {
  const navbar = figma.createFrame();
  navbar.name = properties.name || 'Navigation Bar';
  parent.appendChild(navbar);
  
  // Apply basic properties
  if (properties.x !== undefined) navbar.x = properties.x;
  if (properties.y !== undefined) navbar.y = properties.y;
  
  // Set navbar size - typically full width and fixed height
  const width = properties.width || parent.width;
  const height = properties.height || 60;
  navbar.resize(width, height);
  
  // Setup auto layout
  navbar.layoutMode = 'HORIZONTAL';
  navbar.primaryAxisAlignItems = 'SPACE_BETWEEN';
  navbar.counterAxisAlignItems = 'CENTER';
  navbar.paddingLeft = 20;
  navbar.paddingRight = 20;
  
  // Load font before creating text elements
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  // Create logo/brand text
  const brandText = figma.createText();
  navbar.appendChild(brandText);
  brandText.characters = (properties.logo && properties.logo.text) || 'Brand';
  
  // Create links container
  const linksContainer = figma.createFrame();
  navbar.appendChild(linksContainer);
  linksContainer.name = 'Links';
  linksContainer.layoutMode = 'HORIZONTAL';
  linksContainer.itemSpacing = 24;
  linksContainer.fills = [];
  
  // Add navigation links
  const links = properties.links || [
    { text: 'Home' },
    { text: 'About' },
    { text: 'Services' },
    { text: 'Contact' }
  ];
  
  for (const link of links) {
    const linkText = figma.createText();
    linksContainer.appendChild(linkText);
    linkText.characters = link.text;
  }
  
  return navbar;
}

/**
 * Creates a card element with the specified properties
 */
async function createCardElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<FrameNode> {
  const card = figma.createFrame();
  card.name = properties.name || 'Card';
  parent.appendChild(card);
  
  // Apply basic properties
  if (properties.x !== undefined) card.x = properties.x;
  if (properties.y !== undefined) card.y = properties.y;
  
  // Set card size
  const width = properties.width || 300;
  const height = properties.height || 350;
  card.resize(width, height);
  
  // Set card corner radius
  if (properties.cornerRadius !== undefined) {
    card.cornerRadius = properties.cornerRadius;
  } else {
    card.cornerRadius = 8; // Default radius
  }
  
  // Setup auto layout
  card.layoutMode = 'VERTICAL';
  card.itemSpacing = 16;
  card.paddingLeft = 16;
  card.paddingRight = 16;
  card.paddingTop = 16;
  card.paddingBottom = 16;
  
  // Load font before creating text elements
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  // Create image placeholder if needed
  if (properties.image) {
    const imagePlaceholder = figma.createRectangle();
    card.appendChild(imagePlaceholder);
    imagePlaceholder.name = 'Image';
    imagePlaceholder.resize(width - 32, 150);
  }
  
  // Create title if needed
  if (properties.title) {
    const titleText = figma.createText();
    card.appendChild(titleText);
    titleText.characters = properties.title;
  }
  
  // Create description if needed
  if (properties.description) {
    const descriptionText = figma.createText();
    card.appendChild(descriptionText);
    descriptionText.characters = properties.description;
  }
  
  return card;
}

/**
 * Creates a footer element with the specified properties
 */
async function createFooterElement(parent: FrameNode | GroupNode | ComponentNode | InstanceNode, properties: any): Promise<FrameNode> {
  const footer = figma.createFrame();
  footer.name = properties.name || 'Footer';
  parent.appendChild(footer);
  
  // Apply basic properties
  if (properties.x !== undefined) footer.x = properties.x;
  if (properties.y !== undefined) footer.y = properties.y;
  
  // Set footer size - typically full width and fixed height
  const width = properties.width || parent.width;
  const height = properties.height || 200;
  footer.resize(width, height);
  
  // Setup auto layout
  footer.layoutMode = 'VERTICAL';
  footer.primaryAxisAlignItems = 'CENTER';
  footer.counterAxisAlignItems = 'CENTER';
  footer.paddingTop = 40;
  footer.paddingBottom = 40;
  
  // Load font before creating text elements
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  // Create columns container if needed
  if (properties.columns && properties.columns.length > 0) {
    const columnsContainer = figma.createFrame();
    footer.appendChild(columnsContainer);
    columnsContainer.name = 'Columns';
    columnsContainer.layoutMode = 'HORIZONTAL';
    columnsContainer.itemSpacing = 48;
    columnsContainer.fills = [];
    columnsContainer.resize(width - 80, 120);
    
    // Create columns
    for (const column of properties.columns) {
      const columnFrame = figma.createFrame();
      columnsContainer.appendChild(columnFrame);
      columnFrame.name = column.title || 'Column';
      columnFrame.layoutMode = 'VERTICAL';
      columnFrame.itemSpacing = 12;
      columnFrame.fills = [];
      
      // Add column title
      if (column.title) {
        const titleText = figma.createText();
        columnFrame.appendChild(titleText);
        titleText.characters = column.title;
      }
      
      // Add links
      if (column.links && column.links.length > 0) {
        for (const link of column.links) {
          const linkText = figma.createText();
          columnFrame.appendChild(linkText);
          linkText.characters = link.text;
        }
      }
    }
  }
  
  // Create copyright text if needed
  if (properties.copyright) {
    const copyrightText = figma.createText();
    footer.appendChild(copyrightText);
    copyrightText.characters = properties.copyright;
  }
  
  return footer;
}

/**
 * Applies styling to an existing element
 */
async function handleStyleElement(message: PluginMessage): Promise<void> {
  console.log('Message received for STYLE_ELEMENT:', message);
  console.log('Style element payload:', message.payload);
  
  // Validate payload exists
  if (!message.payload) {
    console.error('No payload provided for STYLE_ELEMENT command');
    throw new Error('No payload provided for STYLE_ELEMENT command');
  }
  
  // Destructure with defaults to avoid errors
  const { 
    elementId = '', 
    styles = {} 
  } = message.payload;
  
  console.log('Extracted values for STYLE_ELEMENT:', { elementId, styles });
  
  // Get active page context first to ensure we're in the right context
  const activePageId = sessionState.getActivePageId();
  if (activePageId) {
    const activePage = figma.getNodeById(activePageId);
    if (activePage && activePage.type === 'PAGE') {
      // Switch to the active page to ensure we can access elements on it
      figma.currentPage = activePage as PageNode;
      console.log(`Switched to active page: ${activePage.name} (${activePage.id})`);
    }
  }
  
  // If no element ID provided, try to use current selection
  let targetElement: BaseNode | null = null;
  let selectionSource = 'direct';
  
  if (!elementId) {
    console.log('No elementId provided, checking current selection');
    if (figma.currentPage.selection.length > 0) {
      targetElement = figma.currentPage.selection[0];
      selectionSource = 'selection';
      console.log(`Using first selected element: ${targetElement.id}`);
    } else {
      throw new Error('No element ID provided and no selection exists');
    }
  } else {
    // Get the element to style
    targetElement = figma.getNodeById(elementId);
    if (!targetElement) {
      console.warn(`Element with ID ${elementId} not found, checking selection`);
      
      // Try using selection as fallback
      if (figma.currentPage.selection.length > 0) {
        targetElement = figma.currentPage.selection[0];
        selectionSource = 'fallback';
        console.log(`Using selection as fallback: ${targetElement.id}`);
      } else {
        throw new Error(`Element not found: ${elementId} and no selection exists`);
      }
    }
  }
  
  console.log(`Target element resolved: ${targetElement.id} (${targetElement.type}) via ${selectionSource}`);
  
  // Apply styles based on element type
  try {
    switch (targetElement.type) {
      case 'RECTANGLE':
      case 'ELLIPSE':
      case 'POLYGON':
      case 'STAR':
      case 'VECTOR':
        applyShapeStyles(targetElement as RectangleNode | EllipseNode | PolygonNode | StarNode | VectorNode, styles);
        break;
        
      case 'TEXT':
        await applyTextStyles(targetElement as TextNode, styles);
        break;
        
      case 'FRAME':
      case 'GROUP':
      case 'COMPONENT':
      case 'INSTANCE':
        applyContainerStyles(targetElement as FrameNode | GroupNode | ComponentNode | InstanceNode, styles);
        break;
        
      default:
        console.warn(`Limited styling support for node type: ${targetElement.type}`);
        // Apply basic styling like name if available
        if (styles.name) {
          targetElement.name = styles.name;
        }
    }
  } catch (error) {
    console.error('Error applying styles:', error);
    throw new Error(`Failed to style element: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Send success response with context
  sendResponse({
    type: message.type,
    success: true,
    data: {
      id: targetElement.id,
      type: targetElement.type,
      activePageId: sessionState.getActivePageId()
    },
    id: message.id
  });
}

/**
 * Apply styles to shape elements
 */
function applyShapeStyles(node: RectangleNode | EllipseNode | PolygonNode | StarNode | VectorNode, styles: any): void {
  // Apply basic properties
  if (styles.name) node.name = styles.name;
  
  // Apply fill if provided
  if (styles.fill) {
    try {
      // Convert color string to RGB
      const color = parseColor(styles.fill);
      node.fills = [{ type: 'SOLID', color }];
    } catch (e) {
      console.warn('Invalid fill color:', styles.fill);
    }
  }
  
  // Apply stroke if provided
  if (styles.stroke) {
    try {
      // Convert color string to RGB
      const color = parseColor(styles.stroke);
      node.strokes = [{ type: 'SOLID', color }];
      
      // Apply stroke weight if provided
      if (styles.strokeWeight) {
        node.strokeWeight = styles.strokeWeight;
      }
    } catch (e) {
      console.warn('Invalid stroke color:', styles.stroke);
    }
  }
  
  // Apply corner radius if applicable and provided
  if ('cornerRadius' in node && styles.cornerRadius !== undefined) {
    (node as RectangleNode).cornerRadius = styles.cornerRadius;
  }
}

/**
 * Apply styles to text elements
 */
async function applyTextStyles(node: TextNode, styles: any): Promise<void> {
  // Apply basic properties
  if (styles.name) node.name = styles.name;
  
  // Load font before setting characters or font properties
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  
  // Apply text content if provided
  if (styles.content || styles.text) {
    node.characters = styles.content || styles.text;
  }
  
  // Apply font size if provided
  if (styles.fontSize) {
    node.fontSize = styles.fontSize;
  }
  
  // Apply font weight if provided
  if (styles.fontWeight) {
    // Since fontName might be a unique symbol in some versions of the API
    // we need to handle it carefully
    try {
      const currentFont = node.fontName;
      const fontFamily = typeof currentFont === 'object' && 'family' in currentFont 
        ? currentFont.family 
        : 'Inter';
      
      // Load the specific font weight/style
      await figma.loadFontAsync({ family: fontFamily, style: styles.fontWeight });
      
      node.fontName = {
        family: fontFamily,
        style: styles.fontWeight
      };
    } catch (e) {
      console.warn('Unable to set font weight:', e);
    }
  }
  
  // Apply text color if provided
  if (styles.color || styles.textColor) {
    try {
      const color = parseColor(styles.color || styles.textColor);
      node.fills = [{ type: 'SOLID', color }];
    } catch (e) {
      console.warn('Invalid text color:', styles.color || styles.textColor);
    }
  }
  
  // Apply text alignment if provided
  if (styles.textAlign) {
    const alignment = styles.textAlign.toUpperCase();
    if (alignment === 'LEFT' || alignment === 'CENTER' || alignment === 'RIGHT' || alignment === 'JUSTIFIED') {
      node.textAlignHorizontal = alignment;
    }
  }
}

/**
 * Apply styles to container elements
 */
function applyContainerStyles(node: FrameNode | GroupNode | ComponentNode | InstanceNode, styles: any): void {
  // Apply basic properties
  if (styles.name) node.name = styles.name;
  
  // Apply fill if provided and the node supports it
  if ('fills' in node && styles.fill) {
    try {
      const color = parseColor(styles.fill);
      node.fills = [{ type: 'SOLID', color }];
    } catch (e) {
      console.warn('Invalid fill color:', styles.fill);
    }
  }
  
  // Apply stroke if provided and the node supports it
  if ('strokes' in node && styles.stroke) {
    try {
      const color = parseColor(styles.stroke);
      node.strokes = [{ type: 'SOLID', color }];
      
      if (styles.strokeWeight && 'strokeWeight' in node) {
        node.strokeWeight = styles.strokeWeight;
      }
    } catch (e) {
      console.warn('Invalid stroke color:', styles.stroke);
    }
  }
  
  // Apply corner radius if applicable and provided
  if ('cornerRadius' in node && styles.cornerRadius !== undefined) {
    node.cornerRadius = styles.cornerRadius;
  }
  
  // Apply padding if applicable and provided
  if ('paddingLeft' in node) {
    if (styles.padding !== undefined) {
      node.paddingLeft = styles.padding;
      node.paddingRight = styles.padding;
      node.paddingTop = styles.padding;
      node.paddingBottom = styles.padding;
    } else {
      if (styles.paddingLeft !== undefined) node.paddingLeft = styles.paddingLeft;
      if (styles.paddingRight !== undefined) node.paddingRight = styles.paddingRight;
      if (styles.paddingTop !== undefined) node.paddingTop = styles.paddingTop;
      if (styles.paddingBottom !== undefined) node.paddingBottom = styles.paddingBottom;
    }
  }
}

/**
 * Helper function to parse color strings into RGB values
 */
function parseColor(colorStr: string): { r: number, g: number, b: number } {
  // Default to black if parsing fails
  const defaultColor = { r: 0, g: 0, b: 0 };
  
  // Handle hex colors
  if (colorStr.startsWith('#')) {
    try {
      let hex = colorStr.substring(1);
      
      // Convert short hex to full hex
      if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
      }
      
      if (hex.length === 6) {
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        return { r, g, b };
      }
    } catch (e) {
      console.warn('Invalid hex color:', colorStr);
      return defaultColor;
    }
  }
  
  // Handle RGB/RGBA colors
  if (colorStr.startsWith('rgb')) {
    try {
      const values = colorStr.match(/\d+/g);
      if (values && values.length >= 3) {
        const r = parseInt(values[0]) / 255;
        const g = parseInt(values[1]) / 255;
        const b = parseInt(values[2]) / 255;
        return { r, g, b };
      }
    } catch (e) {
      console.warn('Invalid rgb color:', colorStr);
      return defaultColor;
    }
  }
  
  // Handle common color names
  const colorMap: Record<string, { r: number, g: number, b: number }> = {
    'red': { r: 1, g: 0, b: 0 },
    'green': { r: 0, g: 1, b: 0 },
    'blue': { r: 0, g: 0, b: 1 },
    'black': { r: 0, g: 0, b: 0 },
    'white': { r: 1, g: 1, b: 1 },
    'gray': { r: 0.5, g: 0.5, b: 0.5 },
    'yellow': { r: 1, g: 1, b: 0 },
    'purple': { r: 0.5, g: 0, b: 0.5 },
    'orange': { r: 1, g: 0.65, b: 0 },
    'pink': { r: 1, g: 0.75, b: 0.8 }
  };
  
  const lowerColorStr = colorStr.toLowerCase();
  if (lowerColorStr in colorMap) {
    return colorMap[lowerColorStr];
  }
  
  console.warn('Unrecognized color format:', colorStr);
  return defaultColor;
}

/**
 * Modifies an existing element
 */
async function handleModifyElement(message: PluginMessage): Promise<void> {
  const { elementId, modifications } = message.payload;
  
  // Get the element to modify
  const element = figma.getNodeById(elementId);
  if (!element) {
    throw new Error(`Element not found: ${elementId}`);
  }
  
  // Apply modifications based on element type
  // This is a simplified implementation
  
  // Send success response
  sendResponse({
    type: message.type,
    success: true,
    id: message.id
  });
}

/**
 * Arranges elements in a layout
 */
async function handleArrangeLayout(message: PluginMessage): Promise<void> {
  const { parentId, layout, properties } = message.payload;
  
  // Get the parent container
  const parent = figma.getNodeById(parentId);
  if (!parent || parent.type !== 'FRAME') {
    throw new Error(`Invalid parent node for layout: ${parentId}`);
  }
  
  const frame = parent as FrameNode;
  
  // Apply layout
  switch (layout) {
    case 'HORIZONTAL':
      frame.layoutMode = 'HORIZONTAL';
      break;
    case 'VERTICAL':
      frame.layoutMode = 'VERTICAL';
      break;
    case 'GRID':
      // For grid, we can't set it directly as a layout mode in Figma
      // We would need a custom implementation
      break;
    case 'NONE':
    default:
      frame.layoutMode = 'NONE';
      break;
  }
  
  // Apply additional layout properties
  if (properties) {
    if (properties.itemSpacing !== undefined) {
      frame.itemSpacing = properties.itemSpacing;
    }
    
    if (properties.paddingLeft !== undefined) frame.paddingLeft = properties.paddingLeft;
    if (properties.paddingRight !== undefined) frame.paddingRight = properties.paddingRight;
    if (properties.paddingTop !== undefined) frame.paddingTop = properties.paddingTop;
    if (properties.paddingBottom !== undefined) frame.paddingBottom = properties.paddingBottom;
    
    if (properties.primaryAxisAlignItems) {
      frame.primaryAxisAlignItems = properties.primaryAxisAlignItems;
    }
    
    if (properties.counterAxisAlignItems) {
      frame.counterAxisAlignItems = properties.counterAxisAlignItems;
    }
  }
  
  // Send success response
  sendResponse({
    type: message.type,
    success: true,
    id: message.id
  });
}

/**
 * Exports a design
 */
async function handleExportDesign(message: PluginMessage): Promise<void> {
  console.log('Message received for EXPORT_DESIGN:', message);
  console.log('Export design payload:', message.payload);
  
  // Validate payload exists
  if (!message.payload) {
    console.error('No payload provided for EXPORT_DESIGN command');
    throw new Error('No payload provided for EXPORT_DESIGN command');
  }
  
  // Destructure with defaults to avoid errors
  const { 
    selection = [], 
    settings = {
      format: 'PNG',
      constraint: { type: 'SCALE', value: 1 },
      includeBackground: true
    } 
  } = message.payload;
  
  console.log('Extracted values for EXPORT_DESIGN:', { selection, settings });
  
  // Get active page context first to ensure we're in the right context
  const activePageId = sessionState.getActivePageId();
  if (activePageId) {
    const activePage = figma.getNodeById(activePageId);
    if (activePage && activePage.type === 'PAGE') {
      // Switch to the active page to ensure we can access elements on it
      figma.currentPage = activePage as PageNode;
      console.log(`Switched to active page: ${activePage.name} (${activePage.id})`);
    }
  }
  
  let nodesToExport: SceneNode[] = [];
  
  // If specific nodes are selected for export
  if (selection && selection.length > 0) {
    console.log('Exporting specified nodes:', selection);
    for (const id of selection) {
      const node = figma.getNodeById(id);
      if (node && 'exportAsync' in node) {
        nodesToExport.push(node as SceneNode);
      } else {
        console.warn(`Node not found or not exportable: ${id}`);
      }
    }
  } 
  // Otherwise export the current selection
  else if (figma.currentPage.selection.length > 0) {
    console.log('Exporting current selection');
    nodesToExport = figma.currentPage.selection.filter(node => 'exportAsync' in node);
  }
  // If no selection, export the current page
  else {
    console.log('Exporting current page');
    // Use currentPage as an exportable node if it supports exportAsync
    if ('exportAsync' in figma.currentPage) {
      nodesToExport = [figma.currentPage as unknown as SceneNode];
    }
  }
  
  if (nodesToExport.length === 0) {
    console.warn('No valid nodes to export');
    throw new Error('No valid nodes to export. Please select at least one node or specify node IDs.');
  }
  
  console.log(`Found ${nodesToExport.length} nodes to export`);
  
  try {
    // Export each node
    const exportPromises = nodesToExport.map(async node => {
      console.log(`Exporting node: ${node.id} (${node.name})`);
      
      const format = settings.format || 'PNG';
      const scale = settings.constraint?.value || 1;
      
      // Export the node
      const bytes = await (node as ExportMixin).exportAsync({
        format: format as 'PNG' | 'JPG' | 'SVG' | 'PDF',
        constraint: { type: 'SCALE', value: scale }
      });
      
      // Convert to base64
      const base64 = figma.base64Encode(bytes);
      
      return {
        name: node.name,
        data: base64,
        format: format.toLowerCase(),
        nodeId: node.id
      };
    });
    
    // Wait for all exports to complete
    const exportResults = await Promise.all(exportPromises);
    console.log(`Successfully exported ${exportResults.length} nodes`);
    
    // Send success response with context
    sendResponse({
      type: message.type,
      success: true,
      data: {
        files: exportResults,
        activePageId: sessionState.getActivePageId()
      },
      id: message.id
    });
  } catch (error) {
    console.error('Error exporting design:', error);
    throw new Error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Gets the current selection
 */
function handleGetSelection(message: PluginMessage): void {
  console.log('Message received for GET_SELECTION:', message);
  
  try {
    // Get active page context first to ensure we're in the right context
    const activePageId = sessionState.getActivePageId();
    if (activePageId) {
      const activePage = figma.getNodeById(activePageId);
      if (activePage && activePage.type === 'PAGE') {
        // Switch to the active page to ensure we get selection from it
        figma.currentPage = activePage as PageNode;
        console.log(`Switched to active page: ${activePage.name} (${activePage.id})`);
      }
    }
    
    const selection = figma.currentPage.selection.map(node => ({
      id: node.id,
      name: node.name,
      type: node.type
    }));
    
    console.log(`Found ${selection.length} selected nodes`);
    
    // Send success response with context
    sendResponse({
      type: message.type,
      success: true,
      data: {
        selection,
        currentPage: {
          id: figma.currentPage.id,
          name: figma.currentPage.name
        },
        activePageId: sessionState.getActivePageId()
      },
      id: message.id
    });
  } catch (error) {
    console.error('Error getting selection:', error);
    sendResponse({
      type: message.type,
      success: false,
      error: `Error getting selection: ${error instanceof Error ? error.message : String(error)}`,
      id: message.id
    });
  }
}

/**
 * Gets the current page info
 */
function handleGetCurrentPage(message: PluginMessage): void {
  console.log('Message received for GET_CURRENT_PAGE:', message);
  
  try {
    // Check if we have an active page in session state and verify it
    const activePageId = sessionState.getActivePageId();
    let activePage: PageNode | null = null;
    
    if (activePageId) {
      const node = figma.getNodeById(activePageId);
      if (node && node.type === 'PAGE') {
        activePage = node as PageNode;
      }
    }
    
    // Get current Figma page (may be different from active page)
    const currentPage = figma.currentPage;
    
    // If we have an active page that differs from current, should we switch?
    if (activePage && activePage.id !== currentPage.id) {
      console.log(`Note: Active page (${activePage.name}) differs from current Figma page (${currentPage.name})`);
    }
    
    // Get list of all pages in the document for context
    const allPages = figma.root.children.map(page => ({
      id: page.id,
      name: page.name,
      isActive: page.id === activePageId,
      isCurrent: page.id === currentPage.id
    }));
    
    const wireframes = sessionState.getWireframes();
    
    // Send response with detailed page context
    sendResponse({
      type: message.type,
      success: true,
      data: {
        // Current Figma page
        currentPage: {
          id: currentPage.id,
          name: currentPage.name,
          childrenCount: currentPage.children.length
        },
        // Active page from session state (may be different)
        activePage: activePage ? {
          id: activePage.id,
          name: activePage.name,
          childrenCount: activePage.children.length
        } : null,
        // Active page ID from session state
        activePageId: sessionState.getActivePageId(),
        // Active wireframe from session state
        activeWireframeId: sessionState.activeWireframeId,
        // All pages in document
        allPages,
        // All wireframes created in the session
        wireframes
      },
      id: message.id
    });
  } catch (error) {
    console.error('Error getting page info:', error);
    sendResponse({
      type: message.type,
      success: false,
      error: `Error getting page info: ${error instanceof Error ? error.message : String(error)}`,
      id: message.id
    });
  }
}

// Start the plugin and create a UI to handle messages
figma.showUI(__html__, { 
  width: 400,
  height: 500,
  visible: true // Make UI visible by default in real mode
});

console.log('Figma plugin initialized and ready for commands');

// Send a startup notification to the UI
figma.ui.postMessage({
  type: 'PLUGIN_STARTED',
  success: true,
  data: {
    pluginId: figma.root.id,
    currentPage: figma.currentPage.name
  }
});

// Handle commands from Figma UI menu
figma.on('run', ({ command }) => {
  // Show the UI when any command is run
  figma.ui.show();
  
  console.log('Command executed:', command);
  
  // Convert the command to the proper format for our message handler
  let commandType: CommandType;
  
  switch (command) {
    case 'create-wireframe':
      commandType = 'CREATE_WIREFRAME';
      break;
    case 'add-element':
      commandType = 'ADD_ELEMENT';
      break;
    case 'export-design':
      commandType = 'EXPORT_DESIGN';
      break;
    default:
      console.error('Unknown command:', command);
      return;
  }
  
  // Send an initial message to the UI to indicate the command was received
  figma.ui.postMessage({
    type: 'COMMAND_RECEIVED',
    success: true,
    data: { command: commandType }
  });
}); 