#!/usr/bin/env node
/**
 * ae-mcp: MCP server for controlling Adobe After Effects via osascript + ExtendScript
 * Writes script to a temp file, then calls $.evalFile() via DoScript.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);
const AE_APP_NAME = 'Adobe After Effects (Beta)';
const SCRIPT_FILE = '/tmp/ae_mcp_script.jsx';
const RESULT_FILE = '/tmp/ae_mcp_result.json';
const RENDER_FOLDER = '/Users/s25981/Desktop/ae_renders';

// Custom JSON serializer for ExtendScript (no JSON built-in)
const STRINGIFY_FN = `function toJSON(v){var t=typeof v;if(v===null||v===undefined)return"null";if(t==="boolean")return v?"true":"false";if(t==="number")return(isNaN(v)||!isFinite(v))?"null":String(v);if(t==="string"){var s='"';for(var i=0;i<v.length;i++){var c=v.charAt(i);if(c==='"')s+='\\"';else if(c==="\\\\")s+="\\\\\\\\";else if(c==="\\n")s+="\\\\n";else if(c==="\\r")s+="\\\\r";else if(c==="\\t")s+="\\\\t";else s+=c;}return s+'"';}if(v instanceof Array){var a=[];for(var i=0;i<v.length;i++)a.push(toJSON(v[i]));return"["+a.join(",")+"]";}if(t==="object"){var p=[];for(var k in v){if(v.hasOwnProperty(k))p.push(toJSON(String(k))+":"+toJSON(v[k]));}return"{"+p.join(",")+"}";}return"null";}`;

async function runExtendScript(script) {
  try { await fs.unlink(RESULT_FILE); } catch { /* ignore */ }

  const fullScript = `(function(){${STRINGIFY_FN} function writeResult(obj){var f=new File("${RESULT_FILE}");f.encoding="UTF-8";f.open("w");f.write(toJSON(obj));f.close();}try{var __ret=(function(){${script}})();writeResult({success:true,result:__ret});}catch(e){writeResult({success:false,error:e.toString(),line:e.line});}})();`;
  await fs.writeFile(SCRIPT_FILE, fullScript, 'utf8');

  const osaCmd = `osascript -e 'tell application "${AE_APP_NAME}" to DoScript "$.evalFile(\\"${SCRIPT_FILE}\\")"'`;

  try {
    await execAsync(osaCmd, { timeout: 30000 });
  } catch (err) {
    if (err.message.includes('(-1728)') || err.message.includes('not running')) {
      throw new Error(`osascript failed: ${err.message}`);
    }
  }

  await new Promise((r) => setTimeout(r, 500));

  let raw;
  try {
    raw = await fs.readFile(RESULT_FILE, 'utf8');
  } catch {
    throw new Error('After Effects did not write a result. Is AE open with a project?');
  }

  await fs.unlink(RESULT_FILE).catch(() => {});
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// ExtendScript snippets
// ---------------------------------------------------------------------------

// Phase 0 (existing)
const GET_LAYERS_SCRIPT = `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layers=[];for(var i=1;i<=comp.numLayers;i++){var layer=comp.layer(i);var type="Layer";if(layer instanceof TextLayer)type="Text";else if(layer instanceof ShapeLayer)type="Shape";else if(layer instanceof CameraLayer)type="Camera";else if(layer instanceof LightLayer)type="Light";else if(layer instanceof AVLayer)type="AV";layers.push({index:i,name:layer.name,type:type,enabled:layer.enabled,solo:layer.solo,locked:layer.locked,inPoint:layer.inPoint,outPoint:layer.outPoint});}return{compName:comp.name,frameRate:comp.frameRate,duration:comp.duration,width:comp.width,height:comp.height,layers:layers};`;

// Phase 1: project info
const LIST_COMPOSITIONS_SCRIPT = `var comps=[];for(var i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(item instanceof CompItem){comps.push({index:i,name:item.name,width:item.width,height:item.height,frameRate:item.frameRate,duration:item.duration,numLayers:item.numLayers});}}return{compositions:comps};`;

