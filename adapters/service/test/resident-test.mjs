#!/usr/bin/env node
// The canvas service as a resident process (FORK.md 画布服务): the service of the machine's canvas
// does not exit for being idle, a service of another canvas (a check's, a dev host's) still does
// after 10 minutes, and COWART_SERVICE_IDLE_MS sets the time for either.
import assert from 'node:assert/strict'

import { finish, step } from '../../claude/scripts/test-kit.mjs'
import { serviceIdleMs } from '../lib/service.mjs'

await step('(f) serviceIdleMs: never for the machine canvas, 10 minutes for another, COWART_SERVICE_IDLE_MS first', async () => {
  assert.equal(serviceIdleMs({}), Infinity, 'no COWART_CANVAS_DIR: the machine canvas, never idle')
  assert.equal(serviceIdleMs({ COWART_CANVAS_DIR: '' }), Infinity, 'an empty COWART_CANVAS_DIR is the machine canvas too')
  assert.equal(serviceIdleMs({ COWART_CANVAS_DIR: 'x' }), 600_000, 'another canvas: 10 minutes')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '5000' }), 5000, 'COWART_SERVICE_IDLE_MS for the machine canvas')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '5000', COWART_CANVAS_DIR: 'x' }), 5000, 'COWART_SERVICE_IDLE_MS for another canvas')
  assert.equal(serviceIdleMs({ COWART_SERVICE_IDLE_MS: '0', COWART_CANVAS_DIR: 'x' }), 600_000, 'a COWART_SERVICE_IDLE_MS that is not above 0 is not used')
})

finish()
