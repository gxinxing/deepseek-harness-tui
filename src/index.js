/**
 * dsh-tui — interactive terminal chat for the DeepSeek Harness. Cordis bundle
 * plugin (package `dsh-tui`), composed over dsh-base + dsh-headless; the patch
 * disables the headless one-shot rows and inserts this runner. Drives the core
 * Agent exactly like the headless runner, but streams session events into an
 * Ink chat UI instead of printing a single answer.
 */

import { randomUUID } from 'node:crypto'
import React from 'react'
import { probeTerminalBg } from './theme.js'
import { render } from 'ink'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { App } from './ui.js'

/** Stable Cordis plugin name (bundle row id: tui-runner). */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/**
 * Bridge between the Cordis event bus (non-React) and the Ink tree. The App
 * installs its event consumer by calling the `onEvent` prop with a function
 * once mounted; every matching `session/event` is then forwarded to it.
 * Events are dropped until the App mounts.
 */
let uiHandler = undefined
function forward(eventOrHandler) {
  if (typeof eventOrHandler === 'function' || eventOrHandler == null) {
    uiHandler = typeof eventOrHandler === 'function' ? eventOrHandler : undefined
    return
  }
  if (typeof uiHandler === 'function') uiHandler(eventOrHandler)
}

/**
 * Mount the interactive chat driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit.
 */
export function apply(ctx) {

  // appExit is an optional host value provided by the launcher — read it
  // through the global service store, never the property proxy.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  void run(ctx, exit).catch((error) => {
    console.error(`dsh-tui: ${error instanceof Error ? error.message : String(error)}`)
    exit(1)
  })
}

/** Create the agent and run the chat until the user quits. */
async function run(ctx, exit) {
  // Probe the terminal background BEFORE Ink mounts: Ink's key parser would
  // otherwise read the OSC 11 response as keystrokes and type garbage.
  const themeBg = await probeTerminalBg()

  // Loader siblings mount concurrently; await the complete composition before
  // creating an Agent so its scoped tools are not half-composed.
  await ctx.get('loader')?.await()

  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  // Create the agent exactly like the headless runner does.
  const selection = defaultModel.currentSelection()
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()
  // Events below this seq are construction seed history, not chat.
  const firstSeq = agent.session.seq

  // Debounced durability flush while a turn is running: a long or stuck turn
  // must be inspectable on disk without waiting for turn/end. The immediate
  // turn/end flush below remains the boundary checkpoint.
  let flushTimer = undefined
  let flushing = false
  const scheduleFlush = () => {
    if (flushTimer !== undefined || flushing) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushing = true
      sessions
        .flush(agent.session)
        .catch((error) => {
          console.error(`dsh-tui: session flush failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          flushing = false
        })
    }, 5000)
  }

  // Live append feed: forward this session's events to the UI and persist the
  // log at each turn boundary (fire-and-forget; flush is caller-owned).
  ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    if (event.seq >= firstSeq) {
      if (event.type === 'turn/end') {
        void sessions.flush(agent.session).catch((error) => {
          console.error(`dsh-tui: session flush failed: ${error instanceof Error ? error.message : String(error)}`)
        })
      } else if (event.type === 'turn/start' || event.type === 'tool/call' || event.type === 'tool/result') {
        scheduleFlush()
      }
    }
    forward(event)
  })

  let app
  let exited = false
  const onExit = () => {
    if (exited) return
    exited = true
    // Final durability checkpoint before the harness exits.
    void sessions.flush(agent.session).catch(() => {})
    if (app) {
      try {
        app.unmount()
      } catch {
        // The App already unmounted itself via useApp().exit().
      }
    }
    // The launcher's graceful path only sets process.exitCode and relies on
    // the event loop draining; file watchers can keep it alive after the UI
    // unmounts, so watchdog the process to release the terminal promptly.
    exit(0)
    setTimeout(() => {
      try {
        process.exit(0)
      } catch {
        // The process already exited via the graceful path.
      }
    }, 2000)
  }

  // exitOnCtrlC: false — the App owns Ctrl-C so it can exit the harness cleanly.
  app = render(
    React.createElement(App, {
      agent,
      onEvent: forward,
      onExit,
      onInterrupt: () => agent.cancel({ kind: 'user' }),
      firstSeq,
      model: selection.model,
      themeBg,
    }),
    { exitOnCtrlC: false },
  )
}
