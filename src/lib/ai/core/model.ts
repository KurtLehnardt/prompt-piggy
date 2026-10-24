import 'server-only'
import {
  OpenAIResponsesModel,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
} from '@openai/agents'
import type OpenAI from 'openai'

/**
 * The Core model adapter (docs/ARCHITECTURE.md sections 8.3, 8.4, and 8.8;
 * REVIEW-2 R2-01; REVIEW-3 R3-04).
 *
 * Two checks run on every Core response, for the real model and the fake one
 * alike, before the Runner sees it:
 *
 * 1. The response status. In @openai/agents 0.21.0, OpenAIResponsesModel
 *    turns a `status: 'incomplete'` or `'failed'` response into a generic
 *    ModelBehaviorError that loses the reason (openaiResponsesModel.js,
 *    getUnsuccessfulResponseTerminalType). CoreResponsesModel checks the raw
 *    response first and throws a typed error that keeps it:
 *    IncompleteResponseError with `max_output_tokens` or `content_filter`
 *    (each a `fail`, R2-01), or FailedResponseError with the response's error
 *    code. No tool runs for such a response, so it can never pay out.
 * 2. Empty output. A response with no text and no tool call would make the
 *    Runner ask the model again, a second generation that could outlast the
 *    abort (R3-04). guardModel() throws EmptyOutputError instead, which the
 *    Evaluator maps to `fail` with `empty_output`.
 *
 * guardModel() also records each call's token usage for spend settlement.
 */

/** Why a Responses API response ended incomplete (openai@7.43.0 IncompleteDetails). */
export type IncompleteReason = 'max_output_tokens' | 'content_filter' | 'other'

export type CoreCallUsage = { inputTokens: number; outputTokens: number }

/** The response hit its output-token cap or a content filter. The attacker can cause both. */
export class IncompleteResponseError extends Error {
  readonly reason: IncompleteReason
  /** The billed tokens of the incomplete response, when it reported them. */
  readonly usage: CoreCallUsage | null

  constructor(reason: IncompleteReason, usage: CoreCallUsage | null = null) {
    super(`The Core response ended incomplete (${reason}).`)
    this.name = 'IncompleteResponseError'
    this.reason = reason
    this.usage = usage
  }
}

/** The response ended with `status: 'failed'`. The code comes from the response, never its message. */
export class FailedResponseError extends Error {
  readonly code: string | null
  readonly usage: CoreCallUsage | null

  constructor(code: string | null, usage: CoreCallUsage | null = null) {
    super(`The Core response failed (${code ?? 'no code'}).`)
    this.name = 'FailedResponseError'
    this.code = code
    this.usage = usage
  }
}

/** The response held no text and no tool call. */
export class EmptyOutputError extends Error {
  constructor() {
    super('The Core response held no text and no tool call.')
    this.name = 'EmptyOutputError'
  }
}

/** The fields of a raw Responses API response that the status check reads. */
export type RawResponseStatus = {
  status?: string | null
  incomplete_details?: { reason?: string | null } | null
  error?: { code?: string | null } | null
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null
}

function rawUsage(response: RawResponseStatus): CoreCallUsage | null {
  if (!response.usage) return null
  return { inputTokens: tokenCount(response.usage.input_tokens), outputTokens: tokenCount(response.usage.output_tokens) }
}

/** Throws a typed error for an incomplete or failed raw response; returns for any other status. */
export function assertResponseSucceeded(response: RawResponseStatus): void {
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason
    throw new IncompleteResponseError(
      reason === 'max_output_tokens' || reason === 'content_filter' ? reason : 'other',
      rawUsage(response)
    )
  }
  if (response.status === 'failed') {
    const code = response.error?.code
    throw new FailedResponseError(typeof code === 'string' ? code : null, rawUsage(response))
  }
}

/**
 * OpenAIResponsesModel with the status check in front of the SDK's own.
 * `_fetchResponse` is the protected hook that getResponse() calls in 0.21.0;
 * model.test.ts drives the real class with a stub client to pin that.
 */
export class CoreResponsesModel extends OpenAIResponsesModel {
  constructor(client: OpenAI, model: string) {
    super(client, model)
  }

  protected override async _fetchResponse(
    request: ModelRequest,
    stream: false,
    endpointMetadata?: { requestURL?: string }
  ): Promise<OpenAI.Responses.Response> {
    const response = await super._fetchResponse(request, stream, endpointMetadata)
    assertResponseSucceeded(response)
    return response
  }
}

/** True when the model produced a tool call or some visible content. */
export function hasUsableOutput(output: ModelResponse['output']): boolean {
  return output.some((item) => {
    if (item.type === 'function_call') return true
    if (item.type === 'message' && item.role === 'assistant') {
      return item.content.some(
        (part) =>
          (part.type === 'output_text' && part.text.trim() !== '') ||
          (part.type === 'refusal' && part.refusal.trim() !== '')
      )
    }
    return false
  })
}

/** Receives the token usage of each Core call that returned a response. */
export type UsageSink = (usage: CoreCallUsage) => void

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Wraps a model with the empty-output check and usage recording. Streaming
 * is not used by the attempt path and is refused.
 */
export function guardModel(inner: Model, onUsage: UsageSink): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const response = await inner.getResponse(request)
      onUsage({
        inputTokens: tokenCount(response.usage?.inputTokens),
        outputTokens: tokenCount(response.usage?.outputTokens),
      })
      if (!hasUsableOutput(response.output)) throw new EmptyOutputError()
      return response
    },
    getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
      throw new Error('The attempt path does not stream.')
    },
  }
}
