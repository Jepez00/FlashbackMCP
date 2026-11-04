import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
let source = await readFile(new URL('mcp-server/server.mjs', root), 'utf8');
source = source.replaceAll('\r\n', '\n');
const catalog = JSON.parse(await readFile(new URL('mcp-server/tools.json', root), 'utf8'));
const license = (await readFile(new URL('LICENSE', root), 'utf8')).replaceAll('\r\n', '\n').trim();
const loader = "const { instructions, tools } = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));";
if (source.split(loader).length !== 2 || license.includes('*/')) {
  throw new Error('Source format changed; review the standalone build script.');
}
source = source.replace("import { readFileSync } from 'node:fs';\n", '');
source = source.replace(loader, 'const { instructions, tools } = ' + JSON.stringify(catalog) + ';');
source = source.replace('#!/usr/bin/env node\n', '#!/usr/bin/env node\n/*\n' + license + '\n*/\n');
await writeFile(new URL('flashback-mcp-server.mjs', root), source, 'utf8');
console.log(`Built flashback-mcp-server.mjs with ${catalog.tools.length} tools.`);
