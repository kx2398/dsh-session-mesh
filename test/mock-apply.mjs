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

/** Live model catalog served by the mock session controller. */
const MODEL_CATALOG = {
  default: { provider: 'prov-a', model: 'model-a' },
  routableProviders: ['prov-a', 'prov-b'],
  groups: [
    {
      id: 'prov-a',
      name: 'Provider A',
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
        },
        { id: 'model-b', name: 'Model B' },
      ],
    },
    { id: 'prov-b', name: 'Provider B', models: [{ id: 'model-c', name: 'Model C' }] },
  ],
  failures: [],
}

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
  const teamEnabled = new Map()
  const teamSetCalls = []
  const permissionCurrent = new Map([['session-a', 'workspace-write']])
  const permissionCalls = []
  const sandboxOverrides = new Map()
  const permissionSpecs = {
    'read-only': { sandbox: 'read-only', approval: 'ask', name: '仅可查看' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask', name: '工作区内修改' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never', name: '完全权限' },
    auto: { sandbox: 'danger-full-access', approval: 'ask', name: '自动审查EXP' },
  }
  const permissionService = {
    catalog() {
      return {
        options: Object.entries(permissionSpecs).map(([value, spec]) => ({ value, name: spec.name })),
        defaultOptions: Object.entries(permissionSpecs).map(([value, spec]) => ({ value, name: spec.name })),
        defaultPreset: 'workspace-write',
      }
    },
    current(session) {
      return permissionCurrent.get(session?.header?.sessionId) ?? 'workspace-write'
    },
    resolve(name) {
      const spec = permissionSpecs[name]
      if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`)
      return spec
    },
    set(session, name) {
      this.resolve(name)
      const sessionId = session?.header?.sessionId
      permissionCalls.push({ sessionId, name })
      permissionCurrent.set(sessionId, name)
      sandboxOverrides.set(sessionId, permissionSpecs[name].sandbox)
    },
  }
  let eventSeq = 0
  let goalCounter = 0
  const liveAgents = new Map()
  const selectedModels = new Map()
  let callerSelection = { provider: 'prov-a', model: 'model-a' }
  const agent = {
    id: 'session-a',
    session: { header: { sessionId: 'session-a', cwd: WS_TEST.path } },
    model: {
      current: () => ({ ...callerSelection }),
      select(next) {
        callerSelection = { ...next }
      },
    },
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

  const teamService = {
    isEnabled(targetAgent) {
      return teamEnabled.get(targetAgent.id) === true
    },
    async setEnabled(targetAgent, enabled) {
      teamSetCalls.push({ sessionId: targetAgent.id, enabled })
      teamEnabled.set(targetAgent.id, enabled)
    },
  }

  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'goals') return goalService
      if (name === 'agentTeams') return teamService
      if (name === 'permissionPresets') return permissionService
      if (name === 'sandboxPolicy') {
        return {
          defaultMode: 'workspace-write',
          overrideOf(session) {
            return sandboxOverrides.get(session?.header?.sessionId)
          },
        }
      }
      if (name === 'approval') {
        return {
          config: { policy: 'ask' },
          overrideOf() {
            return undefined
          },
        }
      }
      if (name === 'sessions') {
        return {
          get(id) {
            return liveAgents.get(id)?.session
          },
          async flush() {},
        }
      }
      if (name === 'llm') {
        return {
          async resolveCallConfig(selection) {
            const group = MODEL_CATALOG.groups.find((candidate) => candidate.id === selection.provider)
            if (group === undefined || !group.models.some((model) => model.id === selection.model)) {
              throw new Error(`model ${selection.provider}/${selection.model} is not routable`)
            }
            return selection
          },
        }
      }
      return undefined
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
          model: {
            current: () => selectedModels.get(sessionId) ?? { ...MODEL_CATALOG.default },
            select(next) {
              selectedModels.set(sessionId, { ...next })
            },
          },
        }
        liveAgents.set(sessionId, target)
        return { agent: target }
      },
      async create(request) {
        createRequests.push(request)
        if (!liveAgents.has('session-new')) {
          liveAgents.set('session-new', {
            id: 'session-new',
            session: { header: { sessionId: 'session-new', cwd: request?.cwd ?? WS_TEST.path } },
            followup() {},
            steer() {},
            model: {
              current: () => selectedModels.get('session-new') ?? { ...MODEL_CATALOG.default },
              select(next) {
                selectedModels.set('session-new', { ...next })
              },
            },
          })
        }
        return { sessionId: 'session-new' }
      },
      async prompt(request) {
        promptCalls.push(request)
      },
      async modelCatalog() {
        return structuredClone(MODEL_CATALOG)
      },
      async rename(request) {
        if (state.renameError !== null) throw state.renameError
        return { title: request.title, seq: 7 }
      },
      async cancel() {
        return { accepted: true }
      },
      async projections(request) {
        const sessionId = request?.sessionId
        return {
          kind: 'sequenced',
          values: {
            agentTeam: { enabled: teamEnabled.get(sessionId) === true, tasks: [] },
          },
        }
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
    teamService,
    teamEnabled,
    teamSetCalls,
    permissionService,
    permissionCurrent,
    permissionCalls,
    sandboxOverrides,
    liveAgents,
    selectedModels,
    callerSelection: () => callerSelection,
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
    defaultMode: 'now',
    policy: 'short',
    maxSendsPerMinute: 7,
    failOnWarnings: false,
  })

  await check('registers 19 tools', () => assert.equal(harness.tools.size, 19))
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
  const listModelsTool = harness.tools.get('mesh_list_models')
  const setModelTool = harness.tools.get('mesh_set_model')
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
  const getTeamTool = harness.tools.get('mesh_get_team_mode')
  const setTeamTool = harness.tools.get('mesh_set_team_mode')
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
    assert.equal(delivery.kind, 'steer', 'default mode is now (immediate)')
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

  await check('queue mode waits for the current turn via followup', async () => {
    const result = JSON.parse(await sendTool.execute({ target: 'session-b', message: 'queue please', mode: 'queue' }, exec()))
    assert.equal(result.mode, 'queue')
    assert.equal(harness.delivered.at(-1).kind, 'followup')
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
    // maxSendsPerMinute = 7; four sends already consumed (hello + now + queue + alias).
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

  await check('create inherits the caller permission preset', async () => {
    harness.permissionCurrent.set('session-a', 'workspace-write')
    const result = JSON.parse(await createTool.execute({ title: 'perm-inherit' }, exec()))
    assert.equal(result.permission.preset, 'workspace-write')
    assert.equal(result.permission.inherited, true)
    assert.equal(harness.permissionCalls.at(-1).sessionId, 'session-new')
  })

  await check('create applies an explicit permission preset', async () => {
    const result = JSON.parse(await createTool.execute({ permission: 'read-only' }, exec()))
    assert.equal(result.permission.preset, 'read-only')
    assert.equal(result.permission.inherited, false)
    assert.equal(result.permission.label, '仅可查看')
  })

  await check('create accepts a Chinese permission label', async () => {
    harness.permissionCurrent.set('session-a', 'danger-full-access')
    harness.sandboxOverrides.set('session-a', 'danger-full-access')
    const result = JSON.parse(await createTool.execute({ permission: '完全权限' }, exec()))
    assert.equal(result.permission.preset, 'danger-full-access')
  })

  await check('create inherits full access from a full-access caller', async () => {
    const result = JSON.parse(await createTool.execute({}, exec()))
    assert.equal(result.permission.preset, 'danger-full-access')
    assert.equal(result.permission.inherited, true)
  })

  await check('create rejects full access from a restricted caller', async () => {
    harness.permissionCurrent.set('session-a', 'workspace-write')
    harness.sandboxOverrides.set('session-a', 'workspace-write')
    await assert.rejects(createTool.execute({ permission: 'danger-full-access' }, exec()), /danger-full-access caller/)
    await assert.rejects(createTool.execute({ permission: '自动审查EXP' }, exec()), /danger-full-access caller/)
  })

  await check('create inherits a preset matching a custom caller', async () => {
    harness.permissionCurrent.set('session-a', 'custom')
    harness.sandboxOverrides.set('session-a', 'workspace-write')
    const result = JSON.parse(await createTool.execute({}, exec()))
    assert.equal(result.permission.preset, 'workspace-write')
  })

  await check('list_permission_presets reports the catalog and caller state', async () => {
    const result = JSON.parse(await harness.tools.get('mesh_list_permission_presets').execute({}, exec()))
    assert.equal(result.defaultPreset, 'workspace-write')
    assert.deepEqual(result.presets.map((option) => option.value), ['read-only', 'workspace-write', 'danger-full-access', 'auto'])
    assert.equal(result.current, 'custom')
  })

  await check('list_models returns catalog and caller selection', async () => {
    const catalog = JSON.parse(await listModelsTool.execute({}, exec()))
    assert.equal(catalog.default.provider, 'prov-a')
    assert.equal(catalog.current.provider, 'prov-a')
    assert.equal(catalog.groups.length, 2)
    assert.equal(catalog.groups[0].models[0].reasoning.efforts.length, 2)
  })

  await check('create inherits the caller model by default', async () => {
    harness.selectedModels.clear()
    const result = JSON.parse(await createTool.execute({ title: 'inherit-model' }, exec()))
    assert.equal(result.modelSource, 'caller')
    assert.deepEqual(result.model, { provider: 'prov-a', model: 'model-a' })
    assert.deepEqual(harness.selectedModels.get('session-new'), { provider: 'prov-a', model: 'model-a' })
  })

  await check('create applies an explicit model with reasoning effort', async () => {
    harness.selectedModels.clear()
    const result = JSON.parse(await createTool.execute({ provider: 'prov-a', model: 'model-a', reasoning_effort: 'high' }, exec()))
    assert.equal(result.modelSource, 'explicit')
    assert.deepEqual(result.model, { provider: 'prov-a', model: 'model-a', reasoningEffort: 'high' })
    assert.deepEqual(harness.selectedModels.get('session-new'), result.model)
  })

  await check('create resolves a unique model without provider', async () => {
    const result = JSON.parse(await createTool.execute({ model: 'model-c' }, exec()))
    assert.deepEqual(result.model, { provider: 'prov-b', model: 'model-c' })
  })

  await check('create rejects an unknown model and effort', async () => {
    await assert.rejects(createTool.execute({ model: 'nope' }, exec()), /is not available/)
    await assert.rejects(
      createTool.execute({ provider: 'prov-a', model: 'model-a', reasoning_effort: 'ultra' }, exec()),
      /reasoning_effort/,
    )
    await assert.rejects(createTool.execute({ provider: 'prov-a' }, exec()), /require model/)
  })

  await check('set_model changes a session model mid-conversation', async () => {
    harness.selectedModels.clear()
    const result = JSON.parse(await setModelTool.execute({ target: 'session-b', provider: 'prov-b', model: 'model-c' }, exec()))
    assert.equal(result.sessionId, 'session-b')
    assert.equal(result.source, 'explicit')
    assert.deepEqual(result.selected, { provider: 'prov-b', model: 'model-c' })
    assert.deepEqual(harness.selectedModels.get('session-b'), { provider: 'prov-b', model: 'model-c' })
  })

  await check('set_model can inherit the caller model', async () => {
    harness.selectedModels.clear()
    const result = JSON.parse(await setModelTool.execute({ target: 'session-b', inherit_from_caller: true }, exec()))
    assert.equal(result.source, 'caller')
    assert.deepEqual(result.selected, harness.callerSelection())
  })

  await check('set_model rejects self, missing model and unknown target model', async () => {
    await assert.rejects(
      setModelTool.execute({ target: 'session-a', model: 'model-c' }, exec()),
      /cannot target the calling session itself/,
    )
    await assert.rejects(setModelTool.execute({ target: 'session-b' }, exec()), /model is required/)
    await assert.rejects(setModelTool.execute({ target: 'session-b', model: 'nope' }, exec()), /is not available/)
  })

  await check('list_sessions reports the live model selection', async () => {
    const page = JSON.parse(await listTool.execute({ limit: 5 }, exec()))
    const row = page.sessions.find((session) => session.sessionId === 'session-a')
    assert.deepEqual(row.model, { provider: 'prov-a', model: 'model-a' })
  })

  await check('model selection can be disabled by configuration', async () => {
    const disabled = createHarness()
    apply(disabled.ctx, { allowModel: false })
    await assert.rejects(
      disabled.tools.get('mesh_create_session').execute({ model: 'model-a' }, execFor(disabled)),
      /model selection is disabled/,
    )
    await assert.rejects(
      disabled.tools.get('mesh_set_model').execute({ target: 'session-b', model: 'model-a' }, execFor(disabled)),
      /model selection is disabled/,
    )
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

  await check('read team mode of a live session', async () => {
    harness.teamEnabled.set('session-a', true)
    const page = JSON.parse(await getTeamTool.execute({ target: 'session-a' }, exec()))
    assert.equal(page.enabled, true)
    assert.equal(page.source, 'live')
  })

  await check('read team mode of a cold session via projection', async () => {
    harness.liveAgents.delete('session-b')
    harness.teamEnabled.set('session-b', true)
    const page = JSON.parse(await getTeamTool.execute({ target: 'session-b' }, exec()))
    assert.equal(page.enabled, true)
    assert.equal(page.source, 'projection')
  })

  await check('set team mode switches the selection', async () => {
    const disabled = JSON.parse(await setTeamTool.execute({ target: 'session-b', enabled: false }, exec()))
    assert.equal(disabled.enabled, false)
    assert.equal(disabled.changed, true)
    const repeated = JSON.parse(await setTeamTool.execute({ target: 'session-b', enabled: false }, exec()))
    assert.equal(repeated.changed, false)
    const enabled = JSON.parse(await setTeamTool.execute({ target: 'session-b', enabled: true }, exec()))
    assert.equal(enabled.enabled, true)
    assert.equal(enabled.changed, true)
    assert.equal(harness.teamSetCalls.at(-1).enabled, true)
  })

  await check('team mode management respects allowTeam', async () => {
    const blocked = createHarness()
    apply(blocked.ctx, { allowTeam: false })
    await assert.rejects(
      blocked.tools.get('mesh_set_team_mode').execute({ target: 'session-b', enabled: true }, execFor(blocked)),
      /team mode management is disabled/,
    )
  })

  await check('set team mode rejects a subagent target', async () => {
    const sub = createHarness()
    sub.liveAgents.set('session-sub', { id: 'session-sub', session: { header: { origin: 'subagent' } } })
    apply(sub.ctx, {})
    await assert.rejects(
      sub.tools.get('mesh_set_team_mode').execute({ target: 'session-sub', enabled: true }, execFor(sub)),
      /subagent/,
    )
  })

  await check('list include_team adds the mode per row', async () => {
    const page = JSON.parse(await listTool.execute({ include_team: true, limit: 3 }, exec()))
    assert.ok(page.sessions.every((row) => typeof row.teamMode === 'boolean'))
  })

  await check('read transcript summarizes human/assistant/tool/peer entries', async () => {
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: { content: [{ type: 'text', text: 'human asks about the build' }], source: { kind: 'user' } },
    })
    harness.appendTranscriptEvent('session-b', {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>\nRuntime context snapshot (DSH 0.2.2-rc.3 framing)\n</system-reminder>' }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
      },
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
    assert.ok(page.entries.every((entry) => !entry.text || !entry.text.includes('<system-reminder>')), 'runtime-context reminders must stay filtered')
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
