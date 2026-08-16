import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronBrainStatus } from '../../../../shared/eventa'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { Mutex } from 'async-mutex'
import { app } from 'electron'

import {
  electronBrainGetStatus,
  electronBrainStart,
  electronBrainStatusChanged,
  electronBrainStop,
} from '../../../../shared/eventa'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'
import { getElectronMainDirname } from '../../../libs/electron/location'

type MainContext = ReturnType<typeof createContext>['context']
type BrainProcess = ChildProcessByStdio<null, Readable, Readable>

const DEFAULT_BRAIN_PORT = 14515
const READY_TIMEOUT_MS = 20_000
const PROCESS_EXIT_WAIT_MS = 2_000

// Readiness markers the brain prints on stdout (see services/claude-code-brain/src/index.ts).
const BRAIN_LISTENING_MARKER = 'claude-code-brain listening'
const BRAIN_PORT_IN_USE_MARKER = 'port already in use'

interface Deferred<T> {
  promise: Promise<T>
  reject: (error?: unknown) => void
  resolve: (value: T | PromiseLike<T>) => void
}

interface ListenerChannel<T> {
  publish: (payload: T) => void
  subscribe: (callback: (payload: T) => void) => () => void
}

/**
 * Claude Code brain sidecar lifecycle controller owned by Electron main.
 *
 * Starts/stops the local `claude-code-brain` HTTP bridge (a much simpler
 * sidecar than the Godot stage: no WebSocket, no scene, no view state) and
 * tracks its lifecycle for renderer windows.
 */
export interface BrainManager {
  getStatus: () => ElectronBrainStatus
  start: (port?: number) => Promise<ElectronBrainStatus>
  stop: () => Promise<ElectronBrainStatus>
  subscribe: (callback: (status: ElectronBrainStatus) => void) => () => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })

  return {
    promise,
    reject,
    resolve,
  }
}

function createListenerChannel<T>(onListenerError: (error: unknown) => void): ListenerChannel<T> {
  const listeners = new Set<(payload: T) => void>()

  return {
    publish(payload) {
      for (const listener of listeners) {
        try {
          listener(payload)
        }
        catch (error) {
          onListenerError(error)
        }
      }
    },
    subscribe(callback) {
      listeners.add(callback)

      return () => {
        listeners.delete(callback)
      }
    },
  }
}

function waitForProcessExit(exitPromise: Promise<void>, timeoutMs: number) {
  return Promise.race([
    exitPromise.then(() => true, () => false),
    new Promise<boolean>(resolve => setTimeout(resolve, timeoutMs, false)),
  ])
}

function pipeProcessLog(stream: Readable, write: (message: string) => void) {
  stream.on('data', (data) => {
    const message = data.toString('utf-8').trim()
    if (message) {
      write(message)
    }
  })
}

// Dev builds run against the workspace checkout; packaged builds resolve from
// the app bundle. Both share one walk-up loop that stops as soon as
// services/claude-code-brain/package.json exists — the brain source is not
// shipped with the packaged app, so `start()` surfaces a clear error there.
async function resolveBrainProjectRoot() {
  let currentDirectory = app.isPackaged ? app.getAppPath() : getElectronMainDirname()

  while (true) {
    const projectPath = resolve(currentDirectory, 'services', 'claude-code-brain')

    try {
      await access(join(projectPath, 'package.json'))
      return projectPath
    }
    catch {}

    const parentDirectory = dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      break
    }

    currentDirectory = parentDirectory
  }

  throw new Error(
    'Unable to locate the claude-code-brain service. '
    + `Searched from ${getElectronMainDirname()} for services/claude-code-brain/package.json.`,
  )
}

/**
 * Creates the shared Claude Code brain manager.
 *
 * Call stack:
 *
 * setupBrainManager
 *   -> {@link createBrainManager}
 *     -> renderer invoke handlers
 *       -> claude-code-brain child process
 */