const GET_PROJECT_ITEMS_SCRIPT = `var items=[];for(var i=1;i<=app.project.numItems;i++){var item=app.project.item(i);var type="Unknown";if(item instanceof CompItem)type="Comp";else if(item instanceof FolderItem)type="Folder";else if(item instanceof FootageItem)type="Footage";items.push({index:i,name:item.name,type:type,missing:(item instanceof FootageItem)?item.footageMissing:false});}return{items:items};`;

function buildCreateCompositionScript(name, width, height, frameRate, duration) {
  return `var comp=app.project.items.addComp(${JSON.stringify(name)},${width},${height},1,${duration},${frameRate});app.project.activeItem=comp;return{compName:comp.name,width:comp.width,height:comp.height,frameRate:comp.frameRate,duration:comp.duration};`;
}

function buildSetLayerPropertyScript(layerName, enabled, solo, locked, newName) {
  const parts = [];
  if (enabled !== undefined) parts.push(`layer.enabled=${enabled};`);
  if (solo !== undefined) parts.push(`layer.solo=${solo};`);
  if (locked !== undefined) parts.push(`layer.locked=${locked};`);
  if (newName !== undefined) parts.push(`layer.name=${JSON.stringify(newName)};`);
  const changes = parts.join('');
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layer=null;for(var i=1;i<=comp.numLayers;i++){if(comp.layer(i).name===${JSON.stringify(layerName)}){layer=comp.layer(i);break;}}if(!layer){return{error:"Layer not found: "+${JSON.stringify(layerName)}};}app.beginUndoGroup("MCP: Set Layer Property");${changes}app.endUndoGroup();return{success:true,layer:layer.name,enabled:layer.enabled,solo:layer.solo,locked:layer.locked};`;
}

function easingExtendScript(easing, kfIndexVar) {
  const KI = 'KeyframeInterpolationType';
  const lookup = {
    linear:   `prop.setInterpolationTypeAtKey(${kfIndexVar},${KI}.LINEAR,${KI}.LINEAR);`,
    ease:     `prop.setInterpolationTypeAtKey(${kfIndexVar},${KI}.BEZIER,${KI}.BEZIER);`,
    ease_in:  `prop.setInterpolationTypeAtKey(${kfIndexVar},${KI}.BEZIER,${KI}.LINEAR);`,
    ease_out: `prop.setInterpolationTypeAtKey(${kfIndexVar},${KI}.LINEAR,${KI}.BEZIER);`,
    hold:     `prop.setInterpolationTypeAtKey(${kfIndexVar},${KI}.HOLD,${KI}.HOLD);`,
  };
  return lookup[easing] || '';
}

function buildAddKeyframeScript(layerName, property, time, value, easing) {
  const valueExpr = Array.isArray(value) && value.length > 1
    ? `[${value.join(', ')}]`
    : String(Array.isArray(value) ? value[0] : value);
  const easingCode = easing
    ? `var kfIdx=prop.nearestKeyIndex(${time});${easingExtendScript(easing, 'kfIdx')}`
    : '';
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layer=null;for(var i=1;i<=comp.numLayers;i++){if(comp.layer(i).name===${JSON.stringify(layerName)}){layer=comp.layer(i);break;}}if(!layer){return{error:"Layer not found: "+${JSON.stringify(layerName)}};}var propMap={"Position":layer.transform.position,"Scale":layer.transform.scale,"Rotation":layer.transform.rotation,"Opacity":layer.transform.opacity,"Anchor Point":layer.transform.anchorPoint};var prop=propMap[${JSON.stringify(property)}];if(!prop){return{error:"Unsupported property: "+${JSON.stringify(property)}};}app.beginUndoGroup("MCP: Add Keyframe");prop.setValueAtTime(${time},${valueExpr});${easingCode}app.endUndoGroup();return{success:true,layer:${JSON.stringify(layerName)},property:${JSON.stringify(property)},time:${time},value:${JSON.stringify(value)},easing:${JSON.stringify(easing||null)}};`;
}

