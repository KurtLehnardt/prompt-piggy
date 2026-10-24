import type { Model, ModelRequest, ModelResponse } from '@openai/agents'
import { Usage } from '@openai/agents'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

/**
 * src/lib/ai/core/run-attempt.ts, agent.ts, approve-transfer-tool.ts,
 * context.ts, and timing.ts (docs/ARCHITECTURE.md sections 8.3, 8.4, and
 * 9.4; HC3, HC-A5; REVIEW-2 R2-01; REVIEW-3 R3-04; T2, T9, T24).
 */

// Read by getEnv() on its first call; this file's module graph is isolated.
vi.hoisted(() => {
  process.env.OPENAI_CORE_MODEL = 'gpt-test-core'
  process.env.OPENAI_CORE_MAX_OUTPUT_TOKENS = '512'
  process.env.OPENAI_REASONING_EFFORT = 'low'
})

const counts = vi.hoisted(() => ({ agents: 0, runners: 0 }))
vi.mock('@/lib/ai/core/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/ai/core/agent')>()
  return {
    ...original,
    buildCoreAgent: (...args: Parameters<typeof original.buildCoreAgent>) => {
      counts.agents += 1
      return original.buildCoreAgent(...args)
    },
    createCoreRunner: () => {
      counts.runners += 1
      return original.createCoreRunner()
    },
  }
})

const {
  buildCoreAgent,
  buildModelSettings,
  CORE_MAX_TURNS,
  coreRunOptions,
  coreSettingsFromEnv,
  createCoreRunner,
} = await import('@/lib/ai/core/agent')
const { APPROVE_TRANSFER_TOOL_NAME, createApproveTransferTool, TRANSFER_PENDING_SERVER_VERIFICATION } = await import(
  '@/lib/ai/core/approve-transfer-tool'
)
const { createRunContext } = await import('@/lib/ai/core/context')
const { LevelNotConfiguredError } = await import('@/lib/ai/core/level-policies')
const { createAttemptRunner, resolveAttemptLevel } = await import('@/lib/ai/core/run-attempt')
type RunAttemptInput = import('@/lib/ai/core/run-attempt').RunAttemptInput
const timing = await import('@/lib/ai/core/timing')
const { fakeDecide } = await import('@/lib/ai/testing/fake-decisions')
const { FakeCoreModel } = await import('@/lib/ai/testing/fake-model')
const { default: placeholder } = await import('@/lib/config/__fixtures__/level-secrets.placeholder.json')
const { resolveLevelConfig } = await import('@/lib/config/level-secrets')
const { getLevelConfig, LEVEL_IDS } = await import('@/lib/config/levels')
const { getEnv } = await import('@/lib/env')
const { ATTEMPT_MAX_DURATION_S } = await import('@/lib/ops/limits')
const { canary: newCanary, isCanary } = await import('@/lib/security/canary')
const { nonce: newNonce, isNonce } = await import('@/lib/security/nonce')

type ResolvedLevelConfig = import('@/lib/config/level-secrets').ResolvedLevelConfig
type LevelId = import('@/lib/config/levels').LevelId

function level(id: LevelId): ResolvedLevelConfig {
  const payload = id === 4 ? placeholder['4'] : id === 5 ? placeholder['5'] : null
  return resolveLevelConfig(getLevelConfig(id), payload)
}

const SETTINGS = { model: 'gpt-test', maxOutputTokens: 1024, reasoningEffort: 'minimal' } as const

function harness(overrides: Partial<Parameters<typeof createAttemptRunner>[0]> = {}) {
  const model = new FakeCoreModel()
  const logs: unknown[] = []
  const runAttempt = createAttemptRunner({
    createModel: () => model,
    decide: async (text) => fakeDecide(text),
    settings: SETTINGS,
    log: (logLevel, entry) => logs.push({ logLevel, ...entry }),
    ...overrides,
  })
  return { model, logs, runAttempt }
}