export function createBrainManager(): BrainManager {
  const log = useLogg('main/brain').useGlobalConfig()
  const lifecycleMutex = new Mutex()
  const statusListeners = createListenerChannel<ElectronBrainStatus>(
    error => log.withError(error).warn('failed to publish brain status change'),
  )

  let currentStatus: ElectronBrainStatus = {
    state: 'stopped',
    port: DEFAULT_BRAIN_PORT,
    pid: null,
    updatedAt: Date.now(),
  }
  let currentProcess: BrainProcess | undefined
  let currentProcessExit = createDeferred<void>()
  let currentReady: Deferred<void> | undefined
  let expectedProcessExit = false
  // Set when the brain logged that another instance is already serving the
  // port; that instance is not ours to kill, and its exit (code 0) is not a crash.
  let reusingExternalInstance = false

  function setStatus(next: Partial<ElectronBrainStatus> & Pick<ElectronBrainStatus, 'state'>) {
    currentStatus = {
      ...currentStatus,
      ...next,
      updatedAt: Date.now(),
    }
    statusListeners.publish(currentStatus)
  }

  function clearProcessState() {
    currentProcess = undefined
    currentProcessExit.resolve()
    currentProcessExit = createDeferred<void>()
  }

  function resolveReady() {
    currentReady?.resolve()
    currentReady = undefined
  }

  function rejectReady(error: unknown) {
    currentReady?.reject(error)
    currentReady = undefined
  }

  // Kills the child process if we still own one. Called from inside the
  // lifecycle mutex, so unlike the public `stop()` it must not re-lock.
  async function stopProcessInternal() {
    if (!currentProcess) {
      return
    }

    const activeProcess = currentProcess
    const exitPromise = currentProcessExit.promise
    expectedProcessExit = true

    activeProcess.kill()

    const exited = await waitForProcessExit(exitPromise, PROCESS_EXIT_WAIT_MS)

    if (!exited) {
      activeProcess.kill('SIGKILL')
      await exitPromise.catch(() => {})
    }
  }

  function attachProcessListeners(processHandle: BrainProcess) {
    pipeProcessLog(processHandle.stdout, (message) => {
      log.log(message)

      if (message.includes(BRAIN_PORT_IN_USE_MARKER)) {
        // The brain exits 0 after logging this; another instance is already
        // serving the port, so reuse it without owning its process.
        reusingExternalInstance = true
        setStatus({
          state: 'running',
          pid: null,
          lastError: undefined,
        })
        resolveReady()
        return
      }

      if (message.includes(BRAIN_LISTENING_MARKER)) {
        setStatus({
          state: 'running',
          pid: processHandle.pid ?? null,
          lastError: undefined,
        })
        resolveReady()
      }
    })
    pipeProcessLog(processHandle.stderr, message => log.warn(message))

    processHandle.on('error', (error) => {
      if (currentProcess !== processHandle) {
        log.withError(error).debug('ignored stale brain process error')
        return
      }

      const message = errorMessageFrom(error) ?? 'Failed to spawn the Claude Code brain process.'
      setStatus({
        state: 'error',
        pid: processHandle.pid ?? null,
        lastError: message,
      })
      rejectReady(error)
    })

    processHandle.on('close', (code, signal) => {
      if (currentProcess !== processHandle) {
        log.withFields({
          code,
          pid: processHandle.pid ?? null,
          signal,
        }).debug('ignored stale brain process close')
        return
      }

      clearProcessState()

      if (reusingExternalInstance) {
        // The brain exited 0 because another instance was already serving the
        // port. That instance is still up, so keep reporting 'running'.
        reusingExternalInstance = false
        expectedProcessExit = false
        resolveReady()
        return
      }

      if (expectedProcessExit) {
        expectedProcessExit = false
        setStatus({
          state: 'stopped',
          pid: null,
          lastError: undefined,
        })
        resolveReady()
        return
      }

      const exitMessage = signal
        ? `Claude Code brain exited with signal ${signal}.`
        : `Claude Code brain exited with code ${code ?? 0}.`
      setStatus({
        state: 'error',
        pid: null,
        lastError: exitMessage,
      })
      rejectReady(new Error(exitMessage))
    })
  }

  return {
    subscribe(callback) {
      const unsubscribe = statusListeners.subscribe(callback)
      callback(currentStatus)
      return unsubscribe
    },
    getStatus() {
      return currentStatus
    },
    async start(port: number = DEFAULT_BRAIN_PORT) {
      return await lifecycleMutex.runExclusive(async () => {
        try {
          if (currentProcess && currentStatus.state === 'running' && currentStatus.port === port) {
            return currentStatus
          }

          // Retry or rebind: release whatever a previous attempt left behind.
          if (currentProcess) {
            await stopProcessInternal()
          }

          if (currentProcess) {
            throw new Error('Previous brain process is still shutting down. Retry after it exits.')
          }

          const projectRoot = await resolveBrainProjectRoot()
          const readyDeferred = createDeferred<void>()
          const readyTimeout = setTimeout(() => {
            readyDeferred.reject(new Error('Claude Code brain did not report listening in time.'))
          }, READY_TIMEOUT_MS)

          currentReady = readyDeferred
          reusingExternalInstance = false
          setStatus({
            state: 'starting',
            port,
            pid: null,
            lastError: undefined,
          })

          log.withFields({ cwd: projectRoot, port }).log('spawning claude-code-brain')

          // Windows needs the .cmd shim; POSIX resolves `npx` directly.
          const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'
          const processHandle = spawn(
            npxCommand,
            ['tsx', '--env-file-if-exists', '.env', 'src/index.ts'],
            {
              cwd: projectRoot,
              env: {
                ...process.env,
                CLAUDE_BRAIN_PORT: String(port),
                // Electron owns the child's stdin, so the interactive egress
                // confirmation could never be answered; the user pins exit IPs
                // in services/claude-code-brain/.env instead.
                CLAUDE_BRAIN_EGRESS_CHECK: '0',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            },
          )

          currentProcess = processHandle
          attachProcessListeners(processHandle)

          setStatus({
            state: 'starting',
            port,
            pid: processHandle.pid ?? null,
            lastError: undefined,
          })

          try {
            await readyDeferred.promise
          }
          finally {
            if (currentReady === readyDeferred)
              currentReady = undefined
            clearTimeout(readyTimeout)
          }

          return currentStatus
        }
        catch (error) {
          if (currentProcess) {
            await stopProcessInternal()
          }
          setStatus({
            state: 'error',
            lastError: errorMessageFrom(error) ?? 'Failed to start the Claude Code brain.',
          })
          throw error
        }
      })
    },
    async stop() {
      return await lifecycleMutex.runExclusive(async () => {
        try {
          await stopProcessInternal()
        }
        catch (error) {
          setStatus({
            state: 'error',
            pid: null,
            lastError: errorMessageFrom(error) ?? 'Failed to stop the Claude Code brain.',
          })
          throw error
        }

        // The close handler already moved the state to 'stopped'; only reach
        // here directly when nothing was owned (e.g. reusing an external
        // instance or already stopped).
        if (currentStatus.state !== 'stopped') {
          setStatus({
            state: 'stopped',
            pid: null,
            lastError: undefined,
          })
        }

        return currentStatus
      })
    },
  }
}

/**
 * Creates and wires the shared brain manager into app lifecycle hooks.
 *
 * Stops the brain child process when the app quits.
 */
export function setupBrainManager() {
  const manager = createBrainManager()

  onAppBeforeQuit(async () => {
    await manager.stop()
  })

  return manager
}

/**
 * Registers Claude Code brain invoke handlers for one Electron window context.
 *
 * Call stack:
 *
 * createBrainService
 *   -> renderer invoke/eventa handlers
 *     -> {@link BrainManager}
 */
export function createBrainService(params: {
  context: MainContext
  manager: BrainManager
  window: BrowserWindow
}) {
  const unsubscribe = params.manager.subscribe((status) => {
    if (!params.window.isDestroyed()) {
      params.context.emit(electronBrainStatusChanged, status)
    }
  })

  const cleanups: Array<() => void> = [
    unsubscribe,
    defineInvokeHandler(params.context, electronBrainStart, payload => params.manager.start(payload?.port)),
    defineInvokeHandler(params.context, electronBrainStop, () => params.manager.stop()),
    defineInvokeHandler(params.context, electronBrainGetStatus, () => params.manager.getStatus()),
  ]

  const cleanup = () => {
    for (const fn of cleanups) {
      fn()
    }
  }

  params.window.on('closed', cleanup)
  return cleanup
}
