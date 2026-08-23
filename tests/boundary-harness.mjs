// Boundary test: a component that throws during render must be caught by the
// plugin's Boundary class → fallback UI renders, no uncaught crash.
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { pluginPath, sdkStubPath, boundaryTestPath, prepareHarnessDirs } from './helpers/paths.mjs'

const require = createRequire(import.meta.url)
const React = require('react')
const RTR = require('react-test-renderer')

let passed = 0, failed = 0
const check = (name, ok, detail = '') => { passed += !!ok; failed += !ok; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`) }

prepareHarnessDirs()
// reuse the harness's SDK stub by importing it (it self-writes on import chain,
// so just re-create the same stub inline here)
writeFileSync(sdkStubPath, `
import React from 'react'
export const cn = (...a) => a.filter(Boolean).join(' ')
export const host = { request: async () => ({}), onEvent: () => () => {}, notify: () => {} }
export const useQuery = () => ({ data: null, isLoading: true })
export const useMutation = () => ({ mutate: () => {}, isPending: false })
export const useQueryClient = () => ({ invalidateQueries: () => {} })
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export function ErrorState({ title, description }) {
  return React.createElement('div', { 'data-slot': 'error-state' },
    React.createElement('div', null, title), description ? React.createElement('div', null, description) : null)
}
export function Button(props) {
  const { size, variant, ...rest } = props
  return React.createElement('button', { ...rest })
}
`)

const src = readFileSync(pluginPath, 'utf8')

// Extract the Boundary class into a standalone module for direct testing
const m = src.match(/\/\/ ─── error boundary[\s\S]*?^}\n/m)
if (!m) { console.log('FAIL: Boundary class not found'); process.exit(1) }
const boundarySrc = `
import ReactDefault, { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { ErrorState, Button } from '@hermes/plugin-sdk'
${m[0]}
export { Boundary }
`
writeFileSync(boundaryTestPath, boundarySrc)

const { Boundary } = await import(pathToFileURL(boundaryTestPath).href + '?v=' + Date.now())

function Bomb() { throw new Error('simulated render crash') }

let renderer
RTR.act(() => {
  renderer = RTR.create(React.createElement(Boundary, { children: React.createElement(Bomb) }))
})

const json = JSON.stringify(renderer.toJSON())
check('boundary caught', json.includes('the fleet graph view crashed'))
check('fallback has reload', json.includes('Reload view'))
check('error-state rendered',
  json.includes('data-slot="error-state"') || json.includes('error-state'))

console.log(`BOUNDARY SUMMARY: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