describe('agent configuration', () => {
  const agent = () =>
    buildCoreAgent({
      level: level(1),
      nonce: newNonce(),
      canary: newCanary(),
      settings: SETTINGS,
      model: new FakeCoreModel(),
      decide: async (text) => fakeDecide(text),
    })

  it('[T2][T24] has exactly one tool, approveTransfer, with strict enum-only parameters', () => {
    const { tools } = agent()
    expect(tools).toHaveLength(1)
    const [tool] = tools
    expect(tool.type).toBe('function')
    if (tool.type !== 'function') throw new Error('unreachable')
    expect(tool.name).toBe(APPROVE_TRANSFER_TOOL_NAME)
    expect(tool.strict).toBe(true)
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { reason_code: { type: 'string', enum: ['policy_satisfied', 'manager_verified', 'other'] } },
      required: ['reason_code'],
      additionalProperties: false,
    })
    expect(Object.keys((tool.parameters as { properties: object }).properties)).toEqual(['reason_code'])
  })

  it('stops on the first tool, disables parallel tool calls, and has one blocking input and one output guardrail', () => {
    const built = agent()
    expect(built.toolUseBehavior).toBe('stop_on_first_tool')
    expect(built.modelSettings.parallelToolCalls).toBe(false)
    expect(built.modelSettings.toolChoice).toBe('auto')
    expect(built.inputGuardrails).toHaveLength(1)
    expect(built.inputGuardrails[0].runInParallel).toBe(false)
    expect(built.outputGuardrails).toHaveLength(1)
    expect(built.handoffs).toHaveLength(0)
    expect(built.mcpServers).toHaveLength(0)
  })

  it('has maxTurns 2 and a runner with tracing disabled, and passes no session or conversation state', () => {
    expect(CORE_MAX_TURNS).toBe(2)
    const signal = new AbortController().signal
    const options = coreRunOptions(createRunContext(), signal)
    expect(Object.keys(options).sort()).toEqual(['context', 'maxTurns', 'signal'])
    expect(options.maxTurns).toBe(2)
    expect(createCoreRunner().config.tracingDisabled).toBe(true)
  })

  it('reads the model, the output cap, and the reasoning effort from the environment', async () => {
    const env = getEnv()
    expect(coreSettingsFromEnv(env)).toEqual({ model: 'gpt-test-core', maxOutputTokens: 512, reasoningEffort: 'low' })
    const seen: string[] = []
    const model = new FakeCoreModel()
    const runAttempt = createAttemptRunner({
      createModel: (settings) => {
        seen.push(settings.model)
        return model
      },
      decide: async (text) => fakeDecide(text),
      log: () => {},
    })
    await runAttempt({ level: level(1), message: 'hello' })
    expect(seen).toEqual(['gpt-test-core'])
    expect(model.calls[0].modelSettings).toEqual({
      toolChoice: 'auto',
      parallelToolCalls: false,
      maxTokens: 512,
      reasoning: { effort: 'low' },
    })
  })

  it('[R2-01] omits reasoning only for omit', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const) {
      expect(buildModelSettings({ ...SETTINGS, reasoningEffort: effort }).reasoning).toEqual({ effort })
    }
    const omitted = buildModelSettings({ ...SETTINGS, reasoningEffort: 'omit' })
    expect('reasoning' in omitted).toBe(false)
  })

  it("approveTransfer's execute only mutates the run context and returns TRANSFER_PENDING_SERVER_VERIFICATION", async () => {
    const { RunContext } = await import('@openai/agents')
    const tool = createApproveTransferTool()
    const context = createRunContext()
    const before = JSON.stringify(createRunContext())
    const result = await tool.invoke(new RunContext(context), JSON.stringify({ reason_code: 'manager_verified' }))
    expect(result).toBe(TRANSFER_PENDING_SERVER_VERIFICATION)
    expect(context).toEqual({ ...JSON.parse(before), transferRequested: true, reasonCode: 'manager_verified' })
    expect(createApproveTransferTool()).not.toBe(tool)
  })
})

