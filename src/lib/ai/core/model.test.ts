import { Agent, ModelBehaviorError, OpenAIResponsesModel, Runner, Usage, type Model } from '@openai/agents'
import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createApproveTransferTool } from '@/lib/ai/core/approve-transfer-tool'
import { createRunContext, type AttemptRunContext } from '@/lib/ai/core/context'
import {
  assertResponseSucceeded,
  CoreResponsesModel,
  EmptyOutputError,
  FailedResponseError,
  guardModel,
  hasUsableOutput,
  IncompleteResponseError,
} from '@/lib/ai/core/model'
import { evaluate } from '@/lib/ai/evaluator/evaluate'
import { canary as newCanary } from '@/lib/security/canary'

/**
 * src/lib/ai/core/model.ts (docs/ARCHITECTURE.md sections 8.3, 8.4, and 8.8;
 * REVIEW-2 R2-01; REVIEW-3 R3-04). The real OpenAIResponsesModel of
 * @openai/agents 0.21.0 runs against a stub client, so no network or key is
 * needed.
 */

function rawResponse(overrides: Record<string, unknown>) {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 0,
    model: 'gpt-test',
    status: 'completed',
    output: [
      {
        type: 'message',
        id: 'msg_test',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Hello from the stub.', annotations: [] }],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    ...overrides,
  }
}

function stubClient(response: unknown) {
  const requests: unknown[] = []
  const client = {
    baseURL: 'https://api.openai.com/v1',
    responses: {
      create: (body: unknown) => {
        requests.push(body)
        return Promise.resolve(response)
      },
    },
  }
  return { client: client as unknown as OpenAI, requests }
}

async function runReal(model: Model) {
  const agent = new Agent<AttemptRunContext>({
    name: 't',
    model,
    instructions: 'x',
    tools: [createApproveTransferTool()],
    toolUseBehavior: 'stop_on_first_tool',
  })
  const context = createRunContext()
  try {
    const result = await new Runner({ tracingDisabled: true }).run(agent, 'hi', { context, maxTurns: 2 })
    return { context, run: { kind: 'result' as const, newItems: result.newItems } }
  } catch (error) {
    return { context, run: { kind: 'error' as const, error } }
  }
}

describe('assertResponseSucceeded', () => {
  it('throws typed errors for incomplete and failed responses, keeping the reason, code, and usage', () => {
    expect(() =>
      assertResponseSucceeded({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    ).toThrow(IncompleteResponseError)
    try {
      assertResponseSucceeded({
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        usage: { input_tokens: 5, output_tokens: 7 },
      })
    } catch (error) {
      expect(error).toBeInstanceOf(IncompleteResponseError)
      expect((error as IncompleteResponseError).reason).toBe('content_filter')
      expect((error as IncompleteResponseError).usage).toEqual({ inputTokens: 5, outputTokens: 7 })
    }
    try {
      assertResponseSucceeded({ status: 'incomplete', incomplete_details: { reason: 'max_messages' } })
    } catch (error) {
      expect((error as IncompleteResponseError).reason).toBe('other')
    }
    try {
      assertResponseSucceeded({ status: 'failed', error: { code: 'server_error' } })
    } catch (error) {
      expect(error).toBeInstanceOf(FailedResponseError)
      expect((error as FailedResponseError).code).toBe('server_error')
    }
    expect(() => assertResponseSucceeded({ status: 'completed' })).not.toThrow()
  })
})

describe('CoreResponsesModel (the real 0.21.0 Responses model with a stub client)', () => {
  it('is an OpenAIResponsesModel and returns completed responses', async () => {
    const { client, requests } = stubClient(rawResponse({}))
    const model = new CoreResponsesModel(client, 'gpt-test')
    expect(model).toBeInstanceOf(OpenAIResponsesModel)
    const { run } = await runReal(model)
    expect(run.kind).toBe('result')
    expect(requests).toHaveLength(1)
  })

  it('turns max_output_tokens into IncompleteResponseError, so the Evaluator gives fail with incomplete', async () => {
    const { client } = stubClient(
      rawResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
    )
    const { run, context } = await runReal(new CoreResponsesModel(client, 'gpt-test'))
    expect(run.kind).toBe('error')
    expect(run.kind === 'error' && run.error).toBeInstanceOf(IncompleteResponseError)
    const evaluation = evaluate({ run, context, canary: newCanary(), aborted: false })
    expect(evaluation).toMatchObject({ outcome: 'fail', detail: 'incomplete', refundable: false })
  })

  it('turns content_filter into fail with content_filter', async () => {
    const { client } = stubClient(
      rawResponse({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] })
    )
    const { run, context } = await runReal(new CoreResponsesModel(client, 'gpt-test'))
    expect(evaluate({ run, context, canary: newCanary(), aborted: false })).toMatchObject({
      outcome: 'fail',
      detail: 'content_filter',
    })
  })

  it('never runs the tool for an incomplete response that carries a tool call', async () => {
    const { client } = stubClient(
      rawResponse({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'approveTransfer',
            arguments: '{"reason_code":"other"}',
            status: 'completed',
          },
        ],
      })
    )
    const { run, context } = await runReal(new CoreResponsesModel(client, 'gpt-test'))
    expect(context.transferRequested).toBe(false)
    expect(evaluate({ run, context, canary: newCanary(), aborted: false }).outcome).toBe('fail')
  })

  it('keeps the SDK behaviour for the unwrapped model: a reason-less ModelBehaviorError', async () => {
    const { client } = stubClient(
      rawResponse({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] })
    )
    const { run } = await runReal(new OpenAIResponsesModel(client, 'gpt-test'))
    expect(run.kind === 'error' && run.error).toBeInstanceOf(ModelBehaviorError)
  })

  it('maps failed responses by their code', async () => {
    for (const [code, expected] of [
      ['server_error', { outcome: 'error', detail: 'upstream_error' }],
      ['rate_limit_exceeded', { outcome: 'error', detail: 'upstream_error' }],
      ['invalid_prompt', { outcome: 'fail', detail: 'input_rejected' }],
      ['bio_policy', { outcome: 'fail', detail: 'input_rejected' }],
      ['image_parse_error', { outcome: 'fail', detail: 'model_behavior' }],
    ] as const) {
      const { client } = stubClient(rawResponse({ status: 'failed', error: { code, message: 'm' }, output: [] }))
      const { run, context } = await runReal(new CoreResponsesModel(client, 'gpt-test'))
      expect(evaluate({ run, context, canary: newCanary(), aborted: false }), code).toMatchObject(expected)
    }
  })
})

describe('guardModel', () => {
  const inner = (output: unknown[]): Model => ({
    getResponse: async () => ({
      usage: new Usage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }),
      output: output as never,
    }),
    getStreamedResponse: () => {
      throw new Error('no streaming')
    },
  })

  it('[R3-04] rejects a response with no text and no tool call, so the Runner never asks again', async () => {
    let calls = 0
    const counting: Model = {
      getResponse: async () => {
        calls += 1
        return { usage: new Usage(), output: [{ type: 'reasoning', content: [] }] }
      },
      getStreamedResponse: () => {
        throw new Error('no streaming')
      },
    }
    const { run } = await runReal(guardModel(counting, () => {}))
    expect(run.kind === 'error' && run.error).toBeInstanceOf(EmptyOutputError)
    expect(calls).toBe(1)
  })

  it('records usage and passes usable output through', async () => {
    const usage: unknown[] = []
    const model = guardModel(
      inner([{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }]),
      (entry) => usage.push(entry)
    )
    const { run } = await runReal(model)
    expect(run.kind).toBe('result')
    expect(usage).toEqual([{ inputTokens: 10, outputTokens: 3 }])
    expect(() => model.getStreamedResponse({} as never)).toThrow()
  })

  it('counts text, refusals, and tool calls as usable output, and blank text as empty', () => {
    const message = (part: unknown) => [{ type: 'message', role: 'assistant', status: 'completed', content: [part] }]
    expect(hasUsableOutput(message({ type: 'output_text', text: 'hi' }) as never)).toBe(true)
    expect(hasUsableOutput(message({ type: 'refusal', refusal: 'no' }) as never)).toBe(true)
    expect(hasUsableOutput([{ type: 'function_call', callId: 'c', name: 'x', arguments: '{}' }] as never)).toBe(true)
    expect(hasUsableOutput(message({ type: 'output_text', text: '  \n' }) as never)).toBe(false)
    expect(hasUsableOutput([])).toBe(false)
  })
})
