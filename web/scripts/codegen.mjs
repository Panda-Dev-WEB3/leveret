// Generate typed @solana/kit clients from the Anchor IDLs in ../target/idl.
// Run after `anchor build` (or scripts/wsl-build.sh): `npm run codegen`.
import { readFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFromRoot } from 'codama';
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';

const here = dirname(fileURLToPath(import.meta.url));
const idlDir = resolve(here, '../../target/idl');
const outRoot = resolve(here, '../src/generated');

// Programs the website talks to.
const programs = ['lvrt_engine', 'lvrt_oracle', 'lvrt_vault', 'lvrt_tickets', 'lvrt_insurance', 'lvrt_fee_router'];
// lvrt_insurance has both a `Stake` account and a `stake` instruction, whose
// discriminator constants collide in the barrel file; import its sub-modules.
const dropBarrel = new Set(['lvrt_insurance']);

rmSync(outRoot, { recursive: true, force: true });
for (const name of programs) {
  const idl = JSON.parse(readFileSync(resolve(idlDir, `${name}.json`), 'utf8'));
  const codama = createFromRoot(rootNodeFromAnchor(idl));
  await codama.accept(renderVisitor(resolve(outRoot, name), { generatedFolder: '.', syncPackageJson: false, importExtension: 'ts', erasableSyntax: true, deleteFolderBeforeRendering: true, formatCode: true }));
  if (dropBarrel.has(name)) rmSync(resolve(outRoot, name, 'index.ts'));
  console.log(`generated ${name}`);
}
