// Shared, machine-independent path resolution for the frontend harness kit.
//
// Every harness-generated artifact lives under tests/.tmp/ (or an explicit
// environment override), is created on demand by prepareHarnessDirs(), and is
// cleanable by removing that single directory. No fixed developer homes and no
// system temp paths appear here, so the kit runs from any checkout.
//
// Module resolution notes:
// - The SDK stub written to sdkStubPath is imported by the plugin source as the
//   bare specifier '@hermes/plugin-sdk'; it resolves via tests/.tmp/node_modules.
// - react / react-test-renderer resolve once, from tests/node_modules (walk-up
//   from tests/.tmp), so the harness, stub, and plugin share a single React
//   copy — no duplicate-React "invalid hook call" hazard regardless of cwd.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const pluginPath = process.env.FLEET_PLUGIN_JS ||
  fileURLToPath(new URL('../../desktop-plugin/plugin.js', import.meta.url))
export const underTestPath = process.env.FLEET_UNDER_TEST ||
  fileURLToPath(new URL('../.tmp/under-test.mjs', import.meta.url))

// Narrowly necessary extras: the SDK-stub file and the scratch module used by
// the boundary extraction probe. Both live beside under-test.mjs in the sandbox.
export const sdkStubPath = process.env.FLEET_SDK_STUB ||
  fileURLToPath(new URL('../.tmp/node_modules/@hermes/plugin-sdk/index.js', import.meta.url))
export const boundaryTestPath = process.env.FLEET_BOUNDARY_TEST ||
  fileURLToPath(new URL('../.tmp/boundary-test.mjs', import.meta.url))

export function prepareHarnessDirs() {
  for (const file of [underTestPath, sdkStubPath, boundaryTestPath]) {
    mkdirSync(dirname(file), { recursive: true })
  }
}
