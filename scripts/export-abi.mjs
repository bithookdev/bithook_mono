#!/usr/bin/env node
/**
 * Generates packages/core/src/abi.ts from the Foundry build artifacts.
 *
 * Hand-transcribed ABIs are a silent-failure class all of their own: a wrong
 * output type decodes to garbage rather than throwing. These come straight out
 * of `forge build`, so they cannot drift from the deployed bytecode.
 *
 *   forge build && node scripts/export-abi.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SOURCES = [
  { artifact: 'out/Bithook.sol/Bithook.json', name: 'bithookTokenAbi' },
  { artifact: 'out/Bithook.sol/BithookMiningHook.json', name: 'bithookHookAbi' },
];

/** Hand-written: we index the PoolManager but never compile it here. */
const POOL_MANAGER_EVENTS = [
  {
    type: 'event',
    name: 'Swap',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'sender', type: 'address', indexed: true },
      { name: 'amount0', type: 'int128', indexed: false },
      { name: 'amount1', type: 'int128', indexed: false },
      { name: 'sqrtPriceX96', type: 'uint160', indexed: false },
      { name: 'liquidity', type: 'uint128', indexed: false },
      { name: 'tick', type: 'int24', indexed: false },
      { name: 'fee', type: 'uint24', indexed: false },
    ],
    anonymous: false,
  },
];

let out = `/**
 * GENERATED FILE — do not edit.
 * Regenerate with: forge build && node scripts/export-abi.mjs
 */

`;

for (const { artifact, name } of SOURCES) {
  const path = join(root, artifact);
  let json;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    console.error(`missing artifact ${artifact} — run \`forge build\` first`);
    process.exit(1);
  }
  if (!Array.isArray(json.abi) || json.abi.length === 0) {
    console.error(`artifact ${artifact} has no abi`);
    process.exit(1);
  }
  out += `export const ${name} = ${JSON.stringify(json.abi, null, 2)} as const;\n\n`;
  const events = json.abi.filter((e) => e.type === 'event').length;
  const fns = json.abi.filter((e) => e.type === 'function').length;
  console.log(`${name}: ${fns} functions, ${events} events`);
}

out += `/** PoolManager events we index. Not compiled here — v4 core is a dependency. */\n`;
out += `export const poolManagerAbi = ${JSON.stringify(POOL_MANAGER_EVENTS, null, 2)} as const;\n`;

const dest = join(root, 'packages/core/src/abi.ts');
writeFileSync(dest, out);
console.log(`wrote ${dest}`);
