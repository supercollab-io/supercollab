#!/usr/bin/env node
import { runMcp } from './supercollab.js';

runMcp({ profile: process.env.SUPERCOLLAB_PROFILE || undefined }).catch((error) => {
  console.error(`supercollab-mcp: ${error.message}`);
  process.exit(1);
});
