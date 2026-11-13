// The reference, generated from the source: every export of the package's entries with its doc comment and its
// signature, and each public member of an exported class. It is written to REFERENCE.md (`--write`) or compared
// with it (the default, which CI runs), and either way it fails when an export or a public member is used by no
// spec — the case that would fire if it broke. What a spec uses is read from the type checker, not from the text.
//
//   node scripts/reference.mjs           check REFERENCE.md and that every export has a spec using it
//   node scripts/reference.mjs --write   write REFERENCE.md, then the same check of what the specs use
import * as fs from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'REFERENCE.md')
/** The package's entries, as `package.json` names them, each by the source it is built from */
const ENTRIES = Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).exports).map((entry) => ({
  entry: entry === '.' ? 'apack-git' : `apack-git/${entry.slice(2)}`,
  source: path.join(ROOT, 'src', entry === '.' ? 'index.ts' : `${entry.slice(2)}.ts`),
}))

const config = ts.getParsedCommandLineOfConfigFile(path.join(ROOT, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} })
const program = ts.createProgram(config.fileNames, config.options)
const checker = program.getTypeChecker()

const resolved = (symbol) => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol)
const docOf = (symbol) => ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
const flags = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType

/**
 * What it is called and what it takes and answers: a function's signature, and a type or an interface as it is
 * declared, its fields' own comments with it, with line endings as the reference's own
 */
function signatureOf(symbol, declaration) {
  if (ts.isTypeAliasDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
    return declaration.getText().replace(/^export\s+/, '').replace(/\r\n/g, '\n')
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const signatures = type.getCallSignatures()
  if (signatures.length > 0) return signatures.map(signature => `${symbol.name}${checker.signatureToString(signature, declaration, flags)}`).join('\n')
  return `${symbol.name}: ${checker.typeToString(type, declaration, flags)}`
}

/** A class's public members: neither private, protected nor named for one (`_x`, `#x`) */
function publicMembersOf(symbol) {
  const members = []
  for (const member of symbol.members?.values() ?? []) {
    const declaration = member.valueDeclaration ?? member.declarations?.[0]
    if (!declaration || member.name === '__constructor' || member.name.startsWith('_') || member.name.startsWith('#')) continue
    const modifiers = ts.getCombinedModifierFlags(declaration)
    if (modifiers & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue
    members.push({ symbol: member, declaration })
  }
  return members.sort((a, b) => a.symbol.name.localeCompare(b.symbol.name))
}

const items = []
const lines = ['# Reference', '', 'Generated from the source by `npm run reference:update`; `npm run reference:check` holds it to the source.', '']
for (const { entry, source } of ENTRIES) {
  const file = program.getSourceFile(source)
  if (!file) throw new Error(`${source} is not part of the program`)
  const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(file)).sort((a, b) => a.name.localeCompare(b.name))
  if (exported.length === 0) throw new Error(`${entry} exports nothing, which this would have read as nothing to check`)
  lines.push(`## \`${entry}\``, '')
  for (const symbol of exported) {
    const target = resolved(symbol)
    const declaration = target.valueDeclaration ?? target.declarations?.[0]
    if (!declaration) continue
    items.push({ name: symbol.name, symbol: target })
    lines.push(`### \`${symbol.name}\``, '')
    const doc = docOf(target)
    if (doc) lines.push(doc, '')
    if (ts.isClassDeclaration(declaration)) {
      for (const { symbol: member, declaration: memberDeclaration } of publicMembersOf(target)) {
        items.push({ name: `${symbol.name}.${member.name}`, symbol: member })
        lines.push(`- \`${signatureOf(member, memberDeclaration).replaceAll('\n', '`<br>`')}\`${docOf(member) ? ` — ${docOf(member).replaceAll('\n', ' ')}` : ''}`)
      }
      lines.push('')
    } else {
      lines.push('```ts', signatureOf(target, declaration), '```', '')
    }
  }
}
const text = `${lines.join('\n').trimEnd()}\n`

// What the specs use, read from every identifier in them that the checker resolves to a declaration of the source:
// a declaration rather than a symbol, since a member reached through an instance is a symbol made for that type
const used = new Set()
// The program names its files with `/` on every platform, so they are compared as resolved paths
const specs = program.getSourceFiles().filter(file => path.resolve(file.fileName).startsWith(path.join(ROOT, 'tests') + path.sep))
if (specs.length === 0) throw new Error('No spec was found to read, which would have counted every export as unused')
for (const spec of specs) {
  const visit = (node) => {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node)
      for (const root of symbol ? checker.getRootSymbols(resolved(symbol)) : []) for (const declaration of root.declarations ?? []) used.add(declaration)
    }
    ts.forEachChild(node, visit)
  }
  visit(spec)
}

const problems = []
// A type has no case of its own: what fires for it is a case of what answers in it
const unused = items
  .filter(({ symbol }) => symbol.flags & ts.SymbolFlags.Value && !(symbol.declarations ?? []).some(declaration => used.has(declaration)))
  .map(({ name }) => name)
if (unused.length > 0) problems.push(`No spec uses ${unused.length === 1 ? 'this' : 'these'}, so nothing fires if ${unused.length === 1 ? 'it breaks' : 'one breaks'}:\n  ${unused.join('\n  ')}`)
if (process.argv.includes('--write')) fs.writeFileSync(OUT, text)
else if (!fs.existsSync(OUT) || fs.readFileSync(OUT, 'utf8') !== text) problems.push('REFERENCE.md is not what the source says: run npm run reference:update and commit it')
if (problems.length > 0) {
  console.error(problems.join('\n\n'))
  process.exit(1)
}
console.log(`${items.length} exports and members, each value among them used by a spec${process.argv.includes('--write') ? '; REFERENCE.md written' : ', and REFERENCE.md as the source says'}`)
