import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

export function sourceRoot() {
  return app.isPackaged ? app.getAppPath() : SOURCE_ROOT
}

export function resourcesRoot() {
  return app.isPackaged ? process.resourcesPath : SOURCE_ROOT
}

export function computerUseDir() {
  return join(resourcesRoot(), 'computer-use')
}

export function readmePath() {
  return join(resourcesRoot(), '读我.txt')
}