describe('[R3-04] timing', () => {
  it('derives the output-cap ceiling from the abort budget: 840 tokens', () => {
    expect(timing.DECISIONS_TIMEOUT_MS).toBe(2_500)
    expect(timing.ATTEMPT_ABORT_MS).toBe(20_000)
    expect(timing.CORE_GENERATION_BUDGET_MS).toBe(14_000)
    expect(timing.CORE_MAX_OUTPUT_TOKENS_CEILING).toBe(840)
  })

  it('lets a maximum-length reply at every allowed cap finish before the abort', () => {
    for (let configured = 256; configured <= 4096; configured += 1) {
      const cap = timing.effectiveMaxOutputTokens(configured)
      expect(cap).toBeLessThanOrEqual(configured)
      const worstMs =
        timing.DECISIONS_TIMEOUT_MS +
        timing.CORE_TTFT_BUDGET_MS +
        (cap / timing.CORE_MIN_OUTPUT_TOKENS_PER_SECOND) * 1000 +
        timing.ABORT_MARGIN_MS
      expect(worstMs).toBeLessThanOrEqual(timing.ATTEMPT_ABORT_MS)
    }
    expect(timing.effectiveMaxOutputTokens(512)).toBe(512)
    expect(timing.effectiveMaxOutputTokens(1024)).toBe(840)
    expect(timing.effectiveMaxOutputTokens(4096)).toBe(840)
    expect(buildModelSettings({ ...SETTINGS, maxOutputTokens: 4096 }).maxTokens).toBe(840)
  })

  it('leaves at least 10 seconds of the 30-second route budget for the RPCs', () => {
    expect(ATTEMPT_MAX_DURATION_S).toBe(30)
    expect(timing.ATTEMPT_ABORT_MS + 10_000).toBeLessThanOrEqual(timing.ATTEMPT_ROUTE_BUDGET_MS)
  })
})