function buildSetKeyframeInterpolationScript(layerName, property, time, easing) {
  const easingCode = easingExtendScript(easing, 'kfIdx');
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layer=null;for(var i=1;i<=comp.numLayers;i++){if(comp.layer(i).name===${JSON.stringify(layerName)}){layer=comp.layer(i);break;}}if(!layer){return{error:"Layer not found: "+${JSON.stringify(layerName)}};}var propMap={"Position":layer.transform.position,"Scale":layer.transform.scale,"Rotation":layer.transform.rotation,"Opacity":layer.transform.opacity,"Anchor Point":layer.transform.anchorPoint};var prop=propMap[${JSON.stringify(property)}];if(!prop){return{error:"Unsupported property: "+${JSON.stringify(property)}};}var kfIdx=prop.nearestKeyIndex(${time});app.beginUndoGroup("MCP: Set Keyframe Interpolation");${easingCode}app.endUndoGroup();return{success:true,layer:${JSON.stringify(layerName)},property:${JSON.stringify(property)},time:${time},easing:${JSON.stringify(easing)}};`;
}

function buildRelinkMissingFootageScript(searchFolder) {
  return `var searchFolder=${JSON.stringify(searchFolder)};function findFile(folderPath,targetName){var f=new Folder(folderPath);var files=f.getFiles();for(var i=0;i<files.length;i++){if(files[i] instanceof File&&files[i].name===targetName)return files[i];if(files[i] instanceof Folder){var found=findFile(files[i].fsName,targetName);if(found)return found;}}return null;}var relinked=[];var failed=[];for(var i=1;i<=app.project.numItems;i++){var item=app.project.item(i);if(item instanceof FootageItem&&item.footageMissing){var found=findFile(searchFolder,item.name);if(found){item.replace(found);relinked.push(item.name);}else{failed.push(item.name);}}}return{relinked:relinked,failed:failed};`;
}

function buildRenderCompositionScript(compName, outputName, format) {
  const fileName = (outputName || compName) + (format === 'png_sequence' ? '_[####].png' : format === 'avi' ? '.avi' : '.mp4');
  const outputPath = RENDER_FOLDER + '/' + fileName;
  return `var comp=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i) instanceof CompItem&&app.project.item(i).name===${JSON.stringify(compName)}){comp=app.project.item(i);break;}}if(!comp){return{error:"Composition not found: "+${JSON.stringify(compName)}};}var rqItem=app.project.renderQueue.items.add(comp);var outputModule=rqItem.outputModules[1];outputModule.file=new File(${JSON.stringify(outputPath)});app.project.renderQueue.render();return{status:"render_started",outputPath:${JSON.stringify(outputPath)}};`;
}

// set_composition_settings
function buildSetCompositionSettingsScript(compName, width, height, frameRate, duration) {
  const changes = [];
  if (width !== undefined) changes.push(`comp.width=${width};`);
  if (height !== undefined) changes.push(`comp.height=${height};`);
  if (frameRate !== undefined) changes.push(`comp.frameRate=${frameRate};`);
  if (duration !== undefined) changes.push(`comp.duration=${duration};`);
  const changeCode = changes.join('');
  return `var comp=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i) instanceof CompItem&&app.project.item(i).name===${JSON.stringify(compName)}){comp=app.project.item(i);break;}}if(!comp){return{error:"Composition not found: "+${JSON.stringify(compName)}};}app.beginUndoGroup("MCP: Set Composition Settings");${changeCode}app.endUndoGroup();return{compName:comp.name,width:comp.width,height:comp.height,frameRate:comp.frameRate,duration:comp.duration};`;
}

// Phase 2: layer creation
function buildCreateTextLayerScript(text, fontSize, color, position) {
  const colorExpr = color ? `[${color.join(',')}]` : 'null';
  const posExpr = position ? `[${position.join(',')}]` : 'null';
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}app.beginUndoGroup("MCP: Create Text Layer");var textLayer=comp.layers.addText(${JSON.stringify(text)});var textProp=textLayer.property("Source Text");var textDoc=textProp.value;textDoc.fontSize=${fontSize || 36};var fillColor=${colorExpr};if(fillColor)textDoc.fillColor=fillColor;textProp.setValue(textDoc);var pos=${posExpr};if(pos)textLayer.transform.position.setValue(pos);app.endUndoGroup();return{success:true,layerName:textLayer.name,index:textLayer.index};`;
}

