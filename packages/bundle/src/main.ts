#!/usr/bin/env node
import { runCli } from '@starlight-intelligence/creator-cli'
import { readFileSync } from 'node:fs'

const { name, version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string }
runCli({ brand: 'starlight-creator-mcp', version, npmPackage: name }).then(code => { process.exitCode = code }, () => { process.stderr.write('Creator CLI failed; check local configuration.\n'); process.exitCode = 1 })
