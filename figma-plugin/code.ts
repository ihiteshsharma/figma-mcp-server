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
  | 'GET_CURRENT_PAGE'
  // Direct Figma API commands
  | 'CREATE_RECTANGLE'
  | 'CREATE_ELLIPSE'
  | 'CREATE_POLYGON'
  | 'CREATE_STAR'
  | 'CREATE_VECTOR'
  | 'CREATE_TEXT'
  | 'CREATE_FRAME'
  | 'CREATE_COMPONENT'
  | 'CREATE_INSTANCE'
  | 'CREATE_LINE'
  | 'CREATE_GROUP';

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
  },
  
  // Add a node to a wireframe
  addNodeToWireframe(wireframeId: string, node: SceneNode) {
    if (!wireframeId || !node) return;
    
    const wireframe = this.createdPages.get(wireframeId);
    if (wireframe) {
      wireframe.pageIds.push(node.id);
      wireframe.createdAt = Date.now();
    }
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

/**
 * Creates a detailed node description for response
 * This function extracts all relevant properties from a node for detailed feedback
 */
function createDetailedNodeResponse(node: SceneNode): any {
  // Base properties all nodes have
  const details: any = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };
  
  // Add position data
  if ('x' in node) details.x = node.x;
  if ('y' in node) details.y = node.y;
  
  // Add size data
  if ('width' in node) details.width = node.width;
  if ('height' in node) details.height = node.height;
  
  // Add layout properties for container nodes
  if ('layoutMode' in node) {
    details.layout = {
      mode: node.layoutMode,
      primaryAxisAlignItems: node.primaryAxisAlignItems,
      counterAxisAlignItems: node.counterAxisAlignItems,
      itemSpacing: node.itemSpacing,
      padding: {
        left: node.paddingLeft,
        right: node.paddingRight,
        top: node.paddingTop,
        bottom: node.paddingBottom
      }
    };
  }
  
  // Add style properties common to many nodes
  if ('fills' in node) {
    details.fills = node.fills;
  }
  
  if ('strokes' in node) {
    details.strokes = node.strokes;
    if ('strokeWeight' in node) details.strokeWeight = node.strokeWeight;
    if ('strokeAlign' in node) details.strokeAlign = node.strokeAlign;
  }
  
  if ('cornerRadius' in node) {
    if (node.type === 'RECTANGLE') {
      details.cornerRadius = {
        topLeft: (node as RectangleNode).topLeftRadius,
        topRight: (node as RectangleNode).topRightRadius,
        bottomRight: (node as RectangleNode).bottomRightRadius,
        bottomLeft: (node as RectangleNode).bottomLeftRadius
      };
    } else {
      details.cornerRadius = (node as any).cornerRadius;
    }
  }
  
  if ('effects' in node) {
    details.effects = node.effects;
  }
  
  // Add text-specific properties
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    details.text = {
      characters: textNode.characters,
      fontSize: textNode.fontSize,
      fontName: textNode.fontName,
      textCase: textNode.textCase,
      textDecoration: textNode.textDecoration,
      letterSpacing: textNode.letterSpacing,
      lineHeight: textNode.lineHeight,
      textAlignHorizontal: textNode.textAlignHorizontal,
      textAlignVertical: textNode.textAlignVertical
    };
  }
  
  // Add parent context
  if (node.parent) {
    details.parent = {
      id: node.parent.id,
      type: node.parent.type,
      name: node.parent.name
    };
  }
  
  return details;
}

