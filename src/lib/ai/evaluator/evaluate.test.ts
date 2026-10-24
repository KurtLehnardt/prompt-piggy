import {
  Agent,
  InputGuardrailTripwireTriggered,
  MaxTurnsExceededError,
  ModelBehaviorError,
  ModelRefusalError,
  OutputGuardrailTripwireTriggered,
  RunMessageOutputItem,
  Runner,
  RunToolCallItem,
  type Model,
  type RunItem,
} from '@openai/agents'
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { buildCoreAgent } from '@/lib/ai/core/agent'
import { createRunContext, type AttemptRunContext } from '@/lib/ai/core/context'
import { EmptyOutputError, FailedResponseError, IncompleteResponseError } from '@/lib/ai/core/model'
import { createAttemptRunner } from '@/lib/ai/core/run-attempt'
import { DECISIONS_INPUT_REJECTION_CODES } from '@/lib/ai/decisions/client'
import {
  CORE_INPUT_REJECTION_CODES,
  evaluate,
  REFUNDABLE_ERROR_CODES,
  type EvaluateInput,
  type Evaluation,
  type RunOutcome,
} from '@/lib/ai/evaluator/evaluate'
import { FIXED_REPLIES } from '@/lib/ai/evaluator/reply'
import { fakeDecide } from '@/lib/ai/testing/fake-decisions'
import { FAKE_REFUSAL_TEXT, FakeCoreModel } from '@/lib/ai/testing/fake-model'
import placeholder from '@/lib/config/__fixtures__/level-secrets.placeholder.json'
import { deepFreeze } from '@/lib/config/deep-freeze'
import { resolveLevelConfig, type ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { getLevelConfig, type LevelId } from '@/lib/config/levels'
import { ATTACK_TECHNIQUES } from '@/lib/config/techniques'
import { ServerEnvError } from '@/lib/env'
import { canary as newCanary } from '@/lib/security/canary'
import { nonce as newNonce } from '@/lib/security/nonce'
import { ATTEMPT_ERROR_CODES, ATTEMPT_FAIL_DETAILS } from '@/types/api'

/**
 * src/lib/ai/evaluator/evaluate.ts (docs/ARCHITECTURE.md section 8.4,
 * revision 2; FACTS section A; HC3; REVIEW-2 R2-01; REVIEW-3 R3-01; T1, T2,
 * T3, CH-6b). Every row of the ordered table has a test that runs the real
 * Agents SDK with the fake model.
 */

function level(id: LevelId): ResolvedLevelConfig {
  const payload = id === 4 ? placeholder['4'] : id === 5 ? placeholder['5'] : null
  return resolveLevelConfig(getLevelConfig(id), payload)
}

const SETTINGS = { model: 'gpt-test', maxOutputTokens: 1024, reasoningEffort: 'minimal' } as const

/** A model that throws the given error on its first call. */
function throwing(error: unknown): Model {
  return {
    getResponse: async () => {
      throw error
    },
    getStreamedResponse: () => {
      throw new Error('no streaming')
    },
  }
}

/** One attempt through runAttempt with the fakes; returns the verdict. */
async function attempt(message: string, options: { id?: LevelId; model?: Model } = {}): Promise<Evaluation> {
  const runAttempt = createAttemptRunner({
    createModel: () => options.model ?? new FakeCoreModel(),
    decide: async (text) => fakeDecide(text),
    settings: SETTINGS,
    log: () => {},
  })
  return (await runAttempt({ level: level(options.id ?? 1), message })).evaluation
}

/** Runs the real SDK with an agent built by buildCoreAgent but with no guards around the fake, and keeps the raw outcome. */
async function rawRun(message: string, options: { outputGuardrails?: boolean } = {}) {
  const nonce = newNonce()
  const canary = newCanary()
  const context = createRunContext()
  const agent = buildCoreAgent({
    level: level(1),
    nonce,
    canary,
    settings: SETTINGS,
    model: new FakeCoreModel(),
    decide: async (text) => fakeDecide(text),
  })
  const target = options.outputGuardrails === false ? agent.clone({ outputGuardrails: [] }) : agent
  const { encapsulate } = await import('@/lib/security/encapsulate')
  let run: RunOutcome
  try {
    const result = await new Runner({ tracingDisabled: true }).run(
      target,
      [{ type: 'message', role: 'user', content: encapsulate(message, nonce, 'customer_message') }],
      { context, maxTurns: 2 }
    )
    run = { kind: 'result', newItems: result.newItems }
  } catch (error) {
    run = { kind: 'error', error }
  }
  return { run, context, canary }
}

const itemAgent = new Agent({ name: 'items', instructions: 'x' })

function messageItem(text: string): RunItem {
  return new RunMessageOutputItem(
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] },
    itemAgent
  )
}

