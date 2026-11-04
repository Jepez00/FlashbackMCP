#!/usr/bin/env node
/*
Flashback MCP
Copyright (c) 2026 Jepez. All Rights Reserved.

This software, its source code and its documentation (the "Software") are the
exclusive property of the copyright holder.

You may download the Software from its official distribution channels and use
it for personal purposes. No other right is granted: without prior written
permission from the copyright holder you may not copy, modify, merge, publish,
redistribute, sublicense, sell or create derivative works of the Software, in
whole or in part.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHOR OR COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// MCP server for local AI clients and the Flashback MCP mod. No dependencies: it speaks
// newline-delimited JSON-RPC on stdin/stdout and forwards tool calls to the mod over
// a token-protected HTTP endpoint.
//
// Same machine as the game: nothing to configure, the mod publishes its port and token
// in ~/.flashback-mcp/bridge.json when the in-game MCP switch is enabled.
// Any compatible MCP client starts this process using stdio.

import { readFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_VERSION = '1.0.0';
// Only advertise revisions implemented by this tools-only, initialize-based server.
// Newer clients can negotiate a supported revision instead of receiving a false echo.
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const LATEST_PROTOCOL_VERSION = PROTOCOL_VERSIONS.at(-1);
const BRIDGE_FILE = process.env.FLASHBACK_MCP_BRIDGE_FILE || path.join(os.homedir(), '.flashback-mcp', 'bridge.json');
// Exports with wait=true and replay loading can legitimately take minutes
const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;

// Tool descriptions exposed to every MCP client.
const { instructions, tools } = {"instructions":"Controls the Flashback replay mod inside a running Minecraft client through a companion bridge mod.\n\nBasics: time is in ticks (20 ticks = 1 second). Positions are block coordinates. The game must be running with the bridge mod; if a tool says the bridge is unreachable, ask the user to start Minecraft.\n\nTypical workflow: flashback_status -> flashback_list_replays / flashback_open_replay -> scout with flashback_seek, flashback_list_entities, flashback_set_camera and flashback_screenshot (it returns the rendered frame, so look at it) -> write the camera path with flashback_set_keyframes -> check a few ticks along the path with flashback_screenshot -> flashback_export_video and poll flashback_status until it finishes.\n\nTimeline edits are saved automatically by Flashback and can be reverted with flashback_history (or Ctrl+Z in the editor).","tools":[{"name":"flashback_status","description":"Current state of Minecraft and the Flashback replay editor: state (menu / in_world / replay / exporting), open replay (tick, total_ticks, paused, speed), camera (position, yaw, pitch, roll, fov, dimension), recording state, and export progress. Call this first, and poll it while an export is running.","inputSchema":{"type":"object","properties":{}}},{"name":"flashback_list_replays","description":"List the replay files in the Flashback replay folder with name, length in ticks/seconds, size and date (newest first).","inputSchema":{"type":"object","properties":{}}},{"name":"flashback_open_replay","description":"Open a replay in the Flashback editor. Blocks until it is loaded (can take a while) and returns the status. Any replay already open is closed first, with its timeline saved automatically. If the game is in a world or on a server, it leaves it.","inputSchema":{"type":"object","properties":{"name":{"type":"string","description":"File name (with or without .zip) or replay display name from flashback_list_replays."},"path":{"type":"string","description":"Alternative to name: absolute path of a replay .zip."}}}},{"name":"flashback_close_replay","description":"Exit the open replay and return to the title screen. The timeline is saved automatically.","inputSchema":{"type":"object","properties":{}}},{"name":"flashback_playback","description":"Play or pause the replay and/or set the playback speed. Returns the playback state. With no arguments it just reports it.","inputSchema":{"type":"object","properties":{"paused":{"type":"boolean","description":"true to pause, false to play."},"speed":{"type":"number","description":"Manual playback speed multiplier, 1 = real time (0.01 to 100). Speed keyframes override it while they apply."}}}},{"name":"flashback_seek","description":"Jump the replay to a tick and wait until the world has caught up. By default keyframes are applied, so the camera moves to where the camera track puts it at that tick. Returns the tick and resulting camera.","inputSchema":{"type":"object","properties":{"tick":{"type":"integer","description":"Replay tick (20 ticks = 1 second)."},"seconds":{"type":"number","description":"Alternative to tick: time in seconds from the start of the replay."},"apply_keyframes":{"type":"boolean","description":"Apply timeline keyframes (camera, fov, time of day) at the new tick. Default true; pass false to keep the free camera where it is."}}}},{"name":"flashback_set_camera","description":"Move the free (spectator) camera. Omitted values keep their current value. Coordinates are the camera entity position (the view point is 1.62 blocks above y; see eye_y in the result). Yaw: 0 = south (+Z), 90 = west (-X), 180 = north (-Z), -90 = east (+X). Pitch: -90 = straight up, 0 = horizon, 90 = straight down. Returns the resulting camera.","inputSchema":{"type":"object","properties":{"x":{"type":"number"},"y":{"type":"number"},"z":{"type":"number"},"yaw":{"type":"number"},"pitch":{"type":"number"},"look_at":{"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3,"description":"Point [x, y, z] to aim at; computes yaw and pitch for you (overrides yaw/pitch)."},"roll":{"type":"number","description":"Camera roll in degrees (0 = level)."},"fov":{"type":"number","description":"Field of view in degrees (1 to 170). Enables the FOV override in the Visuals settings."}}}},{"name":"flashback_list_entities","description":"List entities currently loaded near the camera at the current replay tick, nearest first, with position and rotation. Use it to find players or mobs to frame or follow.","inputSchema":{"type":"object","properties":{"players_only":{"type":"boolean","description":"Only players (default true). Pass false for every entity type."},"radius":{"type":"number","description":"Maximum distance from the camera in blocks (default 96)."},"limit":{"type":"integer","description":"Maximum entities returned (default 60)."}}}},{"name":"flashback_get_timeline","description":"Read the editor timeline of the current scene: scenes, export range, markers, and every track with its keyframes in the same JSON shape that flashback_set_keyframes accepts.","inputSchema":{"type":"object","properties":{"include_keyframes":{"type":"boolean","description":"Include keyframe data (default true). Pass false for just the track list."},"track":{"type":"integer","description":"Only this track index."},"from_tick":{"type":"integer","description":"Only keyframes at or after this tick."},"to_tick":{"type":"integer","description":"Only keyframes at or before this tick."}}}},{"name":"flashback_add_track","description":"Add a keyframe track to the current scene. Returns its index. (flashback_set_keyframes with track_type creates a missing track by itself.)","inputSchema":{"type":"object","properties":{"type":{"type":"string","description":"CAMERA, FOV, SPEED, TIMELAPSE, TIME_OF_DAY, FREEZE, CAMERA_SHAKE, CAMERA_ORBIT or TRACK_ENTITY."},"name":{"type":"string","description":"Optional custom track name shown in the editor."}},"required":["type"]}},{"name":"flashback_remove_track","description":"Delete a track and all its keyframes (undoable). Indices of later tracks shift down by one.","inputSchema":{"type":"object","properties":{"track":{"type":"integer","description":"Track index from flashback_get_timeline."}},"required":["track"]}},{"name":"flashback_update_track","description":"Enable/disable a track or rename it. A disabled track is ignored during playback and export.","inputSchema":{"type":"object","properties":{"track":{"type":"integer","description":"Track index from flashback_get_timeline."},"enabled":{"type":"boolean"},"name":{"type":["string","null"],"description":"Custom name; null or empty restores the default name."}},"required":["track"]}},{"name":"flashback_set_keyframes","description":"Create or replace keyframes on one track, as a single undoable edit. A keyframe at an existing tick is replaced. Each keyframe needs \"tick\" (or \"seconds\") plus the fields for the track type:\n- CAMERA: {\"tick\":0,\"position\":[x,y,z],\"yaw\":0,\"pitch\":0,\"roll\":0} — or \"look_at\":[x,y,z] instead of yaw/pitch. Same conventions as flashback_set_camera.\n- FOV: {\"tick\":0,\"fov\":70}\n- SPEED: {\"tick\":0,\"speed\":0.5} (1 = real time)\n- TIME_OF_DAY: {\"tick\":0,\"time\":6000} (0-24000; 6000 = noon, 18000 = midnight)\n- FREEZE: {\"tick\":0,\"freeze\":true,\"freezeDelay\":0}\n- CAMERA_SHAKE: {\"tick\":0,\"frequencyX\":1,\"amplitudeX\":1,\"frequencyY\":1,\"amplitudeY\":1}\n- CAMERA_ORBIT: {\"tick\":0,\"center\":[x,y,z],\"distance\":10,\"yaw\":0,\"pitch\":20}\n- TIMELAPSE: {\"tick\":0,\"ticks\":0} — \"ticks\" is the output time at which this replay tick is reached; between two keyframes the replay is sped up to fit.\n- TRACK_ENTITY: copy the shape of an existing keyframe from flashback_get_timeline.\nOptional \"interpolation\" on any keyframe sets how the value moves towards the next keyframe: SMOOTH (spline, default), LINEAR, EASE_IN, EASE_OUT, EASE_IN_OUT, HOLD, HERMITE.\nA camera path needs at least two CAMERA keyframes; the camera is only driven between the first and last one. Preview with flashback_seek + flashback_screenshot.","inputSchema":{"type":"object","properties":{"track":{"type":"integer","description":"Track index from flashback_get_timeline."},"track_type":{"type":"string","description":"Alternative to track: CAMERA, FOV, SPEED, TIMELAPSE, TIME_OF_DAY, FREEZE, CAMERA_SHAKE, CAMERA_ORBIT, TRACK_ENTITY. Uses the first track of that type."},"keyframes":{"type":"array","items":{"type":"object"},"minItems":1,"description":"Keyframe objects as described above."},"clear_existing":{"type":"boolean","description":"Remove every keyframe already on the track first (default false)."}},"required":["keyframes"]}},{"name":"flashback_remove_keyframes","description":"Remove keyframes from one track (undoable). Select them with ticks, a from_tick/to_tick range, or all=true.","inputSchema":{"type":"object","properties":{"track":{"type":"integer","description":"Track index from flashback_get_timeline."},"track_type":{"type":"string","description":"Alternative to track: CAMERA, FOV, SPEED, TIMELAPSE, TIME_OF_DAY, FREEZE, CAMERA_SHAKE, CAMERA_ORBIT, TRACK_ENTITY. Uses the first track of that type."},"ticks":{"type":"array","items":{"type":"integer"},"description":"Exact ticks of the keyframes to remove."},"from_tick":{"type":"integer"},"to_tick":{"type":"integer"},"all":{"type":"boolean","description":"Remove every keyframe on the track."}}}},{"name":"flashback_history","description":"Undo or redo the last timeline edit of the current scene (the editor's own Ctrl+Z / Ctrl+Y history, shared with edits made by hand).","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["undo","redo"]}},"required":["action"]}},{"name":"flashback_scene","description":"Manage editor scenes (each scene has its own tracks and export range): select one, add a new one, or rename one. Returns the scene list.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["select","add","rename"]},"index":{"type":"integer","description":"Scene index (select, rename)."},"name":{"type":"string","description":"Scene name (add, rename)."},"select":{"type":"boolean","description":"For add: switch to the new scene (default true)."}},"required":["action"]}},{"name":"flashback_set_export_range","description":"Set the tick range the current scene exports (the in/out points on the timeline). Without a range, exports cover the span between the first and last keyframe, or the whole replay.","inputSchema":{"type":"object","properties":{"start_tick":{"type":"integer"},"end_tick":{"type":"integer"},"clear":{"type":"boolean","description":"Remove the custom range."}}}},{"name":"flashback_get_visuals","description":"Read the Visuals settings of the open replay: HUD elements (showChat, showHotbar, ...), what is rendered (renderBlocks, renderEntities, renderPlayers, renderParticles, renderSky, renderNametags), overrides (fog, fov, roll, time of day, weather, night vision), camera shake, and framing guides / aspect ratio.","inputSchema":{"type":"object","properties":{}}},{"name":"flashback_set_visuals","description":"Change Visuals settings. Pass only the settings to change, using the names and value types returned by flashback_get_visuals, e.g. {\"values\":{\"showHotbar\":false,\"renderNametags\":false,\"overrideTimeOfDay\":6000}}. overrideTimeOfDay -1 = off. overrideWeatherMode: NONE, CLEAR, OVERCAST, RAINING, SNOWING, THUNDERING. Returns all settings.","inputSchema":{"type":"object","properties":{"values":{"type":"object","description":"Setting name -> new value."}},"required":["values"]}},{"name":"flashback_screenshot","description":"Render one frame of the replay from the current camera to a PNG and return it as an image, so you can see the shot. Optionally seek to a tick first (keyframes are applied, so this previews the camera path at that moment). Takes a couple of seconds. Not available in fullscreen.","inputSchema":{"type":"object","properties":{"tick":{"type":"integer","description":"Replay tick (20 ticks = 1 second)."},"seconds":{"type":"number","description":"Alternative to tick: time in seconds from the start of the replay."},"width":{"type":"integer","description":"Default 960."},"height":{"type":"integer","description":"Default 540."},"output":{"type":"string","description":"Absolute path of the PNG to write. Default: <game dir>/flashback/mcp_screenshots/shot_<timestamp>.png"},"no_gui":{"type":"boolean","description":"Hide the in-game HUD. Default: the value last used in the export window."},"ssaa":{"type":"boolean","description":"Supersample for smoother edges (slower). Default false."},"apply_keyframes":{"type":"boolean","description":"When seeking: apply timeline keyframes at that tick (default true)."}}}},{"name":"flashback_export_video","description":"Export the current scene to a video file, driven by the timeline keyframes. Unspecified options use the values last used in Flashback's export window. The range defaults to the scene export range, else the keyframed span, else the whole replay. Minecraft cannot do anything else while exporting: by default this returns as soon as the export has started, then poll flashback_status until state is no longer 'exporting' and check last_export. Not available in fullscreen.","inputSchema":{"type":"object","properties":{"output":{"type":"string","description":"Absolute output file path (the extension picks the container: mp4, mkv, mov, avi, webm, webp, gif), or a folder for image sequences. Default: Flashback's export folder with its default file name."},"overwrite":{"type":"boolean","description":"Allow replacing an existing output file (default false)."},"width":{"type":"integer"},"height":{"type":"integer"},"framerate":{"type":"number"},"start_tick":{"type":"integer"},"end_tick":{"type":"integer"},"container":{"type":"string","description":"MP4, MKV, MOV, AVI, WEBM, WEBP, GIF or PNG_SEQUENCE; also EXR_SEQUENCE on Minecraft 26.1+. An invalid value returns the valid options."},"codec":{"type":"string","description":"H264, H265, AV1, VP9, PRO_RES, QUICK_TIME, ... (must be supported by the container)."},"encoder":{"type":"string","description":"Specific FFmpeg encoder for the codec, e.g. h264_nvenc or libx264. An invalid value returns the valid options."},"bitrate":{"type":["string","number"],"description":"Bits per second, or shorthand like \"20m\". 0 = encoder maximum. Default 20m."},"record_audio":{"type":"boolean"},"stereo_audio":{"type":"boolean"},"audio_codec":{"type":"string","description":"AAC, MP3, OPUS or VORBIS."},"ssaa":{"type":"boolean","description":"Supersampling anti-aliasing (renders at double resolution)."},"no_gui":{"type":"boolean","description":"Hide the in-game HUD."},"transparent":{"type":"boolean","description":"Transparent sky; only when renderSky is off in the visuals and the codec supports alpha."},"reset_rng":{"type":"boolean","description":"Deterministic particles across exports."},"projection":{"type":"string","description":"PERSPECTIVE (default). On Minecraft 26.1+ also ORTHOGRAPHIC, CUBE_MAP or EQUIRECTANGULAR."},"orthographic_zoom":{"type":"number","description":"Zoom of the ORTHOGRAPHIC projection (Minecraft 26.1+). Default: the value last used in the export window."},"depth_map":{"type":"boolean","description":"Also export a depth map; needs container EXR_SEQUENCE (Minecraft 26.1+). Default false."},"sequence_format":{"type":"string","description":"File name pattern for image sequences (default %04d)."},"name":{"type":"string","description":"Job name shown on the export screen; also the default file name."},"wait":{"type":"boolean","description":"Block until the export is finished (default false)."},"wait_seconds":{"type":"number","description":"With wait=true: give up waiting after this many seconds (default 600). The export itself keeps running."}}}},{"name":"flashback_recording","description":"Control Flashback recording while playing in a world or on a server (not while a replay is open): start, finish, pause, unpause or cancel (cancel discards the recording).","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["start","finish","pause","unpause","cancel"]}},"required":["action"]}}]};

// Print a ready-to-merge configuration without starting MCP or touching client settings.
// The same helper works in the source companion and in the standalone public file.
const cliArgs = process.argv.slice(2);
if (cliArgs.length) {
  const clients = ['codex', 'claude', 'cursor', 'gemini', 'vscode', 'generic'];
  if (cliArgs.length === 1 && cliArgs[0] === '--help') {
    console.log('Flashback MCP ' + SERVER_VERSION + '\n' +
      'No arguments: start the MCP server over stdio.\n' +
      'Print configuration: node <server.mjs> --print-config <' + clients.join('|') + '>\n' +
      'Merge the output into your client configuration; keep existing settings.');
    process.exit(0);
  }
  const client = cliArgs[1];
  if (cliArgs.length !== 2 || cliArgs[0] !== '--print-config' || !clients.includes(client)) {
    console.error('Invalid arguments. Use --help for supported configuration formats.');
    process.exit(2);
  }
  const entry = { command: process.execPath, args: [fileURLToPath(import.meta.url)] };
  if (client === 'codex') {
    console.log('[mcp_servers.flashback]\n' +
      'command = ' + JSON.stringify(entry.command) + '\n' +
      'args = ' + JSON.stringify(entry.args) + '\n' +
      'startup_timeout_sec = 10\ntool_timeout_sec = 1200');
  } else {
    const config = client === 'vscode'
      ? { servers: { flashback: { type: 'stdio', ...entry } } }
      : { mcpServers: { flashback: { ...entry, ...(client === 'gemini' ? { timeout: REQUEST_TIMEOUT_MS } : {}) } } };
    console.log(JSON.stringify(config, null, 2));
  }
  process.exit(0);
}

const NOT_RUNNING = 'Flashback MCP is disabled or Minecraft is not running. ' +
  'Start the profile with Flashback MCP, click MCP in the title screen or pause menu, ' +
  'and enable the server, then try again.';

class BridgeError extends Error {}

async function locateBridge() {
  if (process.env.FLASHBACK_MCP_URL || process.env.FLASHBACK_MCP_TOKEN) {
    throw new BridgeError('Remove FLASHBACK_MCP_URL and FLASHBACK_MCP_TOKEN from the server configuration. The MCP server discovers the game connection automatically.');
  }
  try {
    const bridge = JSON.parse(await readFile(BRIDGE_FILE, 'utf8'));
    if (!Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65535 ||
        typeof bridge.token !== 'string' || bridge.token.length < 32) {
      throw new Error('malformed');
    }
    return { host: '127.0.0.1', port: bridge.port, token: bridge.token };
  } catch {
    throw new BridgeError(NOT_RUNNING);
  }
}

function post(bridge, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request(
      {
        host: bridge.host,
        port: bridge.port,
        path: '/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Authorization: `Bearer ${bridge.token}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: response.statusCode, json: JSON.parse(text) });
          } catch {
            reject(new BridgeError(`The bridge returned an unreadable response (HTTP ${response.statusCode}).`));
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new BridgeError('The bridge did not answer in time.')));
    request.on('error', (error) => {
      if (error instanceof BridgeError) {
        reject(error);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') {
        // A stale bridge.json left behind by a game that crashed looks exactly like this
        reject(new BridgeError(NOT_RUNNING));
      } else {
        reject(new BridgeError(`Cannot reach the bridge: ${error.message}`));
      }
    });
    request.end(payload);
  });
}

async function callBridge(tool, args) {
  const bridge = await locateBridge();
  const { status, json } = await post(bridge, { tool, args });
  if (status === 401) {
    throw new BridgeError('The bridge rejected the token: Minecraft was probably restarted mid-request. Try again.');
  }
  if (!json.ok) {
    throw new BridgeError(json.error || `The bridge failed (HTTP ${status}).`);
  }
  return json.result;
}

async function callTool(name, args) {
  try {
    const screenshot = name === 'flashback_screenshot';
    // Standard MCP image content works in clients/models that support images.
    const result = await callBridge(name.replace(/^flashback_/, ''), screenshot ? { ...args, inline_image: true } : (args ?? {}));

    const content = [];
    if (screenshot && typeof result.image_base64 === 'string') {
      const { image_base64: data, ...rest } = result;
      content.push({ type: 'text', text: JSON.stringify(rest) });
      content.push({ type: 'image', data, mimeType: 'image/png' });
    } else {
      content.push({ type: 'text', text: JSON.stringify(result) });
    }
    return { content };
  } catch (error) {
    if (error instanceof BridgeError) {
      return { content: [{ type: 'text', text: error.message }], isError: true };
    }
    throw error;
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
      ('id' in message && typeof message.id !== 'string' && !Number.isInteger(message.id))) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const { id, method, params } = message;
  const isRequest = id !== undefined;
  // Notifications never produce responses or execute request-only operations.
  if (!isRequest) return;
  const invalidParams = text => send({ jsonrpc: '2.0', id, error: { code: -32602, message: text } });
  if (params !== undefined && !isObject(params)) {
    invalidParams('params must be an object');
    return;
  }

  try {
    let result;
    switch (method) {
      case 'initialize':
        if (typeof params?.protocolVersion !== 'string') {
          invalidParams('initialize requires protocolVersion');
          return;
        }
        result = {
          protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
            ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'flashback', version: SERVER_VERSION },
          instructions,
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools };
        break;
      case 'tools/call':
        if (typeof params?.name !== 'string' || !tools.some(tool => tool.name === params.name) ||
            (params.arguments !== undefined && !isObject(params.arguments))) {
          invalidParams('tools/call requires a known tool name and an arguments object');
          return;
        }
        result = await callTool(params?.name, params?.arguments);
        break;
      default:
        if (isRequest) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return;
    }
    if (isRequest) {
      send({ jsonrpc: '2.0', id, result });
    }
  } catch (error) {
    if (isRequest) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error?.message ?? String(error) } });
    }
  }
}

let pending = 0;
let closed = false;

function exitWhenIdle() {
  if (closed && pending === 0) {
    // Pipes are asynchronous on Windows: let the last responses reach the client before exiting.
    process.stdout.write('', () => process.exit(0));
  }
}

// A client that goes away closes the pipe under us; that is a normal way to end, not a crash.
process.stdout.on('error', () => process.exit(0));

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  pending += 1;
  handle(message).finally(() => {
    pending -= 1;
    exitWhenIdle();
  });
});
lines.on('close', () => {
  closed = true;
  exitWhenIdle();
});
