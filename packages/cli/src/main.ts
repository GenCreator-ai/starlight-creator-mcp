#!/usr/bin/env node
import { runCli } from './run.js'

runCli({ brand: 'starlight-creator-mcp', version: '0.1.0', npmPackage: '@starlight-intelligence/creator-cli' }).then(code => { process.exitCode = code }, err => { process.stderr.write(`${(err as Error).stack ?? err}\n`); process.exitCode = 1 })
