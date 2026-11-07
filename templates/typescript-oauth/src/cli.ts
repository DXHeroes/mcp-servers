#!/usr/bin/env node
import { runConnectorCli } from '@dxheroes/mcp-runtime';
import { endpoints, mcpPackage } from './index.js';

await runConnectorCli(mcpPackage, process.argv.slice(2), endpoints);