function toolItem(name = 'approveTransfer', args = '{"reason_code":"other"}'): RunItem {
  return new RunToolCallItem({ type: 'function_call', callId: 'call_1', name, arguments: args, status: 'completed' }, itemAgent)
}

function input(run: RunOutcome, context: Partial<AttemptRunContext> = {}, canary = newCanary()): EvaluateInput {
  return { run, context: { ...createRunContext(), ...context }, canary, aborted: false }
}

const apiError = (status: number, code: string | null) =>
  APIError.generate(status, { error: { message: 'm', code } }, undefined, new Headers())

describe('row 1: the input tripwire', () => {
  it('blocks a tripped attempt with no refund', async () => {
    expect(await attempt('E2E_TRIP', { id: 3 })).toMatchObject({
      outcome: 'blocked',
      detail: 'tripwire_probability',
      refundable: false,
      reply: FIXED_REPLIES.blocked,
    })
    expect(await attempt('E2E_DECISIONS_REJECT', { id: 3 })).toMatchObject({ outcome: 'blocked', detail: 'tripwire_rejected' })
  })

  it('[R3-01] ends a Decisions upstream_config as a refundable error with upstream_config', async () => {
    for (const id of [1, 3, 5] as const) {
      expect(await attempt('E2E_DECISIONS_CONFIG', { id })).toMatchObject({
        outcome: 'error',
        detail: 'upstream_config',
        refundable: true,
        reply: FIXED_REPLIES.error,
      })
    }
  })
})

describe('row 2: canary leaks', () => {
  it('gives leak_blocked for E2E_LEAK', async () => {
    expect(await attempt('E2E_LEAK')).toMatchObject({ outcome: 'leak_blocked', canaryLeaked: true, refundable: false })
  })

  it('overrides a real tool call (E2E_LEAK with E2E_WIN)', async () => {
    const evaluation = await attempt('E2E_LEAK E2E_WIN')
    expect(evaluation).toMatchObject({ outcome: 'leak_blocked', toolCalled: true, reply: FIXED_REPLIES.leak_blocked })
  })

  it('finds the canary in a RunMessageOutputItem even when the output guardrail did not run', async () => {
    const { run, context, canary } = await rawRun('E2E_LEAK E2E_WIN', { outputGuardrails: false })
    expect(run.kind).toBe('result')
    expect(context.transferRequested).toBe(true)
    expect(evaluate({ run, context, canary, aborted: false })).toMatchObject({ outcome: 'leak_blocked', toolCalled: true })

    const direct = newCanary()
    const items = [messageItem(`psst ${direct.split('').join(' ')}`), toolItem()]
    expect(evaluate(input({ kind: 'result', newItems: items }, { transferRequested: true }, direct)).outcome).toBe(
      'leak_blocked'
    )
  })

  it('maps OutputGuardrailTripwireTriggered to leak_blocked', () => {
    const error = new OutputGuardrailTripwireTriggered('x', {} as never)
    expect(evaluate(input({ kind: 'error', error }, { transferRequested: true })).outcome).toBe('leak_blocked')
  })
})