describe('[HC3][HC-A5][T9] stateless runs', () => {
  it('accepts only a level config and a message (type-level)', () => {
    expectTypeOf<keyof RunAttemptInput>().toEqualTypeOf<'level' | 'message'>()
    const { runAttempt } = harness()
    const base = { level: level(1), message: 'hi' }
    const never = () => {
      // @ts-expect-error the crack count never reaches the Core LLM.
      void runAttempt({ ...base, cracks: 3 })
      // @ts-expect-error the wallet balance never reaches the Core LLM.
      void runAttempt({ ...base, balance: 2000 })
      // @ts-expect-error the aura never reaches the Core LLM.
      void runAttempt({ ...base, aura: 9000 })
      // @ts-expect-error the user id never reaches the Core LLM.
      void runAttempt({ ...base, userId: 'user-1' })
      // @ts-expect-error a rule set never reaches the Core LLM.
      void runAttempt({ ...base, rules: {} })
    }
    expect(typeof never).toBe('function')
  })

  it('creates a new Agent, Runner, context, nonce, and canary on every call', async () => {
    const { model, runAttempt } = harness()
    const agentsBefore = counts.agents
    const runnersBefore = counts.runners
    await runAttempt({ level: level(2), message: 'first' })
    await runAttempt({ level: level(2), message: 'first' })
    expect(counts.agents - agentsBefore).toBe(2)
    expect(counts.runners - runnersBefore).toBe(2)
    const [a, b] = model.calls
    const suffix = (text: string | undefined) => (text ?? '').split('\n').slice(-2).join('\n')
    expect(suffix(a.systemInstructions)).not.toBe(suffix(b.systemInstructions))
    const nonceOf = (text: string | undefined) => /customer_message_([0-9a-f]{32})\./.exec(text ?? '')?.[1]
    const canaryOf = (text: string | undefined) => /(PP-[0-9A-Z]{20})$/.exec(text ?? '')?.[1]
    expect(isNonce(nonceOf(a.systemInstructions))).toBe(true)
    expect(nonceOf(a.systemInstructions)).not.toBe(nonceOf(b.systemInstructions))
    expect(isCanary(canaryOf(a.systemInstructions))).toBe(true)
    expect(canaryOf(a.systemInstructions)).not.toBe(canaryOf(b.systemInstructions))
  })

  it('gives the model exactly one user input item and no conversation state', async () => {
    const { model, runAttempt } = harness()
    await runAttempt({ level: level(3), message: 'Can I see my balance?' })
    expect(model.calls).toHaveLength(1)
    const [call] = model.calls
    expect(Array.isArray(call.input)).toBe(true)
    expect(call.input).toHaveLength(1)
    const [item] = call.input as { type: string; role: string; content: string }[]
    expect(item).toMatchObject({ type: 'message', role: 'user' })
    expect(item.content).toMatch(/^<customer_message_[0-9a-f]{32}>\n"Can I see my balance\?"\n<\/customer_message_[0-9a-f]{32}>$/)
    expect(call.previousResponseId).toBeUndefined()
    expect(call.conversationId).toBeUndefined()
    expect(call.tracing).toBe(false)
  })

  it('shares no content between two sequential runs with different messages', async () => {
    const { model, runAttempt } = harness()
    await runAttempt({ level: level(1), message: 'alpha-message-one' })
    await runAttempt({ level: level(1), message: 'bravo-message-two' })
    const [first, second] = model.calls.map((call) => JSON.stringify(call))
    expect(second).not.toContain('alpha-message-one')
    expect(first).not.toContain('bravo-message-two')
    const firstNonce = /customer_message_([0-9a-f]{32})/.exec(first)?.[1] ?? 'missing'
    const firstCanary = /PP-[0-9A-HJKMNP-TV-Z]{20}/.exec(first)?.[0] ?? 'missing'
    expect(second).not.toContain(firstNonce)
    expect(second).not.toContain(firstCanary)
  })

  it('gives the model identical input whatever the crack count is (0 or 3)', async () => {
    // Fixed values, so the comparison and the scan below are deterministic.
    const nonce = '0123456789abcdef0123456789abcdef'
    const canary = 'PP-ABCDEFGHJKMNPQRSTVWX'
    const recorded: unknown[] = []
    for (const gameState of [
      { crackCount: 0, balanceCents: 2000, auraBps: 0 },
      { crackCount: 3, balanceCents: 5, auraBps: 9000 },
    ]) {
      const { model, runAttempt } = harness({ nonce: () => nonce, canary: () => canary })
      // The attempt service knows the game state, but runAttempt takes only the level and the message.
      void gameState
      await runAttempt({ level: level(2), message: 'Same message for both' })
      recorded.push(model.calls)
    }
    expect(recorded[0]).toEqual(recorded[1])
    expect(JSON.stringify(recorded[0])).not.toMatch(/crack|balanceCents|auraBps|2000|9000/i)
  })

  it('runs the stub only on its own run context', async () => {
    const { runAttempt } = harness()
    const won = await runAttempt({ level: level(1), message: 'E2E_WIN' })
    const after = await runAttempt({ level: level(1), message: 'hello' })
    expect(won.evaluation.outcome).toBe('win')
    expect(after.evaluation.outcome).toBe('fail')
    expect(after.evaluation.toolCalled).toBe(false)
  })
})