// Main message handler with support for direct API commands
figma.ui.onmessage = async (msg: PluginMessage) => {
  console.log('Message received in plugin:', msg);
  
  try {
    switch (msg.type) {
      // Existing command handlers
      case 'CREATE_WIREFRAME':
        await handleCreateWireframe(msg);
        break;
        
      case 'ADD_ELEMENT':
        const addElementResult = await handleAddElement(msg);
        sendResponse({
          type: msg.type,
          success: addElementResult.success,
          error: addElementResult.error,
          data: addElementResult.data,
          id: msg.id,
          _isResponse: true
        });
        break;
        
      case 'STYLE_ELEMENT':
        await handleStyleElement(msg);
        break;
        
      case 'MODIFY_ELEMENT':
        await handleModifyElement(msg);
        break;
        
      case 'ARRANGE_LAYOUT':
        await handleArrangeLayout(msg);
        break;
        
      case 'EXPORT_DESIGN':
        await handleExportDesign(msg);
        break;
        
      case 'GET_SELECTION':
        handleGetSelection(msg);
        break;
        
      case 'GET_CURRENT_PAGE':
        handleGetCurrentPage(msg);
        break;
        
      // New direct API commands
      case 'CREATE_RECTANGLE':
        await handleCreateRectangle(msg);
        break;
        
      case 'CREATE_ELLIPSE':
        await handleCreateEllipse(msg);
        break;
        
      case 'CREATE_TEXT':
        await handleCreateText(msg);
        break;
        
      case 'CREATE_FRAME':
        await handleCreateFrame(msg);
        break;
        
      case 'CREATE_COMPONENT':
        await handleCreateComponent(msg);
        break;
        
      case 'CREATE_LINE':
        await handleCreateLine(msg);
        break;
        
      default:
        console.warn(`Unknown command type: ${msg.type}`);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Unknown command type: ${msg.type}`,
          id: msg.id,
          _isResponse: true
        });
    }
  } catch (error) {
    console.error(`Error handling message: ${error}`);
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
};

/**
 * Enhanced styling system
 */

// Extended style interface to document all possible style options
interface ExtendedStyleOptions {
  // Basic properties
  name?: string;
  description?: string;
  
  // Positioning and dimensions
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  positioning?: 'AUTO' | 'ABSOLUTE';
  
  // Appearance
  fill?: string | {r: number, g: number, b: number, a?: number} | Array<{type: string, color: {r: number, g: number, b: number, a?: number}, opacity?: number, visible?: boolean}>;
  stroke?: string | {r: number, g: number, b: number, a?: number};
  strokeWeight?: number;
  strokeAlign?: 'INSIDE' | 'OUTSIDE' | 'CENTER';
  cornerRadius?: number | {topLeft?: number, topRight?: number, bottomRight?: number, bottomLeft?: number};
  
  // Effects
  effects?: Array<{
    type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
    color?: {r: number, g: number, b: number, a?: number};
    offset?: {x: number, y: number};
    radius?: number;
    spread?: number;
    visible?: boolean;
    blendMode?: BlendMode;
  }>;
  
  // Layout
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL';
  primaryAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
  counterAxisAlignItems?: 'MIN' | 'CENTER' | 'MAX';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  
  // Text specific
  fontSize?: number;
  fontWeight?: number | string;
  fontName?: FontName;
  textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
  textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
  letterSpacing?: {value: number, unit: 'PIXELS' | 'PERCENT'};
  lineHeight?: {value: number, unit: 'PIXELS' | 'PERCENT' | 'AUTO'};
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM';
  
  // Content
  text?: string;
  characters?: string;
  content?: string;
  
  // Brand colors (for easy reference)
  brandColors?: {
    [key: string]: string;
  };
  
  // Custom styles object for extensibility
  [key: string]: any;
}

/**
 * Enhanced color parsing with support for CSS color formats, brand colors and transparency
 * Supports: hex, rgb, rgba, hsl, hsla, named colors, and brand color references
 */
function enhancedParseColor(colorInput: string | {r: number, g: number, b: number, a?: number} | undefined, brandColors?: {[key: string]: string}): {r: number, g: number, b: number, a: number} {
  // Default to black if undefined
  if (!colorInput) {
    return { r: 0, g: 0, b: 0, a: 1 };
  }
  
  // If it's already an RGB object
  if (typeof colorInput !== 'string') {
    return { 
      r: colorInput.r, 
      g: colorInput.g, 
      b: colorInput.b, 
      a: colorInput.a !== undefined ? colorInput.a : 1 
    };
  }
  
  const colorStr = colorInput.trim();
  
  // Check for brand color references like "brand:primary" or "#primary"
  if (brandColors && (colorStr.startsWith('brand:') || colorStr.startsWith('#'))) {
    const colorKey = colorStr.startsWith('brand:') 
      ? colorStr.substring(6) 
      : colorStr.substring(1);
    
    if (brandColors[colorKey]) {
      // Recursively parse the brand color value
      return enhancedParseColor(brandColors[colorKey]);
    }
  }

  // Handle hex colors
  if (colorStr.startsWith('#')) {
    try {
      let hex = colorStr.substring(1);
      
      // Convert short hex to full hex
      if (hex.length === 3) {
        hex = hex.split('').map(char => char + char).join('');
      }
      
      // Handle hex with alpha
      let r, g, b, a = 1;
      
      if (hex.length === 8) {
        // #RRGGBBAA format
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
        a = parseInt(hex.substring(6, 8), 16) / 255;
      } else if (hex.length === 6) {
        // #RRGGBB format
        r = parseInt(hex.substring(0, 2), 16) / 255;
        g = parseInt(hex.substring(2, 4), 16) / 255;
        b = parseInt(hex.substring(4, 6), 16) / 255;
      } else if (hex.length === 4) {
        // #RGBA format
        r = parseInt(hex.substring(0, 1) + hex.substring(0, 1), 16) / 255;
        g = parseInt(hex.substring(1, 2) + hex.substring(1, 2), 16) / 255;
        b = parseInt(hex.substring(2, 3) + hex.substring(2, 3), 16) / 255;
        a = parseInt(hex.substring(3, 4) + hex.substring(3, 4), 16) / 255;
      } else {
        throw new Error('Invalid hex color format');
      }
      
      return { r, g, b, a };
    } catch (e) {
      console.warn('Invalid hex color:', colorStr);
    }
  }
  
  // Handle RGB/RGBA colors
  if (colorStr.startsWith('rgb')) {
    try {
      const values = colorStr.match(/[\d.]+/g);
      if (values && values.length >= 3) {
        const r = parseInt(values[0]) / 255;
        const g = parseInt(values[1]) / 255;
        const b = parseInt(values[2]) / 255;
        const a = values.length >= 4 ? parseFloat(values[3]) : 1;
        return { r, g, b, a };
      }
    } catch (e) {
      console.warn('Invalid rgb color:', colorStr);
    }
  }
  
  // Handle HSL/HSLA colors
  if (colorStr.startsWith('hsl')) {
    try {
      const values = colorStr.match(/[\d.]+/g);
      if (values && values.length >= 3) {
        // Convert HSL to RGB
        const h = parseInt(values[0]) / 360;
        const s = parseInt(values[1]) / 100;
        const l = parseInt(values[2]) / 100;
        const a = values.length >= 4 ? parseFloat(values[3]) : 1;
        
        // HSL to RGB conversion algorithm
        let r, g, b;
        
        if (s === 0) {
          r = g = b = l; // Achromatic (gray)
        } else {
          const hue2rgb = (p: number, q: number, t: number) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1/6) return p + (q - p) * 6 * t;
            if (t < 1/2) return q;
            if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
            return p;
          };
          
          const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
          const p = 2 * l - q;
          
          r = hue2rgb(p, q, h + 1/3);
          g = hue2rgb(p, q, h);
          b = hue2rgb(p, q, h - 1/3);
        }
        
        return { r, g, b, a };
      }
    } catch (e) {
      console.warn('Invalid hsl color:', colorStr);
    }
  }
  
  // Handle common color names
  const colorMap: Record<string, { r: number, g: number, b: number, a: number }> = {
    'transparent': { r: 0, g: 0, b: 0, a: 0 },
    'red': { r: 1, g: 0, b: 0, a: 1 },
    'green': { r: 0, g: 0.8, b: 0, a: 1 },
    'blue': { r: 0, g: 0, b: 1, a: 1 },
    'black': { r: 0, g: 0, b: 0, a: 1 },
    'white': { r: 1, g: 1, b: 1, a: 1 },
    'gray': { r: 0.5, g: 0.5, b: 0.5, a: 1 },
    'grey': { r: 0.5, g: 0.5, b: 0.5, a: 1 },
    'yellow': { r: 1, g: 1, b: 0, a: 1 },
    'purple': { r: 0.5, g: 0, b: 0.5, a: 1 },
    'orange': { r: 1, g: 0.65, b: 0, a: 1 },
    'pink': { r: 1, g: 0.75, b: 0.8, a: 1 },
    // Material Design colors
    'primary': { r: 0.12, g: 0.47, b: 0.71, a: 1 },
    'secondary': { r: 0.91, g: 0.3, b: 0.24, a: 1 },
    'success': { r: 0.3, g: 0.69, b: 0.31, a: 1 },
    'warning': { r: 1, g: 0.76, b: 0.03, a: 1 },
    'error': { r: 0.96, g: 0.26, b: 0.21, a: 1 },
    'info': { r: 0.13, g: 0.59, b: 0.95, a: 1 }
  };
  
  const lowerColorStr = colorStr.toLowerCase();
  if (lowerColorStr in colorMap) {
    return colorMap[lowerColorStr];
  }
  
  console.warn('Unrecognized color format:', colorStr);
  return { r: 0, g: 0, b: 0, a: 1 }; // Default to black
}

/**
 * Applies extended styles to any node
 */
async function applyExtendedStyles(node: SceneNode, styles: ExtendedStyleOptions): Promise<void> {
  try {
    console.log(`Applying extended styles to ${node.name} (${node.type})`, styles);
    
    // Apply name if provided
    if (styles.name) {
      node.name = styles.name;
    }
    
    // Apply positioning if needed and supported
    if ('x' in node && styles.x !== undefined) {
      node.x = styles.x;
    }
    
    if ('y' in node && styles.y !== undefined) {
      node.y = styles.y;
    }
    
    // Apply sizing if needed and supported
    if ('resize' in node) {
      let width = 'width' in node ? node.width : undefined;
      let height = 'height' in node ? node.height : undefined;
      
      if (styles.width !== undefined) {
        width = styles.width;
      }
      
      if (styles.height !== undefined) {
        height = styles.height;
      }
      
      if (width !== undefined && height !== undefined) {
        (node as RectangleNode | FrameNode | ComponentNode | InstanceNode | TextNode | EllipseNode | PolygonNode | StarNode | VectorNode).resize(width, height);
      }
    }
    
    // Apply fills if supported
    if ('fills' in node && styles.fill !== undefined) {
      try {
        if (typeof styles.fill === 'string' || ('r' in styles.fill && 'g' in styles.fill && 'b' in styles.fill)) {
          // Simple color fill
          const color = enhancedParseColor(styles.fill, styles.brandColors);
          node.fills = [{
            type: 'SOLID',
            color: { r: color.r, g: color.g, b: color.b },
            opacity: color.a
          }];
        } else if (Array.isArray(styles.fill)) {
          // Multiple fills (gradients, images, etc.)
          node.fills = styles.fill.map(fill => {
            if (fill.type === 'SOLID' && fill.color) {
              const color = enhancedParseColor(fill.color, styles.brandColors);
              return {
                type: 'SOLID',
                color: { r: color.r, g: color.g, b: color.b },
                opacity: fill.opacity !== undefined ? fill.opacity : color.a,
                visible: fill.visible !== undefined ? fill.visible : true
              };
            }
            return fill as Paint;
          });
        }
      } catch (e) {
        console.warn('Error applying fill:', e);
      }
    }
    
    // Apply strokes if supported
    if ('strokes' in node && styles.stroke !== undefined) {
      try {
        const color = enhancedParseColor(styles.stroke, styles.brandColors);
        node.strokes = [{
          type: 'SOLID',
          color: { r: color.r, g: color.g, b: color.b },
          opacity: color.a
        }];
        
        // Apply stroke weight if provided
        if ('strokeWeight' in node && styles.strokeWeight !== undefined) {
          node.strokeWeight = styles.strokeWeight;
        }
        
        // Apply stroke alignment if provided
        if ('strokeAlign' in node && styles.strokeAlign) {
          node.strokeAlign = styles.strokeAlign;
        }
      } catch (e) {
        console.warn('Error applying stroke:', e);
      }
    }
    
    // Apply corner radius if supported
    if ('cornerRadius' in node && styles.cornerRadius !== undefined) {
      try {
        if (typeof styles.cornerRadius === 'number') {
          // Uniform corner radius
          (node as any).cornerRadius = styles.cornerRadius;
        } else if (typeof styles.cornerRadius === 'object') {
          // Check if node supports individual corner radii
          if ('topLeftRadius' in node) {
            // Apply individual corner radii for nodes that support it
            if (styles.cornerRadius.topLeft !== undefined) {
              (node as RectangleNode).topLeftRadius = styles.cornerRadius.topLeft;
            }
            if (styles.cornerRadius.topRight !== undefined) {
              (node as RectangleNode).topRightRadius = styles.cornerRadius.topRight;
            }
            if (styles.cornerRadius.bottomRight !== undefined) {
              (node as RectangleNode).bottomRightRadius = styles.cornerRadius.bottomRight;
            }
            if (styles.cornerRadius.bottomLeft !== undefined) {
              (node as RectangleNode).bottomLeftRadius = styles.cornerRadius.bottomLeft;
            }
          } else {
            // Fallback to uniform radius using average
            const values = [
              styles.cornerRadius.topLeft, 
              styles.cornerRadius.topRight, 
              styles.cornerRadius.bottomRight, 
              styles.cornerRadius.bottomLeft
            ].filter(v => v !== undefined) as number[];
            
            if (values.length > 0) {
              const avg = values.reduce((sum, val) => sum + val, 0) / values.length;
              (node as any).cornerRadius = avg;
            }
          }
        }
      } catch (e) {
        console.warn('Error applying corner radius:', e);
      }
    }
    
    // Apply effects if supported
    if ('effects' in node && styles.effects && Array.isArray(styles.effects)) {
      try {
        node.effects = styles.effects.map(effect => {
          // Convert color if present
          if (effect.color) {
            const parsedColor = enhancedParseColor(effect.color, styles.brandColors);
            effect.color = {
              r: parsedColor.r,
              g: parsedColor.g,
              b: parsedColor.b,
              a: parsedColor.a
            };
          }
          return effect as Effect;
        });
      } catch (e) {
        console.warn('Error applying effects:', e);
      }
    }
    
    // Apply layout properties for container nodes
    if ('layoutMode' in node) {
      // Set layout mode if provided
      if (styles.layoutMode) {
        node.layoutMode = styles.layoutMode;
        
        // Only apply these if we've set a layout mode
        if (styles.primaryAxisAlignItems) {
          node.primaryAxisAlignItems = styles.primaryAxisAlignItems;
        }
        
        if (styles.counterAxisAlignItems) {
          node.counterAxisAlignItems = styles.counterAxisAlignItems;
        }
        
        if (styles.itemSpacing !== undefined) {
          node.itemSpacing = styles.itemSpacing;
        }
      }
      
      // Apply padding properties
      if (styles.paddingLeft !== undefined) node.paddingLeft = styles.paddingLeft;
      if (styles.paddingRight !== undefined) node.paddingRight = styles.paddingRight;
      if (styles.paddingTop !== undefined) node.paddingTop = styles.paddingTop;
      if (styles.paddingBottom !== undefined) node.paddingBottom = styles.paddingBottom;
    }
    
    // Apply text-specific properties for text nodes
    if (node.type === 'TEXT') {
      const textNode = node as TextNode;
      
      // Load a font for any text modifications
      // Default to Inter Regular if nothing specified
      let fontName = textNode.fontName;
      if (typeof fontName !== 'symbol') {
        // Use provided font or default to Inter
        const family = (styles.fontName && typeof styles.fontName !== 'symbol') 
          ? styles.fontName.family 
          : (fontName.family || 'Inter');
          
        // Use provided style or default to Regular
        const style = (styles.fontName && typeof styles.fontName !== 'symbol')
          ? styles.fontName.style
          : (fontName.style || 'Regular');
          
        // If fontWeight is specified as a number, map it to a font style
        if (styles.fontWeight !== undefined) {
          let weightStyle = style; // Default to current style
          
          if (typeof styles.fontWeight === 'number') {
            // Map numeric weights to font styles
            if (styles.fontWeight <= 300) weightStyle = 'Light';
            else if (styles.fontWeight <= 400) weightStyle = 'Regular';
            else if (styles.fontWeight <= 500) weightStyle = 'Medium';
            else if (styles.fontWeight <= 600) weightStyle = 'SemiBold';
            else if (styles.fontWeight <= 700) weightStyle = 'Bold';
            else if (styles.fontWeight <= 800) weightStyle = 'ExtraBold';
            else weightStyle = 'Black';
          } else if (typeof styles.fontWeight === 'string') {
            weightStyle = styles.fontWeight;
          }
          
          // Try to load the font with the weight style
          try {
            await figma.loadFontAsync({ family, style: weightStyle });
            textNode.fontName = { family, style: weightStyle };
          } catch (e) {
            console.warn(`Font ${family} ${weightStyle} not available, trying Regular`);
            await figma.loadFontAsync({ family, style: 'Regular' });
            textNode.fontName = { family, style: 'Regular' };
          }
        } else {
          // Otherwise just load the specified or current font
          await figma.loadFontAsync({ family, style });
          textNode.fontName = { family, style };
        }
      }
      
      // Apply text content if provided
      if (styles.text || styles.characters || styles.content) {
        textNode.characters = styles.text || styles.characters || styles.content || textNode.characters;
      }
      
      // Apply font size if provided
      if (styles.fontSize !== undefined) {
        textNode.fontSize = styles.fontSize;
      }
      
      // Apply text case if provided
      if (styles.textCase) {
        textNode.textCase = styles.textCase;
      }
      
      // Apply text decoration if provided
      if (styles.textDecoration) {
        textNode.textDecoration = styles.textDecoration;
      }
      
      // Apply letter spacing if provided
      if (styles.letterSpacing) {
        textNode.letterSpacing = styles.letterSpacing;
      }
      
      // Apply line height if provided
      if (styles.lineHeight) {
        textNode.lineHeight = styles.lineHeight;
      }
      
      // Apply text alignment if provided
      if (styles.textAlignHorizontal) {
        textNode.textAlignHorizontal = styles.textAlignHorizontal;
      }
      
      if (styles.textAlignVertical) {
        textNode.textAlignVertical = styles.textAlignVertical;
      }
    }
    
    // Apply children styles if this is a node with children
    if ('children' in node && styles.children && Array.isArray(styles.children)) {
      // This would handle nested style definitions
      // Not implemented for this initial version
    }
    
  } catch (e) {
    console.error('Error applying extended styles:', e);
  }
}

/**
 * Applies container styles with enhanced options
 */
async function applyExtendedContainerStyles(
  node: FrameNode | GroupNode | ComponentNode | InstanceNode, 
  styles: ExtendedStyleOptions
): Promise<void> {
  await applyExtendedStyles(node, styles);
}

/**
 * Applies shape styles with enhanced options
 */
async function applyExtendedShapeStyles(
  node: RectangleNode | EllipseNode | PolygonNode | StarNode | VectorNode | LineNode,
  styles: ExtendedStyleOptions
): Promise<void> {
  await applyExtendedStyles(node, styles);
}

/**
 * Applies text styles with enhanced options
 */
async function applyExtendedTextStyles(node: TextNode, styles: ExtendedStyleOptions): Promise<void> {
  await applyExtendedStyles(node, styles);
}

/**
 * Helper function to extract brand colors from text descriptions
 */
function extractBrandColors(description: string): {[key: string]: string} {
  if (!description) return {};
  
  const brandColors: {[key: string]: string} = {};
  
  // Look for color definitions in the format (#NAME: #HEX)
  const colorRegex = /#([A-Za-z0-9_]+):\s*(#[A-Fa-f0-9]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))/g;
  let match;
  
  while ((match = colorRegex.exec(description)) !== null) {
    const [, name, value] = match;
    brandColors[name.toLowerCase()] = value;
  }
  
  // Also look for color names and hex codes in parentheses: NAME (#HEX)
  const colorNameRegex = /([A-Za-z0-9_]+)\s*\((#[A-Fa-f0-9]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\))\)/g;
  
  while ((match = colorNameRegex.exec(description)) !== null) {
    const [, name, value] = match;
    brandColors[name.toLowerCase()] = value;
  }
  
  // Look for explicit hex codes with names in common formats
  const hexWithNameRegex = /(#[A-Fa-f0-9]{3,8})[,\s]+([\w\s]+)|(\w+)[,\s]+(#[A-Fa-f0-9]{3,8})/g;
  
  while ((match = hexWithNameRegex.exec(description)) !== null) {
    const [, hex1, name1, name2, hex2] = match;
    if (hex1 && name1) {
      brandColors[name1.trim().toLowerCase().replace(/\s+/g, '_')] = hex1;
    } else if (name2 && hex2) {
      brandColors[name2.trim().toLowerCase().replace(/\s+/g, '_')] = hex2;
    }
  }
  
  // Regular expressions to capture color mentions like "primary color is blue"
  const primaryColorRegex = /primary(?:\s+|-|_)?color(?:\s+is|\s*:|\s*=)?\s+([#]?[a-zA-Z0-9]+)/i;
  const secondaryColorRegex = /secondary(?:\s+|-|_)?color(?:\s+is|\s*:|\s*=)?\s+([#]?[a-zA-Z0-9]+)/i;
  const accentColorRegex = /accent(?:\s+|-|_)?color(?:\s+is|\s*:|\s*=)?\s+([#]?[a-zA-Z0-9]+)/i;
  const backgroundColorRegex = /background(?:\s+|-|_)?color(?:\s+is|\s*:|\s*=)?\s+([#]?[a-zA-Z0-9]+)/i;
  const textColorRegex = /text(?:\s+|-|_)?color(?:\s+is|\s*:|\s*=)?\s+([#]?[a-zA-Z0-9]+)/i;
  
  // Extract colors using regexes
  const primaryMatch = description.match(primaryColorRegex);
  if (primaryMatch && primaryMatch[1]) {
    brandColors.primary = primaryMatch[1];
  }
  
  const secondaryMatch = description.match(secondaryColorRegex);
  if (secondaryMatch && secondaryMatch[1]) {
    brandColors.secondary = secondaryMatch[1];
  }
  
  const accentMatch = description.match(accentColorRegex);
  if (accentMatch && accentMatch[1]) {
    brandColors.accent = accentMatch[1];
  }
  
  const backgroundMatch = description.match(backgroundColorRegex);
  if (backgroundMatch && backgroundMatch[1]) {
    brandColors.background = backgroundMatch[1];
  }
  
  const textMatch = description.match(textColorRegex);
  if (textMatch && textMatch[1]) {
    brandColors.text = textMatch[1];
  }
  
  // Named color regex (e.g., "use blue for buttons")
  const namedColorRegex = /use\s+([a-zA-Z]+)\s+(?:for|as|in)\s+([a-zA-Z]+)/i;
  
  // Extract named color associations
  const namedMatches = Array.from(description.matchAll(new RegExp(namedColorRegex, 'gi')));
  for (const match of namedMatches) {
    if (match[1] && match[2]) {
      const color = match[1].toLowerCase();
      const element = match[2].toLowerCase();
      
      if (isValidColorName(color)) {
        // Map element types to color roles
        if (['button', 'buttons', 'cta'].includes(element)) {
          brandColors.primary = color;
        } else if (['accent', 'highlight', 'highlights'].includes(element)) {
          brandColors.accent = color;
        } else if (['background', 'backgrounds', 'bg'].includes(element)) {
          brandColors.background = color;
        } else if (['text', 'font', 'typography'].includes(element)) {
          brandColors.text = color;
        } else {
          // Store custom associations
          brandColors[element] = color;
        }
      }
    }
  }
  
  // Branding mentions with specific colors
  const brandingRegex = /(?:brand|branding|theme)\s+(?:is|with|using|in|of)\s+([a-zA-Z]+)/i;
  const brandMatch = description.match(brandingRegex);
  if (brandMatch && brandMatch[1]) {
    const brandColor = brandMatch[1].toLowerCase();
    if (isValidColorName(brandColor)) {
      brandColors.primary = brandColor;
      
      // Generate complementary colors based on brand color
      if (brandColor === 'blue') {
        brandColors.secondary = 'lightblue';
        brandColors.accent = 'navy';
      } else if (brandColor === 'red') {
        brandColors.secondary = 'pink';
        brandColors.accent = 'darkred';
      } else if (brandColor === 'green') {
        brandColors.secondary = 'lightgreen';
        brandColors.accent = 'darkgreen';
      } else if (brandColor === 'purple') {
        brandColors.secondary = 'lavender';
        brandColors.accent = 'darkpurple';
      }
    }
  }
  
  console.log('Extracted brand colors:', brandColors);
  return brandColors;
}

/**
 * Check if a string is a valid color name
 */
function isValidColorName(color: string): boolean {
  const validColors = [
    'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown', 'gray', 'grey',
    'black', 'white', 'teal', 'cyan', 'magenta', 'lime', 'olive', 'navy', 'darkblue', 'lightblue',
    'darkred', 'lightred', 'darkgreen', 'lightgreen', 'darkpurple', 'lavender'
  ];
  
  return validColors.includes(color.toLowerCase());
}

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

// Return type for handle functions
type HandleResponse = {
  success: boolean;
  error?: string;
  data?: any;
};

// Helper function to create error responses
function createErrorResponse(message: string): HandleResponse {
  console.error(message);
  return {
    success: false,
    error: message
  };
}

// Helper function to create success responses
function createSuccessResponse(data: any = {}): HandleResponse {
  return {
    success: true,
    data
  };
}

// Helper function to handle adding elements
async function handleAddElement(msg: { type: string, payload: any }): Promise<HandleResponse> {
  try {
    // Check if payload is valid
    if (!msg.payload || !msg.payload.elementType) {
      return createErrorResponse('Invalid payload for ADD_ELEMENT command');
    }
    
    // Get the parent node ID
    const parentId = msg.payload.parent;
    const properties = msg.payload.properties || {};
    const position = properties.position || {};
    const nodeType = msg.payload.elementType;
    
    // Look up the parent in the current document
    let parent: BaseNode | null = null;
    if (parentId) {
      parent = figma.getNodeById(parentId);
      if (!parent) {
        console.warn(`Parent node with ID ${parentId} not found`);
      }
    }
    
    // If parent not found or not specified, use current page
    const parentPage = parent && 'type' in parent && parent.type === 'PAGE' 
      ? parent as PageNode 
      : figma.currentPage;
    
    // Get parent frame if parent is a frame
    let parentFrame: FrameNode | GroupNode | ComponentSetNode | ComponentNode | InstanceNode | null = null;
    if (parent && 'type' in parent) {
      if (parent.type === 'FRAME' || parent.type === 'GROUP' || 
          parent.type === 'COMPONENT' || parent.type === 'COMPONENT_SET' ||
          parent.type === 'INSTANCE') {
        parentFrame = parent as FrameNode | ComponentNode | ComponentSetNode | InstanceNode | GroupNode;
      }
    }
    
    // Parse enhanced styles
    const enhancedStyles = properties.styles || {};
    
    // Determine the position based on parent frame or positioning data
    let x = position.x !== undefined ? position.x : 0;
    let y = position.y !== undefined ? position.y : 0;
    
    // When using layout position properties
    if (properties.layoutPosition) {
      // Get parent dimensions
      const parentWidth = parentFrame && 'width' in parentFrame ? parentFrame.width : figma.viewport.bounds.width;
      const parentHeight = parentFrame && 'height' in parentFrame ? parentFrame.height : figma.viewport.bounds.height;
      
      // Set position based on layout position
      switch (properties.layoutPosition) {
        case 'top':
          x = (parentWidth - (position.width || 100)) / 2;
          y = 0;
      break;
        case 'bottom':
          x = (parentWidth - (position.width || 100)) / 2;
          y = parentHeight - (position.height || 50);
      break;
        case 'left':
          x = 0;
          y = (parentHeight - (position.height || 100)) / 2;
      break;
        case 'right':
          x = parentWidth - (position.width || 50);
          y = (parentHeight - (position.height || 100)) / 2;
      break;
        case 'center':
          x = (parentWidth - (position.width || 100)) / 2;
          y = (parentHeight - (position.height || 100)) / 2;
      break;
      }
    }
    
    // Enrich styles with positioning
    const enrichedStyles = {
      ...enhancedStyles,
      x,
      y,
      width: position.width,
      height: position.height
    };
    
    // Create the element based on type
    let createdNode: SceneNode | null = null;
    
    switch (nodeType) {
      case 'TEXT': {
        // Create a text node
  const text = figma.createText();
        
        // Set text content
        // Try to use displayText first, then fallback to other properties
        const content = properties.displayText || properties.text || properties.content || 'Text';
        
        // Load font first
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          text.fontName = { family: "Inter", style: "Regular" };
          text.characters = content;
          
          // Add to parent
          if (parentFrame) {
            parentFrame.appendChild(text);
          } else {
            parentPage.appendChild(text);
          }
          
          // Position text
          text.x = x;
          text.y = y;
          
          // Apply text specific styles
          await applyExtendedTextStyles(text, enrichedStyles);
          
          createdNode = text;
        } catch (e) {
          console.warn('Error loading font:', e);
          return createErrorResponse(`Failed to load font: ${e}`);
        }
        break;
      }
      
      case 'BUTTON': {
        // Create a rectangle for the button
        const button = figma.createRectangle();
  button.name = properties.name || 'Button';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(button);
        } else {
          parentPage.appendChild(button);
        }
  
  // Set button size
        const width = enrichedStyles.width || 120;
        const height = enrichedStyles.height || 40;
  button.resize(width, height);
  
        // Position button
        button.x = x;
        button.y = y;
        
        // Basic styling
        button.fills = [{ type: 'SOLID', color: { r: 0.12, g: 0.47, b: 0.71 } }];
        button.cornerRadius = 4;
  
  // Create button text
  const text = figma.createText();
        
        // Load font before setting characters
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Medium" });
          text.fontName = { family: "Inter", style: "Medium" };
          text.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
          
          // Use displayText first, then fallback to other properties
          text.characters = properties.displayText || properties.text || properties.content || 'Button';
          
          // Add to page
          parentFrame ? parentFrame.appendChild(text) : parentPage.appendChild(text);
          
          // Center text in the button
          text.x = button.x + (button.width - text.width) / 2;
          text.y = button.y + (button.height - text.height) / 2;
        } catch (e) {
          console.warn('Error loading button text font:', e);
        }
        
        // Apply extended styles to button
        await applyExtendedShapeStyles(button, enrichedStyles);
        
        // Group button and text
        const nodes = [button, text];
        if (parentFrame) {
          const group = figma.group(nodes, parentFrame);
          group.name = properties.name || 'Button Group';
          createdNode = group;
        } else {
          const group = figma.group(nodes, parentPage);
          group.name = properties.name || 'Button Group';
          createdNode = group;
        }
        break;
      }
      
      case 'INPUT': {
        // Create a rectangle for the input
        const input = figma.createRectangle();
  input.name = properties.name || 'Input Field';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(input);
        } else {
          parentPage.appendChild(input);
        }
  
  // Set input size
        const width = enrichedStyles.width || 240;
        const height = enrichedStyles.height || 40;
  input.resize(width, height);
  
        // Basic styling
        input.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        input.strokes = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }];
        input.strokeWeight = 1;
        input.cornerRadius = 4;
  
  // Create placeholder text
  const text = figma.createText();
        
        // Load font before setting characters
        try {
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          text.fontName = { family: "Inter", style: "Regular" };
          text.fills = [{ type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 } }];
          
          // Use displayText first, then fallback to other properties
          text.characters = properties.displayText || properties.placeholder || properties.text || properties.content || 'Enter text...';
          
          // Add text to page first to get its dimensions
          parentFrame ? parentFrame.appendChild(text) : parentPage.appendChild(text);
          
          // Position text inside input
          text.x = input.x + 12;
          text.y = input.y + (height - text.height) / 2;
        } catch (e) {
          console.warn('Error loading input field font:', e);
        }
        
        // Apply extended styles
        await applyExtendedShapeStyles(input, enrichedStyles);
        
        // Group input and text
        const nodes = [input, text];
        if (parentFrame) {
          const group = figma.group(nodes, parentFrame);
          group.name = properties.name || 'Input Group';
          createdNode = group;
        } else {
          const group = figma.group(nodes, parentPage);
          group.name = properties.name || 'Input Group';
          createdNode = group;
        }
        break;
      }
      
      case 'FRAME': {
        // Create the frame
  const frame = figma.createFrame();
        frame.name = properties.name || 'Frame';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(frame);
        } else {
          parentPage.appendChild(frame);
        }
        
        // Set default size
        const width = enrichedStyles.width || 400;
        const height = enrichedStyles.height || 300;
  frame.resize(width, height);
  
        // Basic styling
        frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        
        // Add content if provided
        if (properties.text || properties.content) {
          try {
            // Create a text node for the content
            const text = figma.createText();
            await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            text.fontName = { family: "Inter", style: "Regular" };
            text.characters = properties.text || properties.content;
            frame.appendChild(text);
            text.x = 16;
            text.y = 16;
            text.resize(width - 32, text.height);
          } catch (e) {
            console.warn('Error adding text content to frame:', e);
          }
        }
        
        // Apply extended styles
        await applyExtendedContainerStyles(frame, enrichedStyles);
        
        createdNode = frame;
        break;
      }
      
      case 'CARD': {
        // Create a rectangle for the card instead of a frame
        const card = figma.createRectangle();
        card.name = properties.name || 'Card';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(card);
        } else {
          parentPage.appendChild(card);
        }
        
        // Set card size
        const width = enrichedStyles.width || 300;
        const height = enrichedStyles.height || 200;
        card.resize(width, height);
        
        // Basic styling
        card.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        card.cornerRadius = 8;
        card.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        card.strokeWeight = 1;
        
        // Add shadow effect
        card.effects = [
          {
            type: 'DROP_SHADOW',
            color: { r: 0, g: 0, b: 0, a: 0.1 },
            offset: { x: 0, y: 2 },
            radius: 4,
            visible: true,
            blendMode: 'NORMAL'
          }
        ];
        
        // Apply extended styles
        await applyExtendedShapeStyles(card, enrichedStyles);
        
        // Create an array to hold all elements that will be part of the card group
        const elements: SceneNode[] = [card];
        
        // Try to add title and description text
        try {
          // Create and place title
          if (properties.title || properties.name) {
            const title = figma.createText();
            await figma.loadFontAsync({ family: "Inter", style: "Medium" });
            title.fontName = { family: "Inter", style: "Medium" };
            title.fontSize = 16;
            title.characters = properties.title || properties.name || 'Card Title';
            
            // Add to page to get dimensions
            parentFrame ? parentFrame.appendChild(title) : parentPage.appendChild(title);
            
            // Position at the top of the card with padding
            title.x = card.x + 16;
            title.y = card.y + 16;
            
            elements.push(title);
            
            // Add description if provided
            if (properties.text || properties.content) {
              const desc = figma.createText();
              await figma.loadFontAsync({ family: "Inter", style: "Regular" });
              desc.fontName = { family: "Inter", style: "Regular" };
              desc.fontSize = 14;
              desc.characters = properties.text || properties.content;
              
              // Add to page to get dimensions
              parentFrame ? parentFrame.appendChild(desc) : parentPage.appendChild(desc);
              
              // Position below the title
              desc.x = card.x + 16;
              desc.y = title.y + title.height + 8;
              desc.resize(width - 32, desc.height);
              
              elements.push(desc);
            }
          }
        } catch (e) {
          console.warn('Error adding text to card:', e);
        }
        
        // Group all elements
        if (parentFrame) {
          const group = figma.group(elements, parentFrame);
          group.name = properties.name || 'Card Group';
          createdNode = group;
        } else {
          const group = figma.group(elements, parentPage);
          group.name = properties.name || 'Card Group';
          createdNode = group;
        }
        break;
      }
      
      case 'NAVBAR': {
        // Create a rectangle for the navbar instead of a frame
        const navbar = figma.createRectangle();
  navbar.name = properties.name || 'Navigation Bar';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(navbar);
        } else {
          parentPage.appendChild(navbar);
        }
        
        // Get parent width if available, or use default
        const parentWidth = parentFrame && 'width' in parentFrame ? parentFrame.width : 1440;
        
        // Set navbar size (typically full width)
        const width = enrichedStyles.width || parentWidth;
        const height = enrichedStyles.height || 64;
  navbar.resize(width, height);
  
        // Basic styling
        navbar.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
        
        // Create a collection of nav elements
        const navElements: SceneNode[] = [navbar];
        
        try {
          // Create brand/logo text
          const logo = figma.createText();
          await figma.loadFontAsync({ family: "Inter", style: "Bold" });
          logo.fontName = { family: "Inter", style: "Bold" };
          logo.fontSize = 20;
          logo.characters = properties.title || 'Logo';
          
          // Add to page to get dimensions
          parentFrame ? parentFrame.appendChild(logo) : parentPage.appendChild(logo);
          
          // Position on the left of navbar
          logo.x = navbar.x + 24;
          logo.y = navbar.y + (navbar.height - logo.height) / 2;
          
          navElements.push(logo);
          
          // Create nav links as individual text nodes
          await figma.loadFontAsync({ family: "Inter", style: "Regular" });
          
          const links = properties.links || ['Home', 'About', 'Services', 'Contact'];
          const spacing = 24;
          
          // Calculate total width of all links with spacing
          let totalWidth = 0;
          const linkNodes: TextNode[] = [];
          
          for (const linkText of links) {
            const link = figma.createText();
            link.fontName = { family: "Inter", style: "Regular" };
            link.characters = linkText;
            
            // Add to page to get dimensions
            parentFrame ? parentFrame.appendChild(link) : parentPage.appendChild(link);
            
            totalWidth += link.width + spacing;
            linkNodes.push(link);
            navElements.push(link);
          }
          
          // Position the links on the right of the navbar
          let xOffset = navbar.x + navbar.width - totalWidth - 24;
          
          for (const link of linkNodes) {
            link.y = navbar.y + (navbar.height - link.height) / 2;
            link.x = xOffset;
            xOffset += link.width + spacing;
          }
        } catch (e) {
          console.warn('Error creating navbar items:', e);
        }
        
        // Apply extended styles
        await applyExtendedShapeStyles(navbar, enrichedStyles);
        
        // Group all elements
        if (parentFrame) {
          const group = figma.group(navElements, parentFrame);
          group.name = properties.name || 'Navbar Group';
          createdNode = group;
        } else {
          const group = figma.group(navElements, parentPage);
          group.name = properties.name || 'Navbar Group';
          createdNode = group;
        }
        break;
      }
      
      case 'RECTANGLE': {
        // Create a rectangle
        const rect = figma.createRectangle();
        rect.name = properties.name || 'Rectangle';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(rect);
  } else {
          parentPage.appendChild(rect);
        }
        
        // Set size
        const width = enrichedStyles.width || 100;
        const height = enrichedStyles.height || 100;
        rect.resize(width, height);
        
        // Basic styling
        rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        
        // Apply extended styles
        await applyExtendedShapeStyles(rect, enrichedStyles);
        
        createdNode = rect;
        break;
      }
      
      case 'ELLIPSE': {
        // Create an ellipse
        const ellipse = figma.createEllipse();
        ellipse.name = properties.name || 'Ellipse';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(ellipse);
        } else {
          parentPage.appendChild(ellipse);
        }
        
        // Set size
        const width = enrichedStyles.width || 100;
        const height = enrichedStyles.height || 100;
        ellipse.resize(width, height);
        
        // Basic styling
        ellipse.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        
        // Apply extended styles
        await applyExtendedShapeStyles(ellipse, enrichedStyles);
        
        createdNode = ellipse;
        break;
      }
      
      case 'POLYGON': {
        // Create a polygon
        const polygon = figma.createPolygon();
        polygon.name = properties.name || 'Polygon';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(polygon);
        } else {
          parentPage.appendChild(polygon);
        }
        
        // Set size
        const size = enrichedStyles.width || 100;
        polygon.resize(size, size);
        
        // Set point count if specified
        if (properties.pointCount && typeof properties.pointCount === 'number') {
          polygon.pointCount = Math.max(3, Math.min(12, properties.pointCount));
        }
        
        // Basic styling
        polygon.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        
        // Apply extended styles
        await applyExtendedShapeStyles(polygon, enrichedStyles);
        
        createdNode = polygon;
        break;
      }
      
      case 'STAR': {
        // Create a star
        const star = figma.createStar();
        star.name = properties.name || 'Star';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(star);
        } else {
          parentPage.appendChild(star);
        }
        
        // Set size
        const size = enrichedStyles.width || 100;
        star.resize(size, size);
        
        // Set point count if specified
        if (properties.pointCount && typeof properties.pointCount === 'number') {
          star.pointCount = Math.max(3, Math.min(20, properties.pointCount));
        }
        
        // Basic styling
        star.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        
        // Apply extended styles
        await applyExtendedShapeStyles(star, enrichedStyles);
        
        createdNode = star;
        break;
      }
      
      case 'LINE': {
        // Create a line (rectangle with minimal height)
        const line = figma.createLine();
        line.name = properties.name || 'Line';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(line);
        } else {
          parentPage.appendChild(line);
        }
        
        // Set length
        const length = enrichedStyles.width || 100;
        line.resize(length, 0);
        
        // Set stroke properties
        line.strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
        line.strokeWeight = properties.strokeWeight || 1;
        
        if (properties.strokeCap) {
          line.strokeCap = properties.strokeCap as StrokeCap;
        }
        
        // Apply basic styles instead of shape-specific
        await applyExtendedStyles(line, enrichedStyles);
        
        createdNode = line;
        break;
      }
      
      case 'VECTOR': {
        // Create a vector
        const vector = figma.createVector();
        vector.name = properties.name || 'Vector';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(vector);
        } else {
          parentPage.appendChild(vector);
        }
        
        // Set size
        const width = enrichedStyles.width || 100;
        const height = enrichedStyles.height || 100;
        vector.resize(width, height);
        
        // Basic styling
        vector.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        
        // Apply extended styles
        await applyExtendedShapeStyles(vector, enrichedStyles);
        
        createdNode = vector;
        break;
      }
      
      case 'CUSTOM': {
        // Create a rectangle for simpler custom element
        const customShape = figma.createRectangle();
        customShape.name = properties.name || 'Custom Element';
        
        // Add to parent
        if (parentFrame) {
          parentFrame.appendChild(customShape);
        } else {
          parentPage.appendChild(customShape);
        }
        
        // Set size
        const width = enrichedStyles.width || 400;
        const height = enrichedStyles.height || 300;
        customShape.resize(width, height);
        
        // Basic styling
        customShape.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }];
        customShape.cornerRadius = 8;
        
        // Apply extended styles
        await applyExtendedShapeStyles(customShape, enrichedStyles);
        
        // Add content if provided
        let contentNode: TextNode | undefined = undefined;
        if (properties.text || properties.content) {
          try {
            // Create a text node for the content
            const text = figma.createText();
            await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            text.fontName = { family: "Inter", style: "Regular" };
            text.characters = properties.text || properties.content;
            
            // Add to page first to get dimensions
            parentFrame ? parentFrame.appendChild(text) : parentPage.appendChild(text);
            
            // Position inside the custom shape
            text.x = customShape.x + 16;
            text.y = customShape.y + 16;
            
            // Resize to fit content
            text.resize(width - 32, text.height);
            
            contentNode = text;
          } catch (e) {
            console.warn('Error adding text to custom element:', e);
          }
        }
        
        // Group if text was added
        if (contentNode) {
          const group = parentFrame 
            ? figma.group([customShape, contentNode], parentFrame)
            : figma.group([customShape, contentNode], parentPage);
          group.name = properties.name || 'Custom Element Group';
          createdNode = group;
        } else {
          createdNode = customShape;
        }
        break;
      }
      
      default:
        return createErrorResponse(`Unsupported element type: ${nodeType}`);
    }
    
    // Check if we successfully created a node
    if (!createdNode) {
      return createErrorResponse(`Failed to create element of type: ${nodeType}`);
    }
    
    // Add the node to the session state's created wireframes if applicable
    const wireframeId = sessionState.activeWireframeId;
    if (wireframeId) {
      sessionState.addNodeToWireframe(wireframeId, createdNode);
    }
    
    // Get detailed node properties to return
    const nodeDetails = getNodeDetails(createdNode);
    
    // Return the created node information
    return createSuccessResponse({
      id: createdNode.id,
      type: createdNode.type,
      name: createdNode.name,
      properties: nodeDetails
    });
  } catch (error) {
    console.error('Error in handleAddElement', error);
    return createErrorResponse(`Error adding element: ${error instanceof Error ? error.message : String(error)}`);
  }
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

/**
 * Helper function to get detailed properties for any node
 */
function getNodeDetails(node: SceneNode): Record<string, any> {
  const baseDetails: Record<string, any> = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible
  };
  
  // Add position and size if available
  if ('x' in node) baseDetails.x = node.x;
  if ('y' in node) baseDetails.y = node.y;
  if ('width' in node) baseDetails.width = node.width;
  if ('height' in node) baseDetails.height = node.height;
  
  // Add fills if available
  if ('fills' in node) baseDetails.fills = node.fills;
  
  // Add text specific properties
  if (node.type === 'TEXT') {
    const textNode = node as TextNode;
    baseDetails.characters = textNode.characters;
    baseDetails.fontSize = textNode.fontSize;
    baseDetails.fontName = textNode.fontName;
    baseDetails.textAlignHorizontal = textNode.textAlignHorizontal;
    baseDetails.textAlignVertical = textNode.textAlignVertical;
  }
  
  // Add frame specific properties
  if (node.type === 'FRAME') {
    const frameNode = node as FrameNode;
    baseDetails.cornerRadius = frameNode.cornerRadius;
    baseDetails.layoutMode = frameNode.layoutMode;
    baseDetails.counterAxisSizingMode = frameNode.counterAxisSizingMode;
    baseDetails.itemSpacing = frameNode.itemSpacing;
    baseDetails.paddingLeft = frameNode.paddingLeft;
    baseDetails.paddingRight = frameNode.paddingRight;
    baseDetails.paddingTop = frameNode.paddingTop;
    baseDetails.paddingBottom = frameNode.paddingBottom;
  }
  
  return baseDetails;
}

/**
 * Utility function to clean fills/strokes by removing 'a' property from color objects
 * since Figma's API doesn't support it directly in the color object
 */
function cleanPaintStyles(styles: any[]): any[] {
  if (!Array.isArray(styles)) return styles;
  
  return styles.map(style => {
    if (style && style.type === 'SOLID' && style.color && 'a' in style.color) {
      // Extract alpha if present and set as opacity
      const opacity = style.color.a !== undefined ? style.color.a : (style.opacity || 1);
      
      // Create a new object without the 'a' property
      const { r, g, b } = style.color;
      
      return {
        ...style,
        color: { r, g, b },
        opacity: opacity
      };
    }
    return style;
  });
}

/**
 * Handler for creating a rectangle directly using Figma's API
 */
async function handleCreateRectangle(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0, 
    width = 100, 
    height = 100, 
    cornerRadius = 0,
    fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokes = [],
    effects = [],
    name = 'Rectangle',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create the rectangle
    const rect = figma.createRectangle();
    rect.name = name;
    
    // Set basic properties
    rect.x = x;
    rect.y = y;
    rect.resize(width, height);
    
    // Set corner radius
    if (typeof cornerRadius === 'number') {
      rect.cornerRadius = cornerRadius;
    } else if (typeof cornerRadius === 'object') {
      rect.topLeftRadius = cornerRadius.topLeft || 0;
      rect.topRightRadius = cornerRadius.topRight || 0;
      rect.bottomLeftRadius = cornerRadius.bottomLeft || 0;
      rect.bottomRightRadius = cornerRadius.bottomRight || 0;
    }
    
    // Set fills directly (clean fills to remove 'a' property)
    if (Array.isArray(fills) && fills.length > 0) {
      try {
        rect.fills = cleanPaintStyles(fills) as Paint[];
      } catch (error) {
        console.error('Error applying fills:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply fills: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Set strokes directly (clean strokes to remove 'a' property)
    if (Array.isArray(strokes) && strokes.length > 0) {
      try {
        rect.strokes = cleanPaintStyles(strokes) as Paint[];
      } catch (error) {
        console.error('Error applying strokes:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply strokes: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Set effects directly
    if (Array.isArray(effects) && effects.length > 0) {
      try {
        rect.effects = effects as Effect[];
      } catch (error) {
        console.error('Error applying effects:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply effects: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(rect);
      } else {
        figma.currentPage.appendChild(rect);
      }
    } else {
      figma.currentPage.appendChild(rect);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedShapeStyles(rect, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(rect),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}

/**
 * Handler for creating an ellipse directly using Figma's API
 */
async function handleCreateEllipse(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0, 
    width = 100, 
    height = 100,
    fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokes = [],
    effects = [],
    name = 'Ellipse',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create the ellipse
    const ellipse = figma.createEllipse();
    ellipse.name = name;
    
    // Set basic properties
    ellipse.x = x;
    ellipse.y = y;
    ellipse.resize(width, height);
    
    // Set fills directly (clean fills to remove 'a' property)
    if (Array.isArray(fills) && fills.length > 0) {
      try {
        ellipse.fills = cleanPaintStyles(fills) as Paint[];
      } catch (error) {
        console.error('Error applying fills:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply fills: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Set strokes directly (clean strokes to remove 'a' property)
    if (Array.isArray(strokes) && strokes.length > 0) {
      try {
        ellipse.strokes = cleanPaintStyles(strokes) as Paint[];
      } catch (error) {
        console.error('Error applying strokes:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply strokes: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Set effects directly
    if (Array.isArray(effects) && effects.length > 0) {
      try {
        ellipse.effects = effects as Effect[];
      } catch (error) {
        console.error('Error applying effects:', error);
        sendResponse({
          type: msg.type,
          success: false,
          error: `Failed to apply effects: ${error instanceof Error ? error.message : String(error)}`,
          id: msg.id,
          _isResponse: true
        });
        return;
      }
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(ellipse);
      } else {
        figma.currentPage.appendChild(ellipse);
      }
    } else {
      figma.currentPage.appendChild(ellipse);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedShapeStyles(ellipse, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(ellipse),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}

/**
 * Handler for creating text directly using Figma's API
 */
async function handleCreateText(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0,
    characters = '',
    fontSize = 14,
    fontName = { family: 'Inter', style: 'Regular' },
    fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    textAlignHorizontal = 'LEFT',
    textAlignVertical = 'TOP',
    name = 'Text',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create the text
    const text = figma.createText();
    text.name = name;
    
    // Set basic properties
    text.x = x;
    text.y = y;
    
    // Load font first
    try {
      await figma.loadFontAsync(fontName);
      text.fontName = fontName;
    } catch (e) {
      console.warn('Failed to load specified font, using fallback:', e);
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      text.fontName = { family: 'Inter', style: 'Regular' };
    }
    
    // Set text content
    text.characters = characters;
    
    // Set font size
    if (fontSize) {
      text.fontSize = fontSize;
    }
    
    // Set text alignment
    text.textAlignHorizontal = textAlignHorizontal as 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
    text.textAlignVertical = textAlignVertical as 'TOP' | 'CENTER' | 'BOTTOM';
    
    // Set fills with cleaned colors
    if (Array.isArray(fills) && fills.length > 0) {
      text.fills = cleanPaintStyles(fills) as Paint[];
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(text);
      } else {
        figma.currentPage.appendChild(text);
      }
    } else {
      figma.currentPage.appendChild(text);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedTextStyles(text, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(text),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}

/**
 * Handler for creating a frame directly using Figma's API
 */
async function handleCreateFrame(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0, 
    width = 400, 
    height = 300,
    fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokes = [],
    effects = [],
    cornerRadius = 0,
    layoutMode = 'NONE',
    primaryAxisAlignItems = 'MIN',
    counterAxisAlignItems = 'MIN',
    itemSpacing = 0,
    paddingLeft = 0,
    paddingRight = 0,
    paddingTop = 0,
    paddingBottom = 0,
    name = 'Frame',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create the frame
    const frame = figma.createFrame();
    frame.name = name;
    
    // Set basic properties
    frame.x = x;
    frame.y = y;
    frame.resize(width, height);
    
    // Set corner radius
    if (typeof cornerRadius === 'number') {
      frame.cornerRadius = cornerRadius;
    } else if (typeof cornerRadius === 'object') {
      frame.topLeftRadius = cornerRadius.topLeft || 0;
      frame.topRightRadius = cornerRadius.topRight || 0;
      frame.bottomLeftRadius = cornerRadius.bottomLeft || 0;
      frame.bottomRightRadius = cornerRadius.bottomRight || 0;
    }
    
    // Set fills with cleaned colors
    if (Array.isArray(fills) && fills.length > 0) {
      frame.fills = cleanPaintStyles(fills) as Paint[];
    }
    
    // Set strokes with cleaned colors
    if (Array.isArray(strokes) && strokes.length > 0) {
      frame.strokes = cleanPaintStyles(strokes) as Paint[];
    }
    
    // Set effects
    if (Array.isArray(effects) && effects.length > 0) {
      frame.effects = effects as Effect[];
    }
    
    // Set layout properties
    if (layoutMode !== 'NONE') {
      frame.layoutMode = layoutMode as 'HORIZONTAL' | 'VERTICAL';
      frame.primaryAxisAlignItems = primaryAxisAlignItems as 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
      frame.counterAxisAlignItems = counterAxisAlignItems as 'MIN' | 'CENTER' | 'MAX';
      frame.itemSpacing = itemSpacing;
      frame.paddingLeft = paddingLeft;
      frame.paddingRight = paddingRight;
      frame.paddingTop = paddingTop;
      frame.paddingBottom = paddingBottom;
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(frame);
      } else {
        figma.currentPage.appendChild(frame);
      }
    } else {
      figma.currentPage.appendChild(frame);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedContainerStyles(frame, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(frame),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}

/**
 * Handler for creating a component directly using Figma's API
 */
async function handleCreateComponent(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0, 
    width = 400, 
    height = 300,
    fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }],
    strokes = [],
    effects = [],
    cornerRadius = 0,
    layoutMode = 'NONE',
    primaryAxisAlignItems = 'MIN',
    counterAxisAlignItems = 'MIN',
    itemSpacing = 0,
    paddingLeft = 0,
    paddingRight = 0,
    paddingTop = 0,
    paddingBottom = 0,
    name = 'Component',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create the component
    const component = figma.createComponent();
    component.name = name;
    
    // Set basic properties
    component.x = x;
    component.y = y;
    component.resize(width, height);
    
    // Set corner radius
    if (typeof cornerRadius === 'number') {
      component.cornerRadius = cornerRadius;
    } else if (typeof cornerRadius === 'object') {
      component.topLeftRadius = cornerRadius.topLeft || 0;
      component.topRightRadius = cornerRadius.topRight || 0;
      component.bottomLeftRadius = cornerRadius.bottomLeft || 0;
      component.bottomRightRadius = cornerRadius.bottomRight || 0;
    }
    
    // Set fills with cleaned colors
    if (Array.isArray(fills) && fills.length > 0) {
      component.fills = cleanPaintStyles(fills) as Paint[];
    }
    
    // Set strokes with cleaned colors
    if (Array.isArray(strokes) && strokes.length > 0) {
      component.strokes = cleanPaintStyles(strokes) as Paint[];
    }
    
    // Set effects
    if (Array.isArray(effects) && effects.length > 0) {
      component.effects = effects as Effect[];
    }
    
    // Set layout properties
    if (layoutMode !== 'NONE') {
      component.layoutMode = layoutMode as 'HORIZONTAL' | 'VERTICAL';
      component.primaryAxisAlignItems = primaryAxisAlignItems as 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN';
      component.counterAxisAlignItems = counterAxisAlignItems as 'MIN' | 'CENTER' | 'MAX';
      component.itemSpacing = itemSpacing;
      component.paddingLeft = paddingLeft;
      component.paddingRight = paddingRight;
      component.paddingTop = paddingTop;
      component.paddingBottom = paddingBottom;
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(component);
      } else {
        figma.currentPage.appendChild(component);
      }
    } else {
      figma.currentPage.appendChild(component);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedContainerStyles(component, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(component),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}

/**
 * Handler for creating a line directly using Figma's API
 */
async function handleCreateLine(msg: PluginMessage): Promise<void> {
  const payload = msg.payload || {};
  const { 
    x = 0, 
    y = 0, 
    width = 100, 
    height = 0, 
    strokes = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    strokeWeight = 1,
    strokeCap = 'NONE',
    name = 'Line',
    parent = '',
    styles = {}
  } = payload;
  
  try {
    // Create a vector (line)
    const line = figma.createLine();
    line.name = name;
    
    // Set position
    line.x = x;
    line.y = y;
    
    // Set dimensions
    line.resize(width, height);
    
    // Set stroke properties
    if (Array.isArray(strokes) && strokes.length > 0) {
      line.strokes = cleanPaintStyles(strokes) as Paint[];
    }
    
    if (strokeWeight) {
      line.strokeWeight = strokeWeight;
    }
    
    if (strokeCap) {
      // @ts-ignore
      line.strokeCap = strokeCap;
    }
    
    // Add to parent if specified
    if (parent) {
      const parentNode = figma.getNodeById(parent);
      if (parentNode && ('appendChild' in parentNode)) {
        (parentNode as FrameNode | GroupNode | ComponentNode | ComponentSetNode | InstanceNode | PageNode).appendChild(line);
      } else {
        figma.currentPage.appendChild(line);
      }
    } else {
      figma.currentPage.appendChild(line);
    }
    
    // Apply extended styles
    if (Object.keys(styles).length > 0) {
      await applyExtendedShapeStyles(line, styles as ExtendedStyleOptions);
    }
    
    // Send success response with node details
    sendResponse({
      type: msg.type,
      success: true,
      data: getNodeDetails(line),
      id: msg.id,
      _isResponse: true
    });
  } catch (error) {
    sendResponse({
      type: msg.type,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      id: msg.id,
      _isResponse: true
    });
  }
}