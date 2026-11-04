#!/usr/bin/env node
// MCP server for local AI clients and the Flashback MCP mod. No dependencies: it speaks
// newline-delimited JSON-RPC on stdin/stdout and forwards tool calls to the mod over
// a token-protected HTTP endpoint.
//
// Same machine as the game: nothing to configure, the mod publishes its port and token
// in ~/.flashback-mcp/bridge.json when the in-game MCP switch is enabled.
// Any compatible MCP client starts this process using stdio.

import { readFileSync } from 'node:fs';
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
const { instructions, tools } = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));

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