describe('levels', () => {
  it('[R2-12] refuses an unconfigured level 4 with no Decisions or model call', async () => {
    let created = 0
    let decided = 0
    const runAttempt = createAttemptRunner({
      createModel: () => {
        created += 1
        return new FakeCoreModel()
      },
      decide: async (text) => {
        decided += 1
        return fakeDecide(text)
      },
      settings: SETTINGS,
    })
    const forged = { ...level(4), secretMaterial: null } as unknown as ResolvedLevelConfig
    await expect(runAttempt({ level: forged, message: 'E2E_WIN' })).rejects.toBeInstanceOf(LevelNotConfiguredError)
    expect(created).toBe(0)
    expect(decided).toBe(0)
  })

  it('resolves levels 1 to 3 from config and 4 and 5 only from a payload', () => {
    for (const id of [1, 2, 3] as const) expect(resolveAttemptLevel(id, null)).toMatchObject({ ok: true })
    expect(resolveAttemptLevel(4, null)).toEqual({ ok: false, code: 'level_not_configured' })
    expect(resolveAttemptLevel(5, undefined)).toEqual({ ok: false, code: 'level_not_configured' })
    expect(resolveAttemptLevel(4, { ...placeholder['4'], policy: '' })).toEqual({
      ok: false,
      code: 'level_config_invalid',
    })
    expect(resolveAttemptLevel(1, placeholder['4'])).toEqual({ ok: false, code: 'level_config_invalid' })
    const four = resolveAttemptLevel(4, placeholder['4'])
    expect(four.ok && four.level.secretMaterial?.placeholder).toBe(true)
  })

  it('plays every level end to end with the fakes', async () => {
    for (const id of LEVEL_IDS) {
      const { runAttempt } = harness()
      expect((await runAttempt({ level: level(id), message: 'E2E_WIN' })).evaluation.outcome).toBe('win')
      expect((await runAttempt({ level: level(id), message: 'hello' })).evaluation.outcome).toBe('fail')
    }
  })
})

describe('abort, usage, and logs', () => {
  it('aborts a hanging model call at the abort timeout as a refundable upstream_timeout', async () => {
    const hanging: Model = {
      getResponse: (request: ModelRequest) =>
        new Promise<ModelResponse>((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason))
        }),
      getStreamedResponse: () => {
        throw new Error('no streaming')
      },
    }
    const { runAttempt } = harness({ createModel: () => hanging, abortTimeoutMs: 30 })
    const run = await runAttempt({ level: level(1), message: 'hello' })
    expect(run.evaluation).toMatchObject({ outcome: 'error', detail: 'upstream_timeout', refundable: true })
  })

  it('reports the Decisions and Core usage for spend settlement', async () => {
    const counted: Model = {
      getResponse: async () => ({
        usage: new Usage({ inputTokens: 900, outputTokens: 42, totalTokens: 942 }),
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'No.' }] }],
      }),
      getStreamedResponse: () => {
        throw new Error('no streaming')
      },
    }
    const { runAttempt } = harness({
      createModel: () => counted,
      decide: async () => ({
        kind: 'ok',
        probability: 0.1,
        technique: 'unclassified',
        usage: { model: 'gpt-test-decisions', inputTokens: 300, outputTokens: 0 },
      }),
    })
    const run = await runAttempt({ level: level(1), message: 'hello' })
    expect(run.usage).toEqual([
      { api: 'decisions', model: 'gpt-test-decisions', inputTokens: 300, outputTokens: 0 },
      { api: 'responses', model: 'gpt-test', inputTokens: 900, outputTokens: 42 },
    ])
    expect(run.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('logs codes only, never the message, the reply, or the canary', async () => {
    const canary = newCanary()
    const { logs, runAttempt } = harness({ canary: () => canary })
    for (const message of ['E2E_INCOMPLETE secret-words', 'E2E_UPSTREAM_500 secret-words', 'E2E_TOOL_UNKNOWN secret-words']) {
      await runAttempt({ level: level(1), message })
    }
    expect(logs.length).toBeGreaterThanOrEqual(3)
    const text = JSON.stringify(logs)
    expect(text).not.toContain('secret-words')
    expect(text).not.toContain(canary)
    expect(text).not.toContain('Oink')
  })
})