function buildCreateShapeLayerScript(shape, name, width, height, position, fillColor) {
  const w = width || 100;
  const h = height || 100;
  const fillExpr = fillColor ? `[${fillColor.join(',')}]` : '[1,1,1]';
  const posExpr = position ? `[${position.join(',')}]` : 'null';
  const nameCode = name ? `shapeLayer.name=${JSON.stringify(name)};` : '';
  const shapeCode = shape === 'ellipse'
    ? `var sh=grpContents.addProperty("ADBE Vector Shape - Ellipse");sh.property("Size").setValue([${w},${h}]);`
    : `var sh=grpContents.addProperty("ADBE Vector Shape - Rect");sh.property("Size").setValue([${w},${h}]);`;
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}app.beginUndoGroup("MCP: Create Shape Layer");var shapeLayer=comp.layers.addShape();${nameCode}var contents=shapeLayer.property("Contents");var grp=contents.addProperty("ADBE Vector Group");var grpContents=grp.property("Contents");${shapeCode}var fill=grpContents.addProperty("ADBE Vector Graphic - Fill");fill.property("Color").setValue(${fillExpr});var pos=${posExpr};if(pos)shapeLayer.transform.position.setValue(pos);app.endUndoGroup();return{success:true,layerName:shapeLayer.name,index:shapeLayer.index};`;
}

function buildCreateSolidLayerScript(name, width, height, color, isAdjustment) {
  const colorExpr = color ? `[${color.join(',')}]` : '[0,0,0]';
  const widthExpr = width ? String(width) : 'comp.width';
  const heightExpr = height ? String(height) : 'comp.height';
  const adjCode = isAdjustment ? 'solid.adjustmentLayer=true;' : '';
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}app.beginUndoGroup("MCP: Create Solid");var solid=comp.layers.addSolid(${colorExpr},${JSON.stringify(name)},${widthExpr},${heightExpr},comp.pixelAspect);${adjCode}app.endUndoGroup();return{success:true,layerName:solid.name,index:solid.index};`;
}

function buildAddLayerFromFootageScript(itemName, position, time) {
  const posExpr = position ? `[${position.join(',')}]` : 'null';
  const timeCode = (time !== undefined && time !== null) ? `layer.startTime=${time};` : '';
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var footage=null;for(var i=1;i<=app.project.numItems;i++){if(app.project.item(i).name===${JSON.stringify(itemName)}){footage=app.project.item(i);break;}}if(!footage){return{error:"Item not found: "+${JSON.stringify(itemName)}};}app.beginUndoGroup("MCP: Add Layer from Footage");var layer=comp.layers.add(footage);${timeCode}var pos=${posExpr};if(pos)layer.transform.position.setValue(pos);app.endUndoGroup();return{success:true,layerName:layer.name,index:layer.index};`;
}

// Phase 3: import
function buildImportFootageScript(filePath, importAsComp, targetFolder) {
  const importTypeCode = importAsComp
    ? 'importOptions.importAs=ImportAsType.COMP;'
    : 'importOptions.importAs=ImportAsType.FOOTAGE;';
  const folderCode = targetFolder
    ? `var tf=${JSON.stringify(targetFolder)};for(var i=1;i<=app.project.numItems;i++){var f=app.project.item(i);if(f instanceof FolderItem&&f.name===tf){item.parentFolder=f;break;}}`
    : '';
  return `var importOptions=new ImportOptions(new File(${JSON.stringify(filePath)}));${importTypeCode}app.beginUndoGroup("MCP: Import Footage");var item=app.project.importFile(importOptions);${folderCode}app.endUndoGroup();return{success:true,itemName:item.name,itemIndex:item.id,type:(item instanceof CompItem)?"Comp":"Footage"};`;
}

// Phase 4: effects and expressions
function buildApplyEffectScript(layerName, effectName, properties) {
  let propCode = '';
  if (properties) {
    for (const [k, v] of Object.entries(properties)) {
      propCode += `try{effect.property(${JSON.stringify(k)}).setValue(${JSON.stringify(v)});}catch(pe){}`;
    }
  }
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layer=null;for(var i=1;i<=comp.numLayers;i++){if(comp.layer(i).name===${JSON.stringify(layerName)}){layer=comp.layer(i);break;}}if(!layer){return{error:"Layer not found: "+${JSON.stringify(layerName)}};}app.beginUndoGroup("MCP: Apply Effect");var effect=layer.property("Effects").addProperty(${JSON.stringify(effectName)});if(!effect){app.endUndoGroup();return{error:"Effect not found: "+${JSON.stringify(effectName)}};}${propCode}app.endUndoGroup();return{success:true,effectName:effect.name};`;
}