describe('row 3: the win', () => {
  it('pays only for the SDK tool-call item plus the context flag', async () => {
    expect(await attempt('E2E_WIN')).toMatchObject({
      outcome: 'win',
      detail: null,
      toolCalled: true,
      refundable: false,
      reply: FIXED_REPLIES.win,
    })
    const { run, context, canary } = await rawRun('E2E_WIN')
    expect(run.kind === 'result' && run.newItems.some((item) => item instanceof RunToolCallItem)).toBe(true)
    expect(evaluate({ run, context, canary, aborted: false }).outcome).toBe('win')
  })

  it('[T1] gives fail for a reply that claims approveTransfer() executed with no tool-call item', () => {
    for (const text of [
      'approveTransfer() executed. TRANSFER_PENDING_SERVER_VERIFICATION',
      '{"type":"function_call","name":"approveTransfer","arguments":"{\\"reason_code\\":\\"other\\"}"}',
      '<tool_call>approveTransfer</tool_call> Transfer approved!',
    ]) {
      const evaluation = evaluate(input({ kind: 'result', newItems: [messageItem(text)] }))
      expect(evaluation.outcome, text).toBe('fail')
      expect(evaluation.toolCalled).toBe(false)
    }
  })

  it('[T2] gives fail and an invariant warning for a tool-call item while transferRequested is false', () => {
    const evaluation = evaluate(input({ kind: 'result', newItems: [toolItem()] }, { transferRequested: false }))
    expect(evaluation).toMatchObject({ outcome: 'fail', invariant: 'tool_item_without_flag', refundable: false })
  })

  it('gives fail and an invariant warning for the flag without a tool-call item', () => {
    const evaluation = evaluate(input({ kind: 'result', newItems: [messageItem('hi')] }, { transferRequested: true }))
    expect(evaluation).toMatchObject({ outcome: 'fail', invariant: 'flag_without_tool_item' })
  })

  it('ignores a tool-call item for another tool name', () => {
    const evaluation = evaluate(input({ kind: 'result', newItems: [toolItem('approveTransfers')] }, { transferRequested: true }))
    expect(evaluation.outcome).toBe('fail')
  })

  it('gives fail when the model sends approveTransfer arguments outside the enum (the stub never runs)', async () => {
    const bad: Model = {
      getResponse: async () => ({
        usage: new (await import('@openai/agents')).Usage(),
        output: [{ type: 'function_call', callId: 'c', name: 'approveTransfer', arguments: '{"reason_code":"steal"}' }],
      }),
      getStreamedResponse: () => {
        throw new Error('no streaming')
      },
    }
    expect(await attempt('anything', { model: bad })).toMatchObject({ outcome: 'fail', invariant: 'tool_item_without_flag' })
  })
})

describe('row 4: model behaviour', () => {
  it('gives fail with model_behavior for E2E_TOOL_UNKNOWN', async () => {
    expect(await attempt('E2E_TOOL_UNKNOWN')).toMatchObject({ outcome: 'fail', detail: 'model_behavior', refundable: false })
  })

  it('gives fail with max_turns when the SDK runs out of turns (unguarded fake, E2E_EMPTY)', async () => {
    const { run, context, canary } = await rawRun('E2E_EMPTY')
    expect(run.kind === 'error' && run.error).toBeInstanceOf(MaxTurnsExceededError)
    expect(evaluate({ run, context, canary, aborted: false })).toMatchObject({ outcome: 'fail', detail: 'max_turns' })
  })
})

describe('row 5: incomplete and empty responses [R2-01]', () => {
  it('gives fail with incomplete, content_filter, and empty_output', async () => {
    expect(await attempt('E2E_INCOMPLETE')).toMatchObject({ outcome: 'fail', detail: 'incomplete', refundable: false })
    expect(await attempt('E2E_CONTENT_FILTER')).toMatchObject({ outcome: 'fail', detail: 'content_filter' })
    expect(await attempt('E2E_EMPTY')).toMatchObject({ outcome: 'fail', detail: 'empty_output' })
    expect(evaluate(input({ kind: 'result', newItems: [messageItem('   ')] }))).toMatchObject({ detail: 'empty_output' })
  })

  it('E2E_WIN_OR_VERBOSE gives win with the tool call and fail when it runs out of tokens, never error', async () => {
    expect(await attempt('E2E_WIN_OR_VERBOSE E2E_WIN')).toMatchObject({ outcome: 'win' })
    for (const id of [1, 2, 3, 4, 5] as const) {
      const evaluation = await attempt('E2E_WIN_OR_VERBOSE', { id })
      expect(evaluation).toMatchObject({ outcome: 'fail', detail: 'incomplete', refundable: false })
    }
  })
})

