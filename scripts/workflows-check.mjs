// Nothing this repository runs puts the package on npm. The package goes out as a `.tgz` on each `master` commit's
// prerelease (`.github/workflows/packages.yml`), and the registry is never written: no workflow, and no script of the
// manifest a workflow can run, may call a command that writes to a registry, use a tool made to, or hold a token for
// one. A workflow reads no secret but the `GITHUB_TOKEN`, so no npm token can reach one under any name. It fails
// naming each line that breaks this, and CI runs it on every push.
//
//   npm run workflows:check
//   node scripts/workflows-check.mjs <directory>   (a copy of the repository, to see it fail)
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'))
const WORKFLOWS = path.join(ROOT, '.github', 'workflows')

/** What is refused, with why, each tested against one line */
const RULES = [
  [/\b(npm|pnpm|yarn|bun)\b.*\b(publish|unpublish|dist-tag|deprecate|adduser|login|owner|access|token)\b/i, "an npm client's registry-writing command"],
  [/\b(semantic-release|lerna\s+publish|changeset\s+publish|changesets\/action|npm-publish|release-it)\b/i, 'a tool that publishes to npm'],
  [/\b(NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG_\w*AUTH\w*)\b|_authToken|\bregistry-url\b/i, 'an npm token, or the setup that reads one'],
  [/\bsecrets\.(?!GITHUB_TOKEN\b)\w+|\bsecrets\s*\[|\btoJSON\(\s*secrets\s*\)|\bsecrets:\s*inherit\b/, 'a secret other than the GITHUB_TOKEN'],
]

const files = fs.readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join(WORKFLOWS, name))
if (files.length === 0) throw new Error(`No workflows in ${WORKFLOWS}`)
const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {}

const broken = []
for (const file of files) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    // A whole-line comment runs nothing, in YAML or in a step's shell, and may say what is refused
    if (/^\s*#/.test(line)) return
    for (const [pattern, what] of RULES) {
      if (pattern.test(line)) broken.push(`${path.relative(ROOT, file)}:${i + 1}: ${what}: ${line.trim()}`)
    }
  })
}
for (const [name, script] of Object.entries(scripts)) {
  // npm runs these around a publish of its own accord, so a manifest that has one is ready to publish
  if (/^(pre|post)?publish(Only)?$/.test(name)) broken.push(`package.json scripts.${name}: a publish lifecycle script`)
  for (const [pattern, what] of RULES) {
    if (pattern.test(script)) broken.push(`package.json scripts.${name}: ${what}: ${script}`)
  }
}

if (broken.length > 0) {
  console.error(`Nothing here may publish to npm or hold a token for it (scripts/workflows-check.mjs):\n${broken.join('\n')}`)
  process.exit(1)
}
console.log(`${files.length} workflows and ${Object.keys(scripts).length} scripts: none publishes to npm or holds a token for it`)
