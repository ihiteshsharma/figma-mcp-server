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
  node: RectangleNode | EllipseNode | PolygonNode | StarNode | VectorNode,
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

/**
 * Adds a new element to the design
 */
async function handleAddElement(message: PluginMessage): Promise<void> {
  console.log('Message received for ADD_ELEMENT:', message);
  
  const { elementType, parent, properties } = message.payload;
  console.log('Add element payload:', message.payload);
  
  // Validation: ensure elementType is set
  if (!elementType) {
    throw new Error('Missing elementType in payload');
  }
  
  console.log('Extracted values for ADD_ELEMENT:', { elementType, parent, properties });
  
  // Resolve parent node - in this priority:
  // 1. Specified parent ID 
  // 2. Current selection (if it's a frame or component)
  // 3. Active page from session state
  // 4. Current page
  
  let parentNode: BaseNode | null = null;
  
  // If parent ID is provided, try to get it
  if (parent) {
    parentNode = figma.getNodeById(parent);
    console.log(`Parent node resolved to ${parent} (${parentNode?.type}) via provided`);
  }
  
  // If no parent or parent not found, try to use current selection
  if (!parentNode && figma.currentPage.selection.length > 0) {
    const selectedNode = figma.currentPage.selection[0];
    
    // Only use if it's a frame, component, or instance
    if (selectedNode.type === 'FRAME' || selectedNode.type === 'COMPONENT' || selectedNode.type === 'INSTANCE' || selectedNode.type === 'GROUP') {
      parentNode = selectedNode;
      console.log(`Parent node resolved to ${selectedNode.id} (${selectedNode.type}) via selection`);
    }
  }
  
  // If still no parent, try to use active page from session state
  if (!parentNode) {
    const activePageId = sessionState.getActivePageId();
    if (activePageId) {
      parentNode = figma.getNodeById(activePageId);
      if (parentNode && parentNode.type === 'PAGE') {
        console.log(`Parent node resolved to ${activePageId} (PAGE) via session state`);
      } else {
        parentNode = null;
      }
    }
  }
  
  // Final fallback to current page
  if (!parentNode) {
    parentNode = figma.currentPage;
    console.log('Parent node resolved to current page as fallback');
  }
  
  // Check if the parent node is valid - it must be one of these types
  const validParentTypes = ['PAGE', 'FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'];
  if (!validParentTypes.includes(parentNode.type)) {
    throw new Error(`Invalid parent node type: ${parentNode.type}. Must be one of: ${validParentTypes.join(', ')}`);
  }
  
  // Cast to more specific types
  let parentPage: PageNode;
  let parentFrame: FrameNode | ComponentNode | InstanceNode | null = null;
  
  if (parentNode.type === 'PAGE') {
    parentPage = parentNode as PageNode;
  } else {
    // Navigate up the tree to find the parent page
    let currentNode: BaseNode = parentNode;
    while (currentNode && currentNode.type !== 'PAGE') {
      currentNode = currentNode.parent!;
    }
    parentPage = currentNode as PageNode;
    
    // The direct parent is a frame, component, or instance
    if (parentNode.type === 'FRAME' || parentNode.type === 'COMPONENT' || parentNode.type === 'INSTANCE') {
      parentFrame = parentNode as FrameNode | ComponentNode | InstanceNode;
    }
  }
  
  // Make sure the page containing the parent is the current page
  if (parentPage.id !== figma.currentPage.id) {
    figma.currentPage = parentPage;
    console.log(`Switched to page ${parentPage.id} to create element`);
  }
  
  let createdNode: SceneNode | null = null;
  
  try {
    // Create the element based on type
  switch (elementType) {
      case 'TEXT': {
        // Create text element
        if (parentFrame) {
          createdNode = await createTextElement(parentFrame, properties);
        } else {
          const frame = figma.createFrame();
          frame.name = properties.name || 'Text Container';
          parentPage.appendChild(frame);
          createdNode = await createTextElement(frame, properties);
        }
      break;
      }
        
      case 'BUTTON': {
        if (parentFrame) {
          createdNode = await createButtonElement(parentFrame, properties);
        } else {
          createdNode = await createButtonOnPage(parentPage, properties);
        }
      break;
      }
        
      case 'INPUT': {
        if (parentFrame) {
          createdNode = await createInputElement(parentFrame, properties);
        } else {
          createdNode = await createInputOnPage(parentPage, properties);
        }
      break;
      }
        
      case 'FRAME': {
        if (parentFrame) {
          createdNode = createFrameElement(parentFrame, properties);
        } else {
          // Create directly on page
          const frame = figma.createFrame();
          
          // Apply name if provided
          frame.name = properties.name || 'Frame';
          
          // Set position and size if provided
          if (properties.position) {
            if (properties.position.x !== undefined) frame.x = properties.position.x;
            if (properties.position.y !== undefined) frame.y = properties.position.y;
            if (properties.position.width !== undefined) frame.resize(properties.position.width, frame.height);
            if (properties.position.height !== undefined) frame.resize(frame.width, properties.position.height);
          } else {
            // Default position
            frame.x = 0;
            frame.y = 0;
            frame.resize(400, 300);
          }
          
          // Add some content based on description
          if (properties.text || properties.content) {
            const text = figma.createText();
            text.characters = properties.text || properties.content;
            frame.appendChild(text);
            text.x = 16;
            text.y = 16;
          }
          
          // Apply any specific styles
          if (properties.styles) {
            applyContainerStyles(frame, properties.styles);
          }
          
          parentPage.appendChild(frame);
          createdNode = frame;
        }
      break;
      }
        
      case 'CARD': {
        if (parentFrame) {
          createdNode = await createCardElement(parentFrame, properties);
        } else {
          // Create on page
          const card = figma.createFrame();
          card.name = properties.name || 'Card';
          
          // Set position and size if provided
          if (properties.position) {
            if (properties.position.x !== undefined) card.x = properties.position.x;
            if (properties.position.y !== undefined) card.y = properties.position.y;
            if (properties.position.width !== undefined) card.resize(properties.position.width, card.height);
            if (properties.position.height !== undefined) card.resize(card.width, properties.position.height);
          } else {
            card.resize(300, 200);
          }
          
          // Add text content
          const cardTitle = figma.createText();
          cardTitle.characters = "Card Title";
          cardTitle.x = 16;
          cardTitle.y = 16;
          card.appendChild(cardTitle);
          
          // Add description if provided
          if (properties.text || properties.content) {
            const cardDesc = figma.createText();
            cardDesc.characters = properties.text || properties.content;
            cardDesc.x = 16;
            cardDesc.y = 48;
            card.appendChild(cardDesc);
          }
          
          // Apply styles
          card.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
          card.cornerRadius = 8;
          card.strokeWeight = 1;
          card.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
          
          // Apply any specific styles
          if (properties.styles) {
            applyContainerStyles(card, properties.styles);
          }
          
          parentPage.appendChild(card);
          createdNode = card;
        }
      break;
      }
        
      case 'NAVBAR': {
        if (parentFrame) {
          createdNode = await createNavbarElement(parentFrame, properties);
        } else {
          // Create a navbar at the top of the page
          const navbar = figma.createFrame();
          navbar.name = properties.name || 'Navigation Bar';
          
          // Set position and size
          if (properties.position) {
            if (properties.position.x !== undefined) navbar.x = properties.position.x;
            if (properties.position.y !== undefined) navbar.y = properties.position.y;
            if (properties.position.width !== undefined) navbar.resize(properties.position.width, navbar.height);
            if (properties.position.height !== undefined) navbar.resize(navbar.width, properties.position.height);
          } else {
            navbar.resize(800, 64);
            navbar.x = 0;
            navbar.y = 0;
          }
          
          // Set layout
          navbar.layoutMode = 'HORIZONTAL';
          navbar.primaryAxisAlignItems = 'SPACE_BETWEEN';
          navbar.counterAxisAlignItems = 'CENTER';
          navbar.paddingLeft = 16;
          navbar.paddingRight = 16;
          
          // Add logo
          const logo = figma.createText();
          logo.characters = 'Logo';
          logo.fontSize = 20;
          logo.setRangeFontName(0, logo.characters.length, { family: "Inter", style: "Bold" });
          
          // Add navigation links
          const navLinks = figma.createFrame();
          navLinks.name = 'Nav Links';
          navLinks.layoutMode = 'HORIZONTAL';
          navLinks.itemSpacing = 24;
          navLinks.fills = [];
          
          // Add some default links
          const link1 = figma.createText();
          link1.characters = 'Home';
          navLinks.appendChild(link1);
          
          const link2 = figma.createText();
          link2.characters = 'About';
          navLinks.appendChild(link2);
          
          const link3 = figma.createText();
          link3.characters = 'Contact';
          navLinks.appendChild(link3);
          
          // Add components to navbar
          navbar.appendChild(logo);
          navbar.appendChild(navLinks);
          
          // Apply styling
          navbar.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
          navbar.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
          navbar.strokeWeight = 1;
          navbar.strokeAlign = 'INSIDE';
          
          // Apply any specific styles
          if (properties.styles) {
            applyContainerStyles(navbar, properties.styles);
          }
          
          parentPage.appendChild(navbar);
          createdNode = navbar;
        }
      break;
      }
      
      case 'RECTANGLE': {
        let rect: RectangleNode;
        
        if (parentFrame) {
          rect = createRectangleElement(parentFrame, properties);
        } else {
          // Create directly on page
          rect = figma.createRectangle();
          rect.name = properties.name || 'Rectangle';
          
          // Set position and size
          if (properties.position) {
            if (properties.position.x !== undefined) rect.x = properties.position.x;
            if (properties.position.y !== undefined) rect.y = properties.position.y;
            if (properties.position.width !== undefined) rect.resize(properties.position.width, rect.height);
            if (properties.position.height !== undefined) rect.resize(rect.width, properties.position.height);
          } else {
            rect.resize(100, 100);
          }
          
          // Apply basic styling
          rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
          
          // Apply specific styles if provided
          if (properties.styles) {
            applyShapeStyles(rect, properties.styles);
          }
          
          parentPage.appendChild(rect);
        }
        
        createdNode = rect;
      break;
      }
      
      case 'CUSTOM': {
        // For custom elements, create a frame and add text content
        const frame = figma.createFrame();
        frame.name = properties.name || 'Custom Element';
        
        // Set position and size
        if (properties.position) {
          if (properties.position.x !== undefined) frame.x = properties.position.x;
          if (properties.position.y !== undefined) frame.y = properties.position.y;
          if (properties.position.width !== undefined) frame.resize(properties.position.width, frame.height);
          if (properties.position.height !== undefined) frame.resize(frame.width, properties.position.height);
        } else {
          frame.resize(400, 300);
        }
        
        // Add text content with the description
        if (properties.text || properties.content) {
          const text = figma.createText();
          text.characters = properties.text || properties.content;
          frame.appendChild(text);
          text.x = 16;
          text.y = 16;
          
          // Try to fit the text
          text.resize(frame.width - 32, text.height);
        }
        
        // Apply styles
        if (properties.style === 'minimal') {
          frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
          frame.strokeWeight = 1;
          frame.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
        } else {
          frame.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 }, opacity: 1 }];
          frame.cornerRadius = 8;
          frame.strokeWeight = 1;
          frame.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
          
          // Add a subtle shadow
          frame.effects = [
            {
              type: 'DROP_SHADOW',
              color: { r: 0, g: 0, b: 0, a: 0.1 },
              offset: { x: 0, y: 2 },
              radius: 4,
              visible: true,
              blendMode: 'NORMAL'
            }
          ];
        }
        
        // Apply any specific styles
        if (properties.styles) {
          applyContainerStyles(frame, properties.styles);
        }
        
        // Attach to parent
        if (parentFrame) {
          parentFrame.appendChild(frame);
        } else {
          parentPage.appendChild(frame);
        }
        
        createdNode = frame;
      break;
      }
      
      case 'FORM': {
        // Create a form container frame
        const form = figma.createFrame();
        form.name = properties.name || 'Form';
        
        // Set position and size
        if (properties.position) {
          if (properties.position.x !== undefined) form.x = properties.position.x;
          if (properties.position.y !== undefined) form.y = properties.position.y;
          if (properties.position.width !== undefined) form.resize(properties.position.width, form.height);
          if (properties.position.height !== undefined) form.resize(form.width, properties.position.height);
        } else {
          form.resize(400, 400);
        }
        
        // Set layout
        form.layoutMode = 'VERTICAL';
        form.itemSpacing = 16;
        form.paddingLeft = 24;
        form.paddingRight = 24;
        form.paddingTop = 24;
        form.paddingBottom = 24;
        
        // Add title
        const title = figma.createText();
        title.characters = 'Form Title';
        title.fontSize = 20;
        title.setRangeFontName(0, title.characters.length, { family: "Inter", style: "SemiBold" });
        form.appendChild(title);
        
        // Add form description
        if (properties.text || properties.content) {
          const desc = figma.createText();
          desc.characters = properties.text || properties.content || 'Form description';
          form.appendChild(desc);
        }
        
        // Add form fields - name, email, message
        for (const fieldName of ['Name', 'Email', 'Message']) {
          // Create field container
          const fieldContainer = figma.createFrame();
          fieldContainer.name = `${fieldName} Field`;
          fieldContainer.layoutMode = 'VERTICAL';
          fieldContainer.itemSpacing = 8;
          fieldContainer.fills = [];
          
          // Add label
          const label = figma.createText();
          label.characters = fieldName;
          label.fontSize = 14;
          label.setRangeFontName(0, label.characters.length, { family: "Inter", style: "Medium" });
          fieldContainer.appendChild(label);
          
          // Add input
          const input = figma.createFrame();
          input.name = `${fieldName} Input`;
          input.resize(form.width - 48, 40);
          input.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
          input.strokes = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 }, opacity: 1 }];
          input.strokeWeight = 1;
          input.cornerRadius = 4;
          
          // For message field, make it taller
          if (fieldName === 'Message') {
            input.resize(input.width, 120);
          }
          
          fieldContainer.appendChild(input);
          form.appendChild(fieldContainer);
        }
        
        // Add submit button
        const button = figma.createFrame();
        button.name = 'Submit Button';
        button.resize(120, 40);
        button.fills = [{ type: 'SOLID', color: { r: 0.2, g: 0.4, b: 0.9 }, opacity: 1 }];
        button.cornerRadius = 4;
        
        // Add button text
        const buttonText = figma.createText();
        buttonText.characters = 'Submit';
        buttonText.fontSize = 16;
        buttonText.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
        button.appendChild(buttonText);
        
        // Center text in button
        buttonText.x = (button.width - buttonText.width) / 2;
        buttonText.y = (button.height - buttonText.height) / 2;
        
        form.appendChild(button);
        
        // Apply form styling
        form.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }];
        form.cornerRadius = 8;
        form.strokeWeight = 1;
        form.strokes = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
        
        // Apply any specific styles
        if (properties.styles) {
          applyContainerStyles(form, properties.styles);
        }
        
        // Attach to parent
        if (parentFrame) {
          parentFrame.appendChild(form);
        } else {
          parentPage.appendChild(form);
        }
        
        createdNode = form;
        break;
      }
      
    default:
      throw new Error(`Unsupported element type: ${elementType}`);
  }
  
    // Check if we successfully created a node
    if (!createdNode) {
      throw new Error(`Failed to create element of type: ${elementType}`);
    }
    
    // Apply layout positioning if specified
    if (parentFrame && properties.layoutPosition && parentFrame.layoutMode !== 'NONE') {
      switch (properties.layoutPosition) {
        case 'top':
          // Try to place at the top of the parent frame
          createdNode.layoutPositioning = 'ABSOLUTE';
          createdNode.y = parentFrame.paddingTop || 0;
          break;
        case 'bottom':
          // Try to place at the bottom of the parent frame
          createdNode.layoutPositioning = 'ABSOLUTE';
          createdNode.y = parentFrame.height - createdNode.height - (parentFrame.paddingBottom || 0);
          break;
        case 'left':
          // Try to place at the left of the parent frame
          createdNode.layoutPositioning = 'ABSOLUTE';
          createdNode.x = parentFrame.paddingLeft || 0;
          break;
        case 'right':
          // Try to place at the right of the parent frame
          createdNode.layoutPositioning = 'ABSOLUTE';
          createdNode.x = parentFrame.width - createdNode.width - (parentFrame.paddingRight || 0);
          break;
        case 'center':
          // Try to center in the parent frame
          createdNode.layoutPositioning = 'ABSOLUTE';
          createdNode.x = (parentFrame.width - createdNode.width) / 2;
          createdNode.y = (parentFrame.height - createdNode.height) / 2;
          break;
      }
    }
    
    // Send success response with the created node details
  sendResponse({
    type: message.type,
    success: true,
      data: {
        id: createdNode.id,
        type: createdNode.type,
        name: createdNode.name,
        parentId: parentNode.id,
        parentType: parentNode.type,
        activePageId: figma.currentPage.id
      },
      id: message.id
    });
  } catch (error) {
    console.error('Error in handleAddElement:', error);
    sendResponse({
      type: message.type,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    id: message.id
  });
  }
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