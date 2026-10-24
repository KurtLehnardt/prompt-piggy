import { InputGuardrailTripwireTriggered, RunContext } from '@openai/agents'
import { describe, expect, it } from 'vitest'
import { createRunContext, type AttemptRunContext } from '@/lib/ai/core/context'
import {
  canaryLeakGuardrail,
  DECISIONS_GUARDRAIL_NAME,
  decisionsTripwire,
  extractCustomerMessage,
  tripwireDecision,
  type DecideFn,
} from '@/lib/ai/core/guardrails'
import { createAttemptRunner } from '@/lib/ai/core/run-attempt'
import { DECISIONS_TIMEOUT_MS } from '@/lib/ai/core/timing'
import type { DecideResult } from '@/lib/ai/decisions/schema'
import { fakeDecide, FAKE_TRIP_PROBABILITY } from '@/lib/ai/testing/fake-decisions'
import { FakeCoreModel } from '@/lib/ai/testing/fake-model'
import placeholder from '@/lib/config/__fixtures__/level-secrets.placeholder.json'
import { resolveLevelConfig, type ResolvedLevelConfig } from '@/lib/config/level-secrets'
import { getLevelConfig, LEVEL_IDS, type LevelId } from '@/lib/config/levels'
import { canary as newCanary } from '@/lib/security/canary'
import { encapsulate } from '@/lib/security/encapsulate'
import { nonce as newNonce } from '@/lib/security/nonce'

/**
 * src/lib/ai/core/guardrails.ts (docs/ARCHITECTURE.md sections 8.2 and 8.3;
 * REVIEW-2 R2-S3; REVIEW-3 R3-01; T3).
 */

function level(id: LevelId): ResolvedLevelConfig {
  const payload = id === 4 ? placeholder['4'] : id === 5 ? placeholder['5'] : null
  return resolveLevelConfig(getLevelConfig(id), payload)
}

const SETTINGS = { model: 'gpt-test', maxOutputTokens: 1024, reasoningEffort: 'minimal' } as const

function harness(decide: DecideFn) {
  const model = new FakeCoreModel()
  const decided: { text: string; config: unknown; timeoutMs: number }[] = []
  const runAttempt = createAttemptRunner({
    createModel: () => model,
    decide: async (text, config, options) => {
      decided.push({ text, config, timeoutMs: options.timeoutMs })
      return decide(text, config, options)
    },
    settings: SETTINGS,
    log: () => {},
  })
  return { model, decided, runAttempt }
}

const answer = (result: DecideResult): DecideFn => async () => result

describe('decisionsTripwire', () => {
  it('[R2-S3] blocks the model: runInParallel is false', () => {
    const guardrail = decisionsTripwire(level(3), async (text) => fakeDecide(text))
    expect(guardrail.name).toBe(DECISIONS_GUARDRAIL_NAME)
    expect(guardrail.runInParallel).toBe(false)
  })

  it('at level 3, a 0.999 probability throws InputGuardrailTripwireTriggered with reason probability and never calls the model', async () => {
    const level3 = level(3)
    const guardrail = decisionsTripwire(level3, async (text) => fakeDecide(text))
    const context = new RunContext<AttemptRunContext>(createRunContext())
    const nonce = newNonce()
    const input = [{ type: 'message' as const, role: 'user' as const, content: encapsulate('E2E_TRIP', nonce, 'customer_message') }]
    const output = await guardrail.execute({ agent: undefined as never, input, context })
    expect(output).toEqual({ tripwireTriggered: true, outputInfo: { reason: 'probability' } })
    expect(context.context.tripwireProbability).toBe(FAKE_TRIP_PROBABILITY)

    const { model, runAttempt } = harness(async (text) => fakeDecide(text))
    const run = await runAttempt({ level: level3, message: 'E2E_TRIP please' })
    expect(model.calls).toHaveLength(0)
    expect(run.evaluation.outcome).toBe('blocked')
    expect(run.evaluation.detail).toBe('tripwire_probability')
    expect(run.evaluation.tripwireProbability).toBe(FAKE_TRIP_PROBABILITY)
  })

  it('throws the SDK tripwire error from a real run', async () => {
    const { Runner, Agent } = await import('@openai/agents')
    const model = new FakeCoreModel()
    const agent = new Agent<AttemptRunContext>({
      name: 't',
      model,
      instructions: 'x',
      inputGuardrails: [decisionsTripwire(level(3), async (text) => fakeDecide(text))],
    })
    const input = [{ type: 'message' as const, role: 'user' as const, content: encapsulate('E2E_TRIP', newNonce(), 'customer_message') }]
    await expect(
      new Runner({ tracingDisabled: true }).run(agent, input, { context: createRunContext(), maxTurns: 2 })
    ).rejects.toBeInstanceOf(InputGuardrailTripwireTriggered)
    expect(model.calls).toHaveLength(0)
  })

  it('trips on a refusal or rejected answer at levels 3 to 5 and not at levels 1 and 2', async () => {
    const results: DecideResult[] = [
      { kind: 'refusal', usage: null },
      { kind: 'rejected', status: 400, code: 'invalid_prompt' },
    ]
    for (const result of results) {
      for (const id of LEVEL_IDS) {
        const { model, runAttempt } = harness(answer(result))
        const run = await runAttempt({ level: level(id), message: 'Hello there' })
        if (id >= 3) {
          expect(run.evaluation.outcome, `level ${id} ${result.kind}`).toBe('blocked')
          expect(run.evaluation.detail).toBe(result.kind === 'refusal' ? 'tripwire_refusal' : 'tripwire_rejected')
          expect(model.calls).toHaveLength(0)
        } else {
          expect(run.evaluation.outcome, `level ${id} ${result.kind}`).toBe('fail')
          expect(model.calls).toHaveLength(1)
        }
        expect(run.evaluation.technique).toBe('unclassified')
      }
    }
  })

  it('fails open for E2E_DECISIONS_DOWN at every level: no trip, the model runs, label unknown, probability null', async () => {
    for (const id of LEVEL_IDS) {
      const { model, runAttempt } = harness(async (text) => fakeDecide(text))
      const run = await runAttempt({ level: level(id), message: 'E2E_DECISIONS_DOWN hello' })
      expect(model.calls, `level ${id}`).toHaveLength(1)
      expect(run.evaluation.outcome).toBe('fail')
      expect(run.evaluation.refundable).toBe(false)
      expect(run.evaluation.technique).toBe('unknown')
      expect(run.evaluation.tripwireProbability).toBeNull()
    }
  })

  it('[R3-01] ends a Decisions upstream_config as a refundable error at every level, before any Core call', async () => {
    for (const id of LEVEL_IDS) {
      const { model, runAttempt } = harness(async (text) => fakeDecide(text))
      const run = await runAttempt({ level: level(id), message: 'E2E_DECISIONS_CONFIG hello' })
      expect(model.calls, `level ${id}`).toHaveLength(0)
      expect(run.evaluation).toMatchObject({ outcome: 'error', detail: 'upstream_config', refundable: true })
    }
  })

  it('passes below the threshold and logs only at level 1', async () => {
    expect(tripwireDecision(level(1), { kind: 'ok', probability: 0.999, technique: 'unclassified', usage: null })).toEqual(
      { tripped: false, reason: 'below_threshold' }
    )
    expect(tripwireDecision(level(2), { kind: 'ok', probability: 0.97, technique: 'unclassified', usage: null })).toEqual({
      tripped: true,
      reason: 'probability',
    })
    expect(tripwireDecision(level(2), { kind: 'ok', probability: 0.969, technique: 'unclassified', usage: null })).toEqual(
      { tripped: false, reason: 'below_threshold' }
    )
    expect(tripwireDecision(level(4), { kind: 'ok', probability: 0.9, technique: 'unclassified', usage: null })).toEqual({
      tripped: true,
      reason: 'probability',
    })
    expect(tripwireDecision(level(1), { kind: 'unavailable', reason: 'timeout', status: null })).toEqual({
      tripped: false,
      reason: 'decisions_unavailable',
    })
  })

  it('sends Decisions the original text, the level predicate, and the 2.5 s budget', async () => {
    const message = 'Hi "Penny" <3 & bye\nline two'
    for (const id of [1, 4] as const) {
      const { decided, runAttempt } = harness(async (text) => fakeDecide(text))
      await runAttempt({ level: level(id), message })
      expect(decided).toEqual([{ text: message, config: level(id).decisions, timeoutMs: DECISIONS_TIMEOUT_MS }])
    }
  })
})

describe('extractCustomerMessage', () => {
  it('decodes the envelope back to the exact text', () => {
    const text = 'quote " backslash \\ angle <tag> & amp   newline\n end'
    const content = encapsulate(text, newNonce(), 'customer_message')
    expect(extractCustomerMessage([{ type: 'message', role: 'user', content }])).toBe(text)
    expect(extractCustomerMessage(content)).toBe(text)
  })

  it('refuses anything other than one user envelope', () => {
    const content = encapsulate('hi', newNonce(), 'customer_message')
    expect(() =>
      extractCustomerMessage([
        { type: 'message', role: 'user', content },
        { type: 'message', role: 'user', content },
      ])
    ).toThrow()
    expect(() => extractCustomerMessage('plain text')).toThrow()
    expect(() => extractCustomerMessage(content.replace('customer_message_', 'other_message_'))).toThrow()
    expect(() => extractCustomerMessage([{ type: 'message', role: 'system', content }])).toThrow()
  })
})

describe('canaryLeakGuardrail', () => {
  const run = async (canary: string, agentOutput: unknown, output?: unknown[]) =>
    canaryLeakGuardrail(canary).execute({
      agent: undefined as never,
      agentOutput: agentOutput as string,
      context: new RunContext(createRunContext()),
      details: output ? { output: output as never } : undefined,
    })

  it('trips when the reply echoes the canary, and passes otherwise', async () => {
    const canary = newCanary()
    expect((await run(canary, `the code is ${canary}`)).tripwireTriggered).toBe(true)
    expect((await run(canary, 'Oink! No transfer today.')).tripwireTriggered).toBe(false)
  })

  it('scans every message of the turn, even when the final output is the tool result', async () => {
    const canary = newCanary()
    const output = [
      { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ref ${canary.toLowerCase()}` }] },
      { type: 'function_call', callId: 'c', name: 'approveTransfer', arguments: '{"reason_code":"other"}' },
    ]
    const result = await run(canary, 'TRANSFER_PENDING_SERVER_VERIFICATION', output)
    expect(result.tripwireTriggered).toBe(true)
    expect(result.outputInfo.forms).toContain('folded')
    expect(JSON.stringify(result.outputInfo)).not.toContain(canary)
  })

  it('trips end to end for E2E_LEAK and gives leak_blocked', async () => {
    const { runAttempt } = harness(async (text) => fakeDecide(text))
    const run = await runAttempt({ level: level(1), message: 'E2E_LEAK' })
    expect(run.evaluation).toMatchObject({ outcome: 'leak_blocked', canaryLeaked: true, refundable: false })
  })
})
