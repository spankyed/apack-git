// The package as a stranger gets it: packed as `npm publish` would pack it, installed into a consumer of its own
// with every package in its own folder (`--install-strategy=nested`, so nothing resolves through this repository's
// node_modules), and each entry imported there by its name. Each is compiled with TypeScript under `node16` and
// `bundler` resolution, where it must have its own types, and imported by Node, `./package.json` as well; every file
// an entry's conditions name must ship. It fails on the first entry that a consumer can't resolve, type or load, and
// removes what it made either way.
//
//   npm run package:check   (through npm, which it runs to pack and install; `prepack` builds dist/ first)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const NPM = process.env.npm_execpath
if (!NPM) throw new Error('Run it through npm (`npm run package:check`), which says where npm is')
const TSC = createRequire(path.join(ROOT, 'package.json')).resolve('typescript/bin/tsc')

/** Every entry with types, by the specifier a consumer imports it with */
const typed = Object.keys(MANIFEST.exports).filter((entry) => entry !== './package.json')
  .map((entry) => (entry === '.' ? MANIFEST.name : `${MANIFEST.name}/${entry.slice(2)}`))
/** What Node loads: the entries, and the manifest, which tools read by its own specifier */
const specifiers = [...typed, `${MANIFEST.name}/package.json`]
/** Every file an entry's conditions name, without its leading `./` */
const targets = Object.values(MANIFEST.exports).flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)))
  .map((target) => target.replace(/^\.\//, ''))

const npm = (cwd, args) => execFileSync(process.execPath, [NPM, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'apack-git-package-')))
try {
  const [packed] = JSON.parse(npm(ROOT, ['pack', '--json', '--pack-destination', scratch]))
  const shipped = packed.files.map((file) => file.path)
  const stray = shipped.filter((file) => !/^(dist\/[^/]+\.(js|js\.map|d\.ts)|package\.json|README\.md|REFERENCE\.md|LICENSE)$/.test(file))
  if (stray.length > 0) throw new Error(`The package would ship what no consumer needs: ${stray.join(', ')}`)
  // A types condition naming a missing file is passed over by TypeScript, which finds the declarations beside the
  // JavaScript instead; the condition is still wrong, so it is held to what ships here
  const missing = targets.filter((target) => !shipped.includes(target))
  if (missing.length > 0) throw new Error(`The exports name files the package doesn't ship: ${missing.join(', ')}`)

  const consumer = path.join(scratch, 'consumer')
  fs.mkdirSync(consumer)
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  npm(consumer, ['install', '--install-strategy=nested', '--no-audit', '--no-fund', '--no-package-lock', path.join(scratch, packed.filename)])

  // Each entry's namespace is used, and a member it doesn't have is an error: an entry typed `any` would let it through
  fs.writeFileSync(path.join(consumer, 'entries.ts'), [
    ...typed.map((specifier, i) => `import * as entry${i} from '${specifier}'`),
    ...typed.map((_, i) => `// @ts-expect-error no entry exports this\nentry${i}.notExported`),
    `export const entries = [${typed.map((_, i) => `entry${i}`).join(', ')}]`,
  ].join('\n') + '\n')
  for (const [resolution, module] of [['node16', 'node16'], ['bundler', 'esnext']]) {
    const config = path.join(consumer, `tsconfig.${resolution}.json`)
    fs.writeFileSync(config, JSON.stringify({
      compilerOptions: {
        module, moduleResolution: resolution, target: 'es2022', strict: true, noEmit: true, skipLibCheck: false,
        typeRoots: [path.join(ROOT, 'node_modules', '@types')], types: ['node'],
      },
      files: ['entries.ts'],
    }))
    try {
      execFileSync(process.execPath, [TSC, '-p', config], { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      throw new Error(`The entries don't compile for a consumer under ${resolution} resolution:\n${error.stdout}${error.stderr}`)
    }
  }

  fs.writeFileSync(path.join(consumer, 'load.mjs'), specifiers.map((specifier) => specifier.endsWith('/package.json')
    ? `if ((await import('${specifier}', { with: { type: 'json' } })).default.name !== '${MANIFEST.name}') throw new Error('${specifier} is another package\\'s')`
    : `if (Object.keys(await import('${specifier}')).length === 0) throw new Error('${specifier} exports nothing')`).join('\n') + '\n')
  try {
    execFileSync(process.execPath, ['load.mjs'], { cwd: consumer, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(`Node can't load every entry from the installed package:\n${error.stderr}`)
  }

  console.log(`${packed.filename}: ${shipped.length} files, installed nested; ${typed.join(', ')} compiled under node16 and bundler resolution, and loaded by Node with ${MANIFEST.name}/package.json`)
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
