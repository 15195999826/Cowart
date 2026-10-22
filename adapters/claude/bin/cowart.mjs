#!/usr/bin/env node
// The cowart command Claude Code sessions run with the Bash tool (see ../lib/cli.mjs and the
// cowart skill); `node cowart.mjs install` makes ~/.cowart/bin/cowart.mjs lead here.
import { main } from '../lib/cli.mjs'

await main()