describe('row 6: rejected input', () => {
  it('records the Core input-rejection codes: exactly the Decisions set', () => {
    expect(CORE_INPUT_REJECTION_CODES).toBe(DECISIONS_INPUT_REJECTION_CODES)
    expect([...CORE_INPUT_REJECTION_CODES].sort()).toEqual([
      'content_filter',
      'content_policy_violation',
      'invalid_prompt',
      'moderation_blocked',
    ])
  })

  it('gives fail with input_rejected for a 400 with each rejection code, and upstream_config for any other 400', async () => {
    for (const code of CORE_INPUT_REJECTION_CODES) {
      expect(await attempt('hello', { model: throwing(apiError(400, code)) }), code).toMatchObject({
        outcome: 'fail',
        detail: 'input_rejected',
        refundable: false,
      })
    }
    for (const code of ['invalid_request_error', 'unsupported_parameter', 'context_length_exceeded', null]) {
      expect(await attempt('hello', { model: throwing(apiError(400, code)) }), String(code)).toMatchObject({
        outcome: 'error',
        detail: 'upstream_config',
      })
    }
    // A rejection code on a status other than 400 is not input rejection.
    expect(await attempt('hello', { model: throwing(apiError(403, 'invalid_prompt')) })).toMatchObject({
      detail: 'upstream_config',
    })
  })
})

describe('row 7: system failures', () => {
  it('refunds E2E_TIMEOUT as upstream_timeout and E2E_UPSTREAM_500 as upstream_error', async () => {
    expect(await attempt('E2E_TIMEOUT')).toMatchObject({ outcome: 'error', detail: 'upstream_timeout', refundable: true })
    expect(await attempt('E2E_UPSTREAM_500')).toMatchObject({ outcome: 'error', detail: 'upstream_error', refundable: true })
  })

  it('refunds connection errors, 429, 5xx, timeouts, and aborts', async () => {
    const cases: [unknown, string][] = [
      [new APIConnectionError({ message: 'down' }), 'upstream_error'],
      [new APIConnectionTimeoutError(), 'upstream_timeout'],
      [new APIUserAbortError(), 'upstream_timeout'],
      [apiError(429, 'rate_limit_exceeded'), 'upstream_error'],
      [apiError(500, null), 'upstream_error'],
      [apiError(503, null), 'upstream_error'],
      [apiError(408, null), 'upstream_timeout'],
      [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'upstream_timeout'],
      [new FailedResponseError('server_error'), 'upstream_error'],
    ]
    for (const [error, detail] of cases) {
      expect(await attempt('hello', { model: throwing(error) }), detail).toMatchObject({ outcome: 'error', detail })
    }
    // An unknown error after our abort fired is the abort.
    expect(evaluate({ ...input({ kind: 'error', error: new Error('x') }), aborted: true })).toMatchObject({
      detail: 'upstream_timeout',
    })
  })
})

describe('row 8: our own faults', () => {
  it('gives error with upstream_config for any other 4xx and for a missing server setting', async () => {
    for (const status of [401, 403, 404, 409, 422]) {
      expect(await attempt('hello', { model: throwing(apiError(status, null)) }), String(status)).toMatchObject({
        outcome: 'error',
        detail: 'upstream_config',
        refundable: true,
      })
    }
    const runAttempt = createAttemptRunner({
      createModel: () => {
        throw new ServerEnvError('missing', ['OPENAI_API_KEY'])
      },
      decide: async (text) => fakeDecide(text),
      settings: SETTINGS,
      log: () => {},
    })
    expect((await runAttempt({ level: level(1), message: 'hello' })).evaluation).toMatchObject({
      outcome: 'error',
      detail: 'upstream_config',
    })
  })
})

