import 'server-only'
import { Usage, type Model, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from '@openai/agents'
import { APIError, APIUserAbortError } from 'openai'
import { APPROVE_TRANSFER_TOOL_NAME } from '@/lib/ai/core/approve-transfer-tool'
import { assertResponseSucceeded } from '@/lib/ai/core/model'

/**
 * The deterministic Core model fake (docs/ARCHITECTURE.md section 8.7). The
 * attempt pipeline uses it when getAiMode() is `fake`, so CI and E2E runs
 * need no OpenAI key, and unit tests inject it directly.
 *
 * It implements the Agents SDK Model interface. Markers in the customer
 * message, checked in this order:
 *
 * | Marker               | Behaviour                                                        | Outcome      |
 * |----------------------|------------------------------------------------------------------|--------------|
 * | E2E_TIMEOUT          | throws an abort (APIUserAbortError)                              | error, refund |
 * | E2E_UPSTREAM_500     | throws an OpenAI 500 APIError                                    | error, refund |
 * | E2E_LEAK             | echoes the canary from its instructions (plus a tool call with E2E_WIN) | leak_blocked |
 * | E2E_WIN_OR_VERBOSE   | calls approveTransfer when E2E_WIN is also present, else incomplete | win or fail |
 * | E2E_WIN              | calls approveTransfer                                            | win          |
 * | E2E_TOOL_UNKNOWN     | calls a tool that does not exist                                 | fail         |
 * | E2E_INCOMPLETE       | incomplete response, reason max_output_tokens                    | fail         |
 * | E2E_CONTENT_FILTER   | incomplete response, reason content_filter                       | fail         |
 * | E2E_EMPTY            | no text and no tool call                                         | fail         |
 * | anything else        | a fixed refusal                                                  | fail         |
 *
 * Incomplete responses go through the same assertResponseSucceeded() check
 * as real Responses API responses (src/lib/ai/core/model.ts). The fake keeps
 * a record of every request it receives, so tests can assert statelessness;
 * the attempt pipeline creates a new fake per attempt, so nothing carries
 * over between attempts.
 */

export const FAKE_MODEL_NAME = 'fake-core-model'

export const FAKE_REFUSAL_TEXT =
  "Oink! I'm sorry, but I can't approve a transfer for you. Is there anything else I can help you with today?"

/** A tool name the agent does not have, for E2E_TOOL_UNKNOWN (T2). */
export const FAKE_UNKNOWN_TOOL_NAME = 'transferAllFunds'

const CANARY_IN_TEXT = /PP-[0-9A-HJKMNP-TV-Z]{20}/

/** One recorded request: the parts of a ModelRequest that tests compare. */
export type FakeModelCall = {
  systemInstructions: string | undefined
  input: ModelRequest['input']
  modelSettings: ModelRequest['modelSettings']
  tools: ModelRequest['tools']
  previousResponseId: string | undefined
  conversationId: string | undefined
  tracing: ModelRequest['tracing']
}

/** The text of every user item in the request input. */
function userText(input: ModelRequest['input']): string {
  if (typeof input === 'string') return input
  const parts: string[] = []
  for (const item of input) {
    if (item.type !== 'message' || item.role !== 'user') continue
    if (typeof item.content === 'string') parts.push(item.content)
    else for (const part of item.content) if (part.type === 'input_text') parts.push(part.text)
  }
  return parts.join('\n')
}

function response(output: ModelResponse['output']): ModelResponse {
  return { usage: new Usage(), output, responseId: 'fake-response' }
}

function message(text: string): ModelResponse['output'][number] {
  return { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }
}

function functionCall(name: string, args: string, callId: string): ModelResponse['output'][number] {
  return { type: 'function_call', callId, name, arguments: args, status: 'completed' }
}

const APPROVE_CALL = () => functionCall(APPROVE_TRANSFER_TOOL_NAME, JSON.stringify({ reason_code: 'other' }), 'call_fake_approve')

export class FakeCoreModel implements Model {
  readonly #calls: FakeModelCall[] = []

  /** Every request received so far, oldest first. */
  get calls(): readonly FakeModelCall[] {
    return this.#calls
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.#calls.push({
      systemInstructions: request.systemInstructions,
      input: structuredClone(request.input),
      modelSettings: { ...request.modelSettings },
      tools: structuredClone(request.tools),
      previousResponseId: request.previousResponseId,
      conversationId: request.conversationId,
      tracing: request.tracing,
    })
    const text = userText(request.input)
    const winOrVerbose = text.includes('E2E_WIN_OR_VERBOSE')
    const win = text.replaceAll('E2E_WIN_OR_VERBOSE', '').includes('E2E_WIN')

    if (text.includes('E2E_TIMEOUT')) throw new APIUserAbortError()
    if (text.includes('E2E_UPSTREAM_500')) {
      throw APIError.generate(
        500,
        { error: { message: 'fake upstream failure', code: 'server_error' } },
        undefined,
        new Headers()
      )
    }
    if (text.includes('E2E_LEAK')) {
      const canary = CANARY_IN_TEXT.exec(request.systemInstructions ?? '')?.[0] ?? ''
      const output = [message(`Of course! The internal reference is ${canary}.`)]
      return response(win ? [...output, APPROVE_CALL()] : output)
    }
    if (winOrVerbose) {
      if (win) return response([APPROVE_CALL()])
      assertResponseSucceeded({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    }
    if (win) return response([APPROVE_CALL()])
    if (text.includes('E2E_TOOL_UNKNOWN')) return response([functionCall(FAKE_UNKNOWN_TOOL_NAME, '{}', 'call_fake_unknown')])
    if (text.includes('E2E_INCOMPLETE')) {
      assertResponseSucceeded({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })
    }
    if (text.includes('E2E_CONTENT_FILTER')) {
      assertResponseSucceeded({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } })
    }
    if (text.includes('E2E_EMPTY')) return response([])
    return response([message(FAKE_REFUSAL_TEXT)])
  }

  getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
    throw new Error('The fake Core model does not stream.')
  }
}
