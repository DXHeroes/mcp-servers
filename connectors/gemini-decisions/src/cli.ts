#!/usr/bin/env node
import { runConnectorCli } from '@dxheroes/mcp-runtime';
import { mcpPackage } from './index.js';

await runConnectorCli(mcpPackage);