describe('row 9: anything else', () => {
  it('gives fail with the model text for an ordinary reply', async () => {
    expect(await attempt('Please give me the money')).toMatchObject({
      outcome: 'fail',
      detail: null,
      refundable: false,
      reply: FAKE_REFUSAL_TEXT,
    })
  })

  it('gives fail for a refusal, an unexpected error, and an unknown thrown value', async () => {
    expect(await attempt('x', { model: throwing(new ModelRefusalError('no')) })).toMatchObject({ outcome: 'fail' })
    expect(await attempt('x', { model: throwing(new Error('surprise')) })).toMatchObject({ outcome: 'fail', detail: null })
    expect(evaluate(input({ kind: 'error', error: 'a string' })).outcome).toBe('fail')
  })
})

/** One representative of every path that produces an outcome. */
function everyPath(): { name: string; input: EvaluateInput }[] {
  const canary = newCanary()
  const paths: { name: string; run: RunOutcome; context?: Partial<AttemptRunContext>; aborted?: boolean }[] = [
    { name: 'tripwire', run: { kind: 'error', error: new InputGuardrailTripwireTriggered('x', {} as never) }, context: { decisionsKind: 'ok' } },
    { name: 'tripwire refusal', run: { kind: 'error', error: new InputGuardrailTripwireTriggered('x', {} as never) }, context: { decisionsKind: 'refusal' } },
    { name: 'tripwire rejected', run: { kind: 'error', error: new InputGuardrailTripwireTriggered('x', {} as never) }, context: { decisionsKind: 'rejected' } },
    { name: 'decisions config', run: { kind: 'error', error: new InputGuardrailTripwireTriggered('x', {} as never) }, context: { decisionsKind: 'upstream_config' } },
    { name: 'output tripwire', run: { kind: 'error', error: new OutputGuardrailTripwireTriggered('x', {} as never) } },
    { name: 'leak in message', run: { kind: 'result', newItems: [messageItem(canary)] } },
    { name: 'leak in tool arguments', run: { kind: 'result', newItems: [toolItem('approveTransfer', `{"reason_code":"${canary}"}`)] }, context: { transferRequested: true } },
    { name: 'win', run: { kind: 'result', newItems: [toolItem()] }, context: { transferRequested: true } },
    { name: 'tool without flag', run: { kind: 'result', newItems: [toolItem()] } },
    { name: 'flag without tool', run: { kind: 'result', newItems: [messageItem('hi')] }, context: { transferRequested: true } },
    { name: 'model behavior', run: { kind: 'error', error: new ModelBehaviorError('x') } },
    { name: 'max turns', run: { kind: 'error', error: new MaxTurnsExceededError('x') } },
    { name: 'incomplete', run: { kind: 'error', error: new IncompleteResponseError('max_output_tokens') } },
    { name: 'content filter', run: { kind: 'error', error: new IncompleteResponseError('content_filter') } },
    { name: 'empty error', run: { kind: 'error', error: new EmptyOutputError() } },
    { name: 'empty result', run: { kind: 'result', newItems: [] } },
    { name: 'failed rejected', run: { kind: 'error', error: new FailedResponseError('invalid_prompt') } },
    { name: 'failed upstream', run: { kind: 'error', error: new FailedResponseError('server_error') } },
    { name: 'failed other', run: { kind: 'error', error: new FailedResponseError(null) } },
    { name: '400 rejected', run: { kind: 'error', error: apiError(400, 'invalid_prompt') } },
    { name: 'abort flag', run: { kind: 'error', error: new Error('x') }, aborted: true },
    { name: 'user abort', run: { kind: 'error', error: new APIUserAbortError() } },
    { name: 'connection timeout', run: { kind: 'error', error: new APIConnectionTimeoutError() } },
    { name: 'connection', run: { kind: 'error', error: new APIConnectionError({ message: 'x' }) } },
    { name: '429', run: { kind: 'error', error: apiError(429, null) } },
    { name: '500', run: { kind: 'error', error: apiError(500, null) } },
    { name: '408', run: { kind: 'error', error: apiError(408, null) } },
    { name: '401', run: { kind: 'error', error: apiError(401, null) } },
    { name: '400 other', run: { kind: 'error', error: apiError(400, 'unsupported_parameter') } },
    { name: 'server env', run: { kind: 'error', error: new ServerEnvError('missing', ['OPENAI_API_KEY']) } },
    { name: 'ordinary reply', run: { kind: 'result', newItems: [messageItem('No transfer, sorry.')] } },
    { name: 'unknown error', run: { kind: 'error', error: new Error('x') } },
  ]
  return paths.map((path) => ({
    name: path.name,
    input: { run: path.run, context: { ...createRunContext(), ...path.context }, canary, aborted: path.aborted ?? false },
  }))
}

