// Build dsh-win-notify:
//   src/index.ts           -> lib/index.js       (esm host entry, node built-ins only)
//   .dsh-notify/           -> lib/.dsh-notify/   (helper assets: DshToast.cs / DshToast.exe / notify.ico / whale-black-bg.png)
//   src/types/**           -> lib/types/**       (hand-written d.ts copied verbatim)
//
// The plugin resolves the helper dir relative to import.meta.url as
// `join(__dirname, '.dsh-notify')`, so the EXE, the .cs source, the icon and
// the PNG must sit next to the built entry inside lib/. The published package
// is then fully self-contained: `files: ["lib", …]`.
import { build } from 'esbuild'
import { cpSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(root, 'lib')
const helperDir = resolve(root, '.dsh-notify')

rmSync(libDir, { recursive: true, force: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  target: 'node20',
  platform: 'node',
  logLevel: 'info',
  outfile: resolve(libDir, 'index.js'),
})

cpSync(helperDir, resolve(libDir, '.dsh-notify'), { recursive: true })
cpSync(resolve(root, 'src/types'), resolve(libDir, 'types'), { recursive: true })

console.log('build: lib/index.js, lib/.dsh-notify/, lib/types/ written')