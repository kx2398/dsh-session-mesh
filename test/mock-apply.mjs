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
  const resolveCalls = []
  const goalState = new Map()
  const goalEvents = new Map()
  const transcriptEvents = new Map()
  let eventSeq = 0
  let goalCounter = 0
  const liveAgents = new Map()
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
  liveAgents.set('session-a', agent)

  function appendGoalEvent(sessionId, operation, goal) {
    const events = goalEvents.get(sessionId) ?? []
    events.push({
      seq: ++eventSeq,
      time: 1700000000000 + eventSeq,
      type: 'goal/change',
      data: operation === 'clear'
        ? { kind: 'goal/change', version: 1, operation, cleared: goal, clearedAt: Date.now() }
        : {
            kind: 'goal/change',
            version: 1,
            operation,
            goal: {
              id: goal.id,
              revision: goal.revision,
              objective: goal.objective,
              phase: goal.phase,
              maxGoalRounds: goal.maxGoalRounds,
            },
            roundsStarted: goal.roundsStarted,
            createdAt: goal.createdAt,
            updatedAt: goal.updatedAt,
          },
    })
    goalEvents.set(sessionId, events)
  }

  function appendTranscriptEvent(sessionId, event) {
    const events = transcriptEvents.get(sessionId) ?? []
    events.push({ seq: ++eventSeq, time: 1700000000000 + eventSeq, ...event })
    transcriptEvents.set(sessionId, events)
  }

  function transitionGoal(targetAgent, ref, phase, operation) {
    const current = goalState.get(targetAgent.id)
    if (current === undefined || current.id !== ref.id || current.revision !== ref.revision) {
      throw Object.assign(new Error('stale goal revision'), { code: 'GOAL_STALE_REVISION' })
    }
    const next = { ...current, revision: current.revision + 1, phase, updatedAt: current.updatedAt + 1 }
    goalState.set(targetAgent.id, next)
    appendGoalEvent(targetAgent.id, operation, next)
    return next
  }

  const goalService = {
    get(targetAgent) {
      return goalState.get(targetAgent.id)
    },
    create(targetAgent, request) {
      const existing = goalState.get(targetAgent.id)
      if (existing !== undefined && existing.phase !== 'complete') {
        throw Object.assign(new Error('a non-complete goal already exists'), { code: 'GOAL_ALREADY_EXISTS' })
      }
      goalCounter += 1
      const goal = {
        id: `goal-${goalCounter}`,
        revision: 1,
        objective: request.objective,
        phase: 'active',
        maxGoalRounds: request.maxGoalRounds ?? 256,
        roundsStarted: 0,
        createdAt: 1000 + goalCounter,
        updatedAt: 1000 + goalCounter,
        activation: 'armed',
      }
      goalState.set(targetAgent.id, goal)
      appendGoalEvent(targetAgent.id, 'create', goal)
      return goal
    },
    edit(targetAgent, ref, request) {
      const current = goalState.get(targetAgent.id)
      if (current === undefined || current.id !== ref.id || current.revision !== ref.revision) {
        throw Object.assign(new Error('stale goal revision'), { code: 'GOAL_STALE_REVISION' })
      }
      const next = {
        ...current,
        revision: current.revision + 1,
        ...request.objective === undefined ? {} : { objective: request.objective },
        ...request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds },
        updatedAt: current.updatedAt + 1,
      }
      goalState.set(targetAgent.id, next)
      appendGoalEvent(targetAgent.id, 'edit', next)
      return next
    },
    pause(targetAgent, ref) {
      return transitionGoal(targetAgent, ref, 'paused', 'pause')
    },
    resume(targetAgent, ref) {
      return transitionGoal(targetAgent, ref, 'active', 'resume')
    },
    complete(targetAgent, ref) {
      return transitionGoal(targetAgent, ref, 'complete', 'complete')
    },
    clear(targetAgent, ref) {
      const current = goalState.get(targetAgent.id)
      if (current === undefined || current.id !== ref.id || current.revision !== ref.revision) {
        throw Object.assign(new Error('stale goal revision'), { code: 'GOAL_STALE_REVISION' })
      }
      goalState.delete(targetAgent.id)
      appendGoalEvent(targetAgent.id, 'clear', { id: ref.id, revision: ref.revision + 1 })
      return { id: ref.id, revision: ref.revision + 1 }
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      return name === 'goals' ? goalService : undefined
    },
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
    agents: {
      list: () => [agent],
      get: (id) => liveAgents.get(id),
    },
    sessionController: {
      async list() {
        return { items: structuredClone(state.listItems) }
      },
      async inspect(sessionId) {
        const merged = [
          ...(goalEvents.get(sessionId) ?? []),
          ...(transcriptEvents.get(sessionId) ?? []),
        ].sort((left, right) => left.seq - right.seq)
        return { events: structuredClone(merged) }
      },
      async resolveAgent(sessionId) {
        resolveCalls.push(sessionId)
        const existing = liveAgents.get(sessionId)
        const target = existing ?? {
          id: sessionId,
          followup(message) {
            delivered.push({ sessionId, kind: 'followup', message })
          },
          steer(message) {
            delivered.push({ sessionId, kind: 'steer', message })
          },
        }
        liveAgents.set(sessionId, target)
        return { agent: target }
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
      async readSession(sessionId) {
        const merged = [
          ...(goalEvents.get(sessionId) ?? []),
          ...(transcriptEvents.get(sessionId) ?? []),
        ].sort((left, right) => left.seq - right.seq)
        return { session: { id: sessionId }, inheritedEventCount: 0, events: structuredClone(merged) }
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
    resolveCalls,
    goalState,
    goalEvents,
    transcriptEvents,
    appendTranscriptEvent,
    goalService,
    liveAgents,
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
    maxSendsPerMinute: 6,
    failOnWarnings: false,
  })

  await check('registers 14 tools', () => assert.equal(harness.tools.size, 14))
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
  const getGoalTool = harness.tools.get('mesh_get_goal')
  const setGoalTool = harness.tools.get('mesh_set_goal')
  const updateGoalTool = harness.tools.get('mesh_update_goal')
  const clearGoalTool = harness.tools.get('mesh_clear_goal')
  const startGoalTool = harness.tools.get('mesh_start_goal')
  const stopGoalTool = harness.tools.get('mesh_stop_goal')
  const readSessionTool = harness.tools.get('mesh_read_session')

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

  await check('now mode delivers immediately via steer', async () => {
    const result = JSON.parse(await sendTool.execute({ target: 'session-b', message: 'now please', mode: 'now' }, exec()))
    assert.equal(result.mode, 'now')
    const delivery = harness.delivered.at(-1)
    assert.equal(delivery.kind, 'steer')
    assert.equal(delivery.message.source.kind, 'agent-message')
  })

  await check('legacy steer alias maps to now', async () => {
    const result = JSON.parse(await sendTool.execute({ target: 'session-b', message: 'alias now', mode: 'steer' }, exec()))
    assert.equal(result.mode, 'now')
    assert.equal(harness.delivered.at(-1).kind, 'steer')
  })

  await check('immediate delivery can be disabled', async () => {
    const disabled = createHarness()
    apply(disabled.ctx, { allowImmediate: false })
    await assert.rejects(
      disabled.tools.get('mesh_send_message').execute({ target: 'session-b', message: 'blocked now', mode: 'now' }, execFor(disabled)),
      /immediate delivery is disabled/,
    )
  })

  await check('self target rejected', async () => {
    await assert.rejects(
      sendTool.execute({ target: 'session-a', message: 'self' }, exec()),
      /cannot target the calling session itself/,
    )
  })

  await check('rate limit enforced', async () => {
    // maxSendsPerMinute = 6; three sends already consumed (hello + now + alias).
    await sendTool.execute({ target: 'session-b', message: 'rate-1' }, exec())
    await sendTool.execute({ target: 'session-b', message: 'rate-2' }, exec())
    await sendTool.execute({ target: 'session-b', message: 'rate-3' }, exec())
    await assert.rejects(
      sendTool.execute({ target: 'session-b', message: 'rate-4' }, exec()),
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

  await check('goal read of a cold session returns null without waking it', async () => {
    const before = harness.resolveCalls.length
    const result = JSON.parse(await getGoalTool.execute({ target: 'session-c' }, exec()))
    assert.equal(result.goal, null)
    assert.equal(result.live, false)
    assert.equal(harness.resolveCalls.length, before, 'goal reads must not resume the target')
  })

  await check('goal create then edit with expected revision', async () => {
    const created = JSON.parse(await setGoalTool.execute({ target: 'session-b', objective: 'ship v0.3', max_goal_rounds: 12 }, exec()))
    assert.equal(created.action, 'created')
    assert.equal(created.goal.phase, 'active')
    assert.equal(created.goal.objective, 'ship v0.3')
    assert.equal(created.goal.maxGoalRounds, 12)
    const edited = JSON.parse(await setGoalTool.execute({
      target: 'session-b',
      objective: 'ship v0.3.1',
      expected_revision: created.goal.revision,
    }, exec()))
    assert.equal(edited.action, 'edited')
    assert.equal(edited.goal.revision, created.goal.revision + 1)
    assert.equal(edited.goal.objective, 'ship v0.3.1')
    const read = JSON.parse(await getGoalTool.execute({ target: 'session-b' }, exec()))
    assert.equal(read.goal.revision, edited.goal.revision)
    assert.equal(read.goal.phase, 'active')
  })

  await check('goal pause, resume and complete', async () => {
    const paused = JSON.parse(await updateGoalTool.execute({
      target: 'session-b', action: 'pause', expected_revision: 2,
    }, exec()))
    assert.equal(paused.goal.phase, 'paused')
    const resumed = JSON.parse(await updateGoalTool.execute({
      target: 'session-b', action: 'resume', expected_revision: paused.goal.revision,
    }, exec()))
    assert.equal(resumed.goal.phase, 'active')
    const completed = JSON.parse(await updateGoalTool.execute({
      target: 'session-b', action: 'complete', expected_revision: resumed.goal.revision,
    }, exec()))
    assert.equal(completed.goal.phase, 'complete')
  })

  await check('set replaces a completed goal', async () => {
    const replaced = JSON.parse(await setGoalTool.execute({ target: 'session-b', objective: 'next objective' }, exec()))
    assert.equal(replaced.action, 'created')
    assert.notEqual(replaced.goal.id, 'goal-1')
    assert.equal(replaced.goal.phase, 'active')
  })

  await check('stale revision is rejected', async () => {
    await assert.rejects(
      updateGoalTool.execute({ target: 'session-b', action: 'pause', expected_revision: 99 }, exec()),
      /stale goal revision/,
    )
  })

  await check('clear removes the goal', async () => {
    const current = JSON.parse(await getGoalTool.execute({ target: 'session-b' }, exec()))
    const cleared = JSON.parse(await clearGoalTool.execute({
      target: 'session-b', expected_revision: current.goal.revision,
    }, exec()))
    assert.equal(cleared.cleared, true)
    const after = JSON.parse(await getGoalTool.execute({ target: 'session-b' }, exec()))
    assert.equal(after.goal, null)
  })

  await check('goal mutations respect allowGoal', async () => {
    const disabled = createHarness()
    apply(disabled.ctx, { allowGoal: false })
    await assert.rejects(
      disabled.tools.get('mesh_set_goal').execute({ target: 'session-b', objective: 'x' }, execFor(disabled)),
      /goal management is disabled/,
    )
  })

  await check('missing goal service is reported', async () => {
    const noGoals = createHarness({ ctx: { get: () => undefined } })
    apply(noGoals.ctx, {})
    await assert.rejects(
      noGoals.tools.get('mesh_set_goal').execute({ target: 'session-b', objective: 'x' }, execFor(noGoals)),
      /goal service is not available/,
    )
  })

  await check('start/stop drive a goal lifecycle', async () => {
    const started = JSON.parse(await startGoalTool.execute({ target: 'session-c', objective: 'started goal' }, exec()))
    assert.equal(started.action, 'created')
    const stopped = JSON.parse(await stopGoalTool.execute({ target: 'session-c', expected_revision: started.goal.revision }, exec()))
    assert.equal(stopped.action, 'paused')
    assert.equal(stopped.goal.phase, 'paused')
    const again = JSON.parse(await stopGoalTool.execute({ target: 'session-c', expected_revision: stopped.goal.revision }, exec()))
    assert.equal(again.action, 'already-stopped')
    const restarted = JSON.parse(await startGoalTool.execute({ target: 'session-c', expected_revision: again.goal.revision }, exec()))
    assert.equal(restarted.action, 'resumed')
    assert.equal(restarted.goal.phase, 'active')
    const noop = JSON.parse(await startGoalTool.execute({ target: 'session-c', expected_revision: restarted.goal.revision }, exec()))
    assert.equal(noop.action, 'already-active')
    await clearGoalTool.execute({ target: 'session-c', expected_revision: noop.goal.revision }, exec())
  })

  await check('read transcript summarizes human/assistant/tool/peer entries', async () => {
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'human asks about the build' }], source: { kind: 'user' } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'runtime context noise' }], source: { kind: 'runtime-context' } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'skill catalog noise' }], source: { kind: 'skill-catalog' } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'time context noise' }], source: { kind: 'time-context' } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'assistant reply' }] } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'tool/call',
      data: { turn: 1, step: 1, callId: 'call-1', name: 'grep', arguments: '{"pattern":"build"}' },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'tool/result',
      data: { turn: 1, step: 1, toolCallId: 'call-1', message: { role: 'tool', content: [{ type: 'text', text: 'grep result text' }] } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'peer asks for status' }], source: { kind: 'agent-message', senderSessionId: 'session-a' } },
    })
    const before = harness.resolveCalls.length
    const page = JSON.parse(await readSessionTool.execute({ target: 'session-b', limit: 3 }, exec()))
    assert.equal(page.total, 4)
    assert.equal(page.returned, 3)
    assert.deepEqual(page.entries.map((entry) => entry.role), ['assistant', 'tool', 'user'])
    assert.equal(page.entries[0].text, 'assistant reply')
    assert.equal(page.entries[1].name, 'grep')
    assert.equal(page.entries[1].result, 'grep result text')
    assert.equal(page.entries[2].source, 'peer')
    assert.equal(harness.resolveCalls.length, before, 'transcript reads must not wake the target')
    const noTools = JSON.parse(await readSessionTool.execute({ target: 'session-b', limit: 2, include_tools: false }, exec()))
    assert.deepEqual(noTools.entries.map((entry) => entry.role), ['assistant', 'user'])
    assert.ok(noTools.entries.every((entry) => entry.role !== 'tool'))
  })

  await check('readSessionEvents falls back to inspect when readSession is absent', async () => {
    const legacy = createHarness()
    legacy.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'legacy fallback works' }], source: { kind: 'user' } },
    })
    delete legacy.ctx.sessionQuery.readSession
    apply(legacy.ctx, {})
    const page = JSON.parse(await legacy.tools.get('mesh_read_session').execute({ target: 'session-b', limit: 1 }, execFor(legacy)))
    assert.equal(page.entries.length, 1)
    assert.equal(page.entries[0].text, 'legacy fallback works')
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
