#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const args = { workspace: '', json: false, strict: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--workspace') args.workspace = argv[++index] || ''
    else if (item === '--json') args.json = true
    else if (item === '--strict') args.strict = true
    else if (item === '-h' || item === '--help') args.help = true
  }
  return args
}

function printHelp() {
  console.log(`Usage:
  node scripts/validate-courseware-workspace.mjs --workspace <lesson-workspace> [--strict] [--json]

Uses the shared Tiku courseware validator. Set TIKU_COURSEWARE_VALIDATOR to override
the validator module path.
`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help || !args.workspace) {
  printHelp()
  process.exit(args.help ? 0 : 2)
}

const validatorPath = resolve(process.env.TIKU_COURSEWARE_VALIDATOR || '../AI-practice/lib/courseware-validator/index.js')
if (!existsSync(validatorPath)) {
  console.error(`Courseware validator not found: ${validatorPath}`)
  process.exit(2)
}

const { validateCourseware } = await import(pathToFileURL(validatorPath).href)
const result = validateCourseware({ workspacePath: resolve(args.workspace), publishTarget: 'learn' }, { publishTarget: 'learn' })

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`PilotDeck courseware validation: ${result.ok ? 'PASS' : 'FAIL'} (${result.issues.length} errors, ${result.warnings.length} warnings)`)
  for (const item of result.issues) console.error(`  FAIL  [${item.code}] ${item.path ? `${item.path}: ` : ''}${item.message}`)
  for (const item of result.warnings.slice(0, 30)) console.warn(`  WARN  [${item.code}] ${item.path ? `${item.path}: ` : ''}${item.message}`)
}

if (!result.ok || (args.strict && result.warnings.length)) process.exit(1)