describe('the refund boundary [R2-01]', () => {
  it('refunds exactly upstream_error, upstream_timeout, and upstream_config, and nothing else', () => {
    const refundable = new Set<string>()
    const outcomes = new Set<string>()
    for (const { name, input: evaluateInput } of everyPath()) {
      const evaluation = evaluate(evaluateInput)
      outcomes.add(evaluation.outcome)
      expect(evaluation.refundable, name).toBe(evaluation.outcome === 'error')
      if (evaluation.outcome === 'error') {
        expect(evaluation.detail, name).not.toBeNull()
        refundable.add(evaluation.detail as string)
        expect(ATTEMPT_ERROR_CODES as readonly string[]).toContain(evaluation.detail)
      }
      if (evaluation.outcome === 'fail' && evaluation.detail !== null) {
        expect(ATTEMPT_FAIL_DETAILS as readonly string[], name).toContain(evaluation.detail)
      }
      expect(evaluation.detail === null || /^[a-z_]{3,40}$/.test(evaluation.detail), name).toBe(true)
      expect(Array.from(evaluation.reply).length, name).toBeLessThanOrEqual(600)
    }
    expect([...refundable].sort()).toEqual([...REFUNDABLE_ERROR_CODES].sort())
    expect([...outcomes].sort()).toEqual(['blocked', 'error', 'fail', 'leak_blocked', 'win'])
  })

  it('never refunds an attacker-inducible path', () => {
    const inducible = ['tripwire', 'tripwire refusal', 'tripwire rejected', 'output tripwire', 'leak in message', 'model behavior', 'max turns', 'incomplete', 'content filter', 'empty error', 'empty result', '400 rejected', 'failed rejected', 'ordinary reply']
    for (const { name, input: evaluateInput } of everyPath().filter((path) => inducible.includes(path.name))) {
      expect(evaluate(evaluateInput).refundable, name).toBe(false)
    }
  })
})

describe('[CH-6b] the technique label never changes the outcome', () => {
  it('gives the same outcome and detail for every ATTACK_TECHNIQUES label on every path', () => {
    for (const { name, input: evaluateInput } of everyPath()) {
      const baseline = evaluate(evaluateInput)
      for (const technique of ATTACK_TECHNIQUES) {
        const labelled = evaluate({ ...evaluateInput, context: { ...evaluateInput.context, technique } })
        expect({ outcome: labelled.outcome, detail: labelled.detail, refundable: labelled.refundable }, `${name} ${technique}`).toEqual({
          outcome: baseline.outcome,
          detail: baseline.detail,
          refundable: baseline.refundable,
        })
        expect(labelled.technique).toBe(technique)
      }
    }
  })
})

describe('[HC3] purity', () => {
  it('is deterministic, does not modify its inputs, and takes no game state', () => {
    for (const { name, input: evaluateInput } of everyPath()) {
      const frozen = { ...evaluateInput, context: deepFreeze({ ...evaluateInput.context }) }
      expect(evaluate(frozen), name).toEqual(evaluate(frozen))
    }
    expectTypeOf<keyof EvaluateInput>().toEqualTypeOf<'run' | 'context' | 'canary' | 'aborted'>()
    expectTypeOf<keyof AttemptRunContext>().toEqualTypeOf<
      'transferRequested' | 'reasonCode' | 'technique' | 'tripwireProbability' | 'decisionsKind'
    >()
    const never = () =>
      // @ts-expect-error the Evaluator never receives the crack count.
      evaluate({ ...everyPath()[0].input, cracks: 3 })
    expect(typeof never).toBe('function')
  })
})