function buildSetExpressionScript(layerName, property, expression) {
  return `var comp=app.project.activeItem;if(!comp||!(comp instanceof CompItem)){return{error:"No active composition."};}var layer=null;for(var i=1;i<=comp.numLayers;i++){if(comp.layer(i).name===${JSON.stringify(layerName)}){layer=comp.layer(i);break;}}if(!layer){return{error:"Layer not found: "+${JSON.stringify(layerName)}};}var propMap={"Position":layer.transform.position,"Scale":layer.transform.scale,"Rotation":layer.transform.rotation,"Opacity":layer.transform.opacity};var prop=propMap[${JSON.stringify(property)}];if(!prop){return{error:"Unsupported property: "+${JSON.stringify(property)}};}prop.expression=${JSON.stringify(expression)};return{success:true,expression:prop.expression};`;
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'ae-mcp', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // --- existing ---
    {
      name: 'get_layers',
      description: 'Get all layers in the currently active After Effects composition.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'create_composition',
      description: 'Create a new composition in the After Effects project.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          frame_rate: { type: 'number' },
          duration: { type: 'number' },
        },
        required: ['name', 'width', 'height', 'frame_rate', 'duration'],
      },
    },
    {
      name: 'set_layer_property',
      description: 'Change visibility, solo, lock, or name of a layer.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_name: { type: 'string' },
          enabled: { type: 'boolean' },
          solo: { type: 'boolean' },
          locked: { type: 'boolean' },
          new_name: { type: 'string' },
        },
        required: ['layer_name'],
      },
    },
    {
      name: 'add_keyframe',
      description: 'Add a transform keyframe to a named layer.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_name: { type: 'string' },
          property: { type: 'string', enum: ['Position', 'Scale', 'Rotation', 'Opacity', 'Anchor Point'] },
          time: { type: 'number' },
          value: { type: 'array', items: { type: 'number' } },
          easing: { type: 'string', enum: ['linear', 'ease', 'ease_in', 'ease_out', 'hold'] },
        },
        required: ['layer_name', 'property', 'time', 'value'],
      },
    },
    {
      name: 'set_keyframe_interpolation',
      description: 'Change the interpolation type of an existing keyframe.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_name: { type: 'string' },
          property: { type: 'string', enum: ['Position', 'Scale', 'Rotation', 'Opacity', 'Anchor Point'] },
          time: { type: 'number' },
          easing: { type: 'string', enum: ['linear', 'ease', 'ease_in', 'ease_out', 'hold'] },
        },
        required: ['layer_name', 'property', 'time', 'easing'],
      },
    },
    {
      name: 'relink_missing_footage',
      description: 'Recursively search a folder and relink missing footage.',
      inputSchema: {
        type: 'object',
        properties: { search_folder: { type: 'string' } },
        required: ['search_folder'],
      },
    },
    {
      name: 'render_composition',
      description: 'Render a composition to /Users/s25981/Desktop/ae_renders/.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string' },
          output_name: { type: 'string' },
          format: { type: 'string', enum: ['h264', 'png_sequence', 'avi'] },
        },
        required: ['comp_name'],
      },
    },
    {
      name: 'set_composition_settings',
      description: 'Change settings (size, frame rate, duration) of an existing composition.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_name: { type: 'string', description: 'Name of the composition to modify' },
          width: { type: 'number', description: 'New width in pixels' },
          height: { type: 'number', description: 'New height in pixels' },
          frame_rate: { type: 'number', description: 'New frame rate' },
          duration: { type: 'number', description: 'New duration in seconds' },
        },
        required: ['comp_name'],
      },
    },
    // --- Phase 1: project info ---
    {
      name: 'list_compositions',
      description: 'List all compositions in the After Effects project.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_project_items',
      description: 'List all items (comps, footage, folders) in the project panel.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    // --- Phase 2: layer creation ---
    {
      name: 'create_text_layer',
      description: 'Create a new text layer in the active composition.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text content' },
          font_size: { type: 'number', description: 'Font size (default: 36)' },
          color: { type: 'array', items: { type: 'number' }, description: 'RGB 0-1 e.g. [1,0,0] for red' },
          position: { type: 'array', items: { type: 'number' }, description: '[x, y] in pixels' },
        },
        required: ['text'],
      },
    },
    {
      name: 'create_shape_layer',
      description: 'Create a new shape layer (rectangle or ellipse) in the active composition.',
      inputSchema: {
        type: 'object',
        properties: {
          shape: { type: 'string', enum: ['rectangle', 'ellipse'] },
          name: { type: 'string' },
          width: { type: 'number', description: 'Shape width in pixels (default: 100)' },
          height: { type: 'number', description: 'Shape height in pixels (default: 100)' },
          position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
          fill_color: { type: 'array', items: { type: 'number' }, description: 'RGB 0-1' },
        },
        required: ['shape'],
      },
    },
    {
      name: 'create_solid_layer',
      description: 'Create a solid or adjustment layer in the active composition.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          color: { type: 'array', items: { type: 'number' }, description: 'RGB 0-1 (default: [0,0,0])' },
          is_adjustment: { type: 'boolean', description: 'Make it an adjustment layer (default: false)' },
        },
        required: ['name'],
      },
    },
    {
      name: 'add_layer_from_footage',
      description: 'Add a project item to the active composition timeline.',
      inputSchema: {
        type: 'object',
        properties: {
          item_name: { type: 'string', description: 'Project item name (case-sensitive)' },
          position: { type: 'array', items: { type: 'number' }, description: '[x, y]' },
          time: { type: 'number', description: 'Placement time in seconds (default: 0)' },
        },
        required: ['item_name'],
      },
    },
    // --- Phase 3: import ---
    {
      name: 'import_footage',
      description: 'Import an external file (.ai, .png, .psd, .mp4, etc.) into the project.',
      inputSchema: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file' },
          import_as_comp: { type: 'boolean', description: 'Import .ai/.psd as a composition (default: false)' },
          target_folder: { type: 'string', description: 'Project panel folder name to move the item into' },
        },
        required: ['file_path'],
      },
    },
    // --- Phase 4: effects ---
    {
      name: 'apply_effect',
      description: 'Apply an effect to a layer in the active composition.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_name: { type: 'string' },
          effect_name: { type: 'string', description: 'Effect name e.g. "Gaussian Blur", "Drop Shadow"' },
          properties: { type: 'object', description: 'Property name → value pairs to set after applying' },
        },
        required: ['layer_name', 'effect_name'],
      },
    },
    {
      name: 'set_expression',
      description: 'Set an expression on a transform property of a layer.',
      inputSchema: {
        type: 'object',
        properties: {
          layer_name: { type: 'string' },
          property: { type: 'string', enum: ['Position', 'Scale', 'Rotation', 'Opacity'] },
          expression: { type: 'string', description: 'Expression string' },
        },
        required: ['layer_name', 'property', 'expression'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  function okResult(res) {
    if (!res.success) return { content: [{ type: 'text', text: `AE error: ${res.error}` }], isError: true };
    if (res.result && res.result.error) return { content: [{ type: 'text', text: res.result.error }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(res.result, null, 2) }] };
  }

  try {
    // existing tools
    if (name === 'get_layers') return okResult(await runExtendScript(GET_LAYERS_SCRIPT));
    if (name === 'create_composition') {
      const { name: compName, width, height, frame_rate, duration } = args;
      return okResult(await runExtendScript(buildCreateCompositionScript(compName, width, height, frame_rate, duration)));
    }
    if (name === 'set_layer_property') {
      const { layer_name, enabled, solo, locked, new_name } = args;
      return okResult(await runExtendScript(buildSetLayerPropertyScript(layer_name, enabled, solo, locked, new_name)));
    }
    if (name === 'add_keyframe') {
      const { layer_name, property, time, value, easing } = args;
      return okResult(await runExtendScript(buildAddKeyframeScript(layer_name, property, time, value, easing)));
    }
    if (name === 'set_keyframe_interpolation') {
      const { layer_name, property, time, easing } = args;
      return okResult(await runExtendScript(buildSetKeyframeInterpolationScript(layer_name, property, time, easing)));
    }
    if (name === 'relink_missing_footage') {
      const { search_folder } = args;
      return okResult(await runExtendScript(buildRelinkMissingFootageScript(search_folder)));
    }
    if (name === 'render_composition') {
      const { comp_name, output_name, format = 'h264' } = args;
      await fs.mkdir(RENDER_FOLDER, { recursive: true });
      return okResult(await runExtendScript(buildRenderCompositionScript(comp_name, output_name, format)));
    }

    if (name === 'set_composition_settings') {
      const { comp_name, width, height, frame_rate, duration } = args;
      return okResult(await runExtendScript(buildSetCompositionSettingsScript(comp_name, width, height, frame_rate, duration)));
    }

    // Phase 1
    if (name === 'list_compositions') return okResult(await runExtendScript(LIST_COMPOSITIONS_SCRIPT));
    if (name === 'get_project_items') return okResult(await runExtendScript(GET_PROJECT_ITEMS_SCRIPT));

    // Phase 2
    if (name === 'create_text_layer') {
      const { text, font_size, color, position } = args;
      return okResult(await runExtendScript(buildCreateTextLayerScript(text, font_size, color, position)));
    }
    if (name === 'create_shape_layer') {
      const { shape, name: layerName, width, height, position, fill_color } = args;
      return okResult(await runExtendScript(buildCreateShapeLayerScript(shape, layerName, width, height, position, fill_color)));
    }
    if (name === 'create_solid_layer') {
      const { name: solidName, width, height, color, is_adjustment } = args;
      return okResult(await runExtendScript(buildCreateSolidLayerScript(solidName, width, height, color, is_adjustment)));
    }
    if (name === 'add_layer_from_footage') {
      const { item_name, position, time } = args;
      return okResult(await runExtendScript(buildAddLayerFromFootageScript(item_name, position, time)));
    }

    // Phase 3
    if (name === 'import_footage') {
      const { file_path, import_as_comp = false, target_folder } = args;
      try { await fs.access(file_path); } catch {
        return { content: [{ type: 'text', text: `File not found: ${file_path}` }], isError: true };
      }
      return okResult(await runExtendScript(buildImportFootageScript(file_path, import_as_comp, target_folder)));
    }

    // Phase 4
    if (name === 'apply_effect') {
      const { layer_name, effect_name, properties } = args;
      return okResult(await runExtendScript(buildApplyEffectScript(layer_name, effect_name, properties)));
    }
    if (name === 'set_expression') {
      const { layer_name, property, expression } = args;
      return okResult(await runExtendScript(buildSetExpressionScript(layer_name, property, expression)));
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Server error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[ae-mcp] Server running on stdio');
