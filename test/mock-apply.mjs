/**
 * Offline mock-host test for the Session Mesh plugin.
 *
 * Boots `apply()` against a fake Cordis context and exercises every tool plus
 * the prompt registrations. No DSH host is involved, so this catches undefined
 * helpers and tool-flow bugs before a live reload.
 *
 * Run: node test/mock-apply.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const WS_TEST = { id: 'ws-test', title: 'test', path: 'C:\\Users\\tester\\workspace\\test' }
const WS_OTHER = { id: 'ws-other', title: 'other', path: 'C:\\Users\\tester\\workspace\\other' }
WS_TEST.sessionIds = ['session-a', 'session-c', 'session-new']
WS_OTHER.sessionIds = ['session-b']

function createHarness(overrides = {}) {
  const state = {
    archived: ['session-c'],
    renameError: null,
    listItems: [
      { sessionId: 'session-a', cwd: WS_TEST.path, running: true, updatedAt: 3000, blank: false, agentAvailable: true },
      { sessionId: 'session-b', cwd: WS_OTHER.path, running: false, updatedAt: 2000, blank: true, agentAvailable: false },
      { sessionId: 'session-c', cwd: WS_TEST.path, running: false, updatedAt: 1000, blank: false, agentAvailable: true },
    ],
  }
  const tools = new Map()
  const sections = []
  const contexts = []
  const listeners = new Map()
  const delivered = []
  const promptCalls = []
  const createRequests = []
  const agent = {
    id: 'session-a',
    session: { header: { cwd: WS_TEST.path } },
    ctx: {
      systemPrompt: {
        context(definition) {
          contexts.push(definition)
          return () => {}
        },
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    effect(run) {
      const dispose = run()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, listener) {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      context(definition) {
        contexts.push(definition)
        return () => {}
      },
    },
    agents: { list: () => [agent] },
    sessionController: {
      async list() {
        return { items: structuredClone(state.listItems) }
      },
      async resolveAgent(sessionId) {
        return {
          agent: {
            id: sessionId,
            followup(message) {
              delivered.push({ sessionId, kind: 'followup', message })
            },
            steer(message) {
              delivered.push({ sessionId, kind: 'steer', message })
            },
          },
        }
      },
      async create(request) {
        createRequests.push(request)
        return { sessionId: 'session-new' }
      },
      async prompt(request) {
        promptCalls.push(request)
      },
      async rename(request) {
        if (state.renameError !== null) throw state.renameError
        return { title: request.title, seq: 7 }
      },
      async cancel() {
        return { accepted: true }
      },
    },
    workspaceRegistry: {
      list: () => [WS_TEST, WS_OTHER],
      get archivedSessionIds() {
        return state.archived
      },
      async archiveSession(sessionId, options) {
        if (sessionId === 'session-a' && options?.stopActivity !== true) {
          const error = new Error('session is active')
          error.activity = [{ kind: 'turn', items: [{ id: 'turn-1' }, { id: 'turn-2' }] }]
          throw error
        }
        state.archived.push(sessionId)
      },
      async unarchiveSession(sessionId) {
        state.archived = state.archived.filter((id) => id !== sessionId)
      },
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map((id) => ({ status: 'fulfilled', value: { title: { title: `title-${id}` } } }))
      },
    },
    sessionTitle: {
      get(session) {
        return { title: `live-${session?.header ? 'x' : 'x'}-${agent.id}` }
      },
    },
    ...overrides.ctx,
  }
  return {
    ctx,
    tools,
    sections,
    contexts,
    listeners,
    delivered,
    promptCalls,
    createRequests,
    state,
    agent,
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
  }
}

function execFor(harness) {
  const controller = new AbortController()
  return { agent: harness.agent, signal: controller.signal, controller }
}

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`PASS ${name}`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error?.message ?? error}`)
    throw error
  }
}

async function main() {
  const harness = createHarness()
  apply(harness.ctx, {
    defaultMode: 'queue',
    policy: 'short',
    maxSendsPerMinute: 3,
    failOnWarnings: false,
  })

  await check('registers 7 tools', () => assert.equal(harness.tools.size, 7))
  await check('registers policy section', () => assert.equal(harness.sections.length, 1))
  await check('registers identity context', () => assert.equal(harness.contexts.length, 1))
  await check('identity text renders', () => {
    const text = harness.contexts[0].text()
    assert.match(text, /You are session "live-x-session-a"/)
    assert.match(text, /in workspace "test"/)
  })

  const exec = () => execFor(harness)
  const listTool = harness.tools.get('mesh_list_sessions')
  const sendTool = harness.tools.get('mesh_send_message')
  const createTool = harness.tools.get('mesh_create_session')
  const renameTool = harness.tools.get('mesh_rename_session')
  const archiveTool = harness.tools.get('mesh_archive_session')
  const cancelTool = harness.tools.get('mesh_cancel_session')
  const waitTool = harness.tools.get('mesh_wait_for_change')

  await check('list excludes archived and paginates', async () => {
    const page = JSON.parse(await listTool.execute({ limit: 1 }, exec()))
    assert.equal(page.total, 2)
    assert.equal(page.returned, 1)
    assert.ok(page.nextCursor, 'expected nextCursor')
    assert.equal(page.sessions[0].sessionId, 'session-a')
    const second = JSON.parse(await listTool.execute({ limit: 1, cursor: page.nextCursor }, exec()))
    assert.equal(second.sessions[0].sessionId, 'session-b')
  })

  await check('list filters by workspace and archive flag', async () => {
    const other = JSON.parse(await listTool.execute({ workspace: 'other' }, exec()))
    assert.equal(other.total, 1)
    assert.equal(other.sessions[0].workspaceTitle, 'other')
    const all = JSON.parse(await listTool.execute({ include_archived: true }, exec()))
    assert.equal(all.total, 3)
  })

  await check('send delivers an agent-message', async () => {
    const result = JSON.parse(await sendTool.execute({ target: 'session-b', message: 'hello peer' }, exec()))
    assert.equal(result.sent, true)
    assert.equal(result.senderSource, 'agent-message/relay')
    assert.equal(harness.delivered.length, 1)
    const delivery = harness.delivered[0]
    assert.equal(delivery.kind, 'followup')
    assert.equal(delivery.message.role, 'user')
    assert.equal(delivery.message.source.kind, 'agent-message')
    assert.equal(delivery.message.source.senderSessionId, 'session-a')
    assert.match(delivery.message.content[0].text, /^\[mesh\] Message from session/)
    assert.match(delivery.message.content[0].text, /"title-session-a"/, 'sender title should be resolved, not "(untitled)"')
    assert.equal(result.targetTitle, 'title-session-b', 'target title should be resolved')
    assert.ok(Object.isFrozen(delivery.message), 'message should be frozen')
  })

  await check('duplicate send is suppressed', async () => {
    await assert.rejects(
      sendTool.execute({ target: 'session-b', message: 'hello peer' }, exec()),
      /duplicate message suppressed/,
    )
  })

  await check('steer is disabled by default', async () => {
    await assert.rejects(
      sendTool.execute({ target: 'session-b', message: 'steer please', mode: 'steer' }, exec()),
      /steer delivery is disabled/,
    )
  })

  await check('self target rejected', async () => {
    await assert.rejects(
      sendTool.execute({ target: 'session-a', message: 'self' }, exec()),
      /cannot target the calling session itself/,
    )
  })

  await check('rate limit enforced', async () => {
    // maxSendsPerMinute = 3; two sends already consumed (hello + duplicate bypass? duplicate does not consume).
    await sendTool.execute({ target: 'session-b', message: 'rate-1' }, exec())
    await sendTool.execute({ target: 'session-b', message: 'rate-2' }, exec())
    await assert.rejects(
      sendTool.execute({ target: 'session-b', message: 'rate-3' }, exec()),
      /send rate limit reached/,
    )
  })

  await check('archived target rejected', async () => {
    harness.state.archived = ['session-c']
    await assert.rejects(
      sendTool.execute({ target: 'session-c', message: 'to archived' }, exec()),
      /is archived/,
    )
    harness.state.archived = []
  })

  await check('create defaults to caller workspace', async () => {
    const result = JSON.parse(await createTool.execute({ title: 'new task', prompt: 'do it' }, exec()))
    assert.equal(result.created, true)
    assert.equal(result.sessionId, 'session-new')
    assert.equal(result.workspaceId, 'ws-test')
    assert.equal(harness.createRequests[0].workspaceId, 'ws-test')
    assert.equal(result.promptQueued, true)
    assert.equal(harness.promptCalls[0].sessionId, 'session-new')
  })

  await check('create reports rename warnings', async () => {
    harness.state.renameError = new Error('title store disabled')
    const result = JSON.parse(await createTool.execute({ title: 'warned' }, exec()))
    assert.equal(result.title, null)
    assert.ok(Array.isArray(result.warnings) && result.warnings.length === 1)
    harness.state.renameError = null
  })

  await check('rename works', async () => {
    const result = JSON.parse(await renameTool.execute({ target: 'session-b', title: 'renamed' }, exec()))
    assert.equal(result.renamed, true)
    assert.equal(result.title, 'renamed')
  })

  await check('archive running session explains activity', async () => {
    await assert.rejects(
      archiveTool.execute({ target: 'session-a' }, exec()),
      /still has running work \(turn × 2\)/,
    )
  })

  await check('archive with stop_activity then unarchive', async () => {
    const archived = JSON.parse(await archiveTool.execute({ target: 'session-a', stop_activity: true }, exec()))
    assert.equal(archived.archived, true)
    const restored = JSON.parse(await archiveTool.execute({ target: 'session-a', action: 'unarchive' }, exec()))
    assert.equal(restored.archived, false)
  })

  await check('cancel rejects self and accepts peer', async () => {
    await assert.rejects(
      cancelTool.execute({ target: 'session-a' }, exec()),
      /cannot target the calling session itself/,
    )
    const result = JSON.parse(await cancelTool.execute({ target: 'session-b' }, exec()))
    assert.equal(result.cancelled, true)
  })

  await check('wait resolves on a peer status change', async () => {
    const waiting = waitTool.execute({ timeout_ms: 5000 }, exec())
    setTimeout(() => {
      harness.emit('api-session/status', 'session-a', false) // ignored: own session
      harness.emit('api-session/status', 'session-b', true)
    }, 10)
    const result = JSON.parse(await waiting)
    assert.equal(result.timedOut, false)
    assert.equal(result.change.type, 'status')
    assert.equal(result.change.sessionId, 'session-b')
  })

  await check('wait times out', async () => {
    const started = Date.now()
    const result = JSON.parse(await waitTool.execute({ timeout_ms: 1000 }, exec()))
    assert.equal(result.timedOut, true)
    assert.ok(Date.now() - started >= 900)
  })

  await check('policy off disables the section', () => {
    const second = createHarness()
    apply(second.ctx, { policy: 'off', identityContext: false })
    assert.equal(second.sections.length, 0)
    assert.equal(second.contexts.length, 0)
  })

  for (const line of results) console.log(line)
  console.log(`\n${results.length} checks passed`)
}

main().catch((error) => {
  for (const line of results) console.log(line)
  console.error('\nMOCK TEST FAILED:', error)
  process.exit(1)
})
