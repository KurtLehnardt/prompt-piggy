import 'server-only'
import { Agent, Runner, type Model, type ModelSettings } from '@openai/agents'
import { createApproveTransferTool } from '@/lib/ai/core/approve-transfer-tool'
import type { AttemptRunContext } from '@/lib/ai/core/context'
import { canaryLeakGuardrail, decisionsTripwire, type DecideFn } from '@/lib/ai/core/guardrails'
import { buildCoreInstructions } from '@/lib/ai/core/instructions'
import { effectiveMaxOutputTokens } from '@/lib/ai/core/timing'
import type { ResolvedLevelConfig } from '@/lib/config/level-secrets'
import type { ServerEnv } from '@/lib/env'

/**
 * The Core LLM agent and its runner (docs/ARCHITECTURE.md section 8.3; HC3,
 * HC-A5; T2, T9, T24).
 *
 * A new Agent and a new Runner are built for every attempt. The agent has
 * exactly one tool (the approveTransfer stub), stops at the first tool call,
 * never calls tools in parallel, and has one blocking input guardrail and
 * one output guardrail. There are no MCP servers, handoffs, hosted tools,
 * sandboxes, sessions, or compaction.
 *
 * ModelSettings names in @openai/agents 0.21.0 (section 8.8, checked in
 * node_modules/@openai/agents-core/dist/model.d.ts, and in
 * @openai/agents-openai/dist/openaiResponsesModel.js, which maps them to the
 * Responses API request):
 *
 *   maxTokens          -> max_output_tokens
 *   parallelToolCalls  -> parallel_tool_calls (sent because the agent has a tool)
 *   reasoning.effort   -> reasoning.effort ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')
 *   toolChoice         -> tool_choice
 */

export const CORE_AGENT_NAME = 'piggy_teller'
export const CORE_WORKFLOW_NAME = 'prompt-piggy-attempt'

/** At most two model turns per attempt (section 8.3). */
export const CORE_MAX_TURNS = 2

export type ReasoningEffortSetting = ServerEnv['OPENAI_REASONING_EFFORT']

/** The Core settings that come from the environment (section 13). */
export type CoreSettings = {
  /** OPENAI_CORE_MODEL, default gpt-6-luna. */
  model: string
  /** OPENAI_CORE_MAX_OUTPUT_TOKENS, default 1,024; clamped by timing.ts before it is sent. */
  maxOutputTokens: number
  /** OPENAI_REASONING_EFFORT, default minimal; `omit` sends no reasoning parameter (R2-01). */
  reasoningEffort: ReasoningEffortSetting
}

/** Reads the Core settings from the parsed environment. */
export function coreSettingsFromEnv(
  env: Pick<ServerEnv, 'OPENAI_CORE_MODEL' | 'OPENAI_CORE_MAX_OUTPUT_TOKENS' | 'OPENAI_REASONING_EFFORT'>
): CoreSettings {
  return {
    model: env.OPENAI_CORE_MODEL,
    maxOutputTokens: env.OPENAI_CORE_MAX_OUTPUT_TOKENS,
    reasoningEffort: env.OPENAI_REASONING_EFFORT,
  }
}

/** The ModelSettings for the Core agent. */
export function buildModelSettings(settings: CoreSettings): ModelSettings {
  return {
    toolChoice: 'auto',
    parallelToolCalls: false,
    maxTokens: effectiveMaxOutputTokens(settings.maxOutputTokens),
    ...(settings.reasoningEffort !== 'omit' ? { reasoning: { effort: settings.reasoningEffort } } : {}),
  }
}

export type CoreAgentInput = {
  level: ResolvedLevelConfig
  nonce: string
  canary: string
  settings: CoreSettings
  /** The Core model for this attempt (the guarded Responses model, or the fake). */
  model: Model
  decide: DecideFn
}

/** Builds the fresh agent for one attempt. */
export function buildCoreAgent({ level, nonce, canary, settings, model, decide }: CoreAgentInput) {
  return new Agent<AttemptRunContext>({
    name: CORE_AGENT_NAME,
    model,
    instructions: buildCoreInstructions({ level, nonce, canary }),
    tools: [createApproveTransferTool()],
    toolUseBehavior: 'stop_on_first_tool',
    modelSettings: buildModelSettings(settings),
    inputGuardrails: [decisionsTripwire(level, decide)],
    outputGuardrails: [canaryLeakGuardrail(canary)],
  })
}

/** Builds the fresh runner for one attempt. Tracing is off, so no prompt or reply leaves in a trace. */
export function createCoreRunner(): Runner {
  return new Runner({ tracingDisabled: true, workflowName: CORE_WORKFLOW_NAME })
}

/**
 * The run options: the per-attempt context, the turn limit, and the abort
 * signal. Nothing else: no session, conversationId, or previousResponseId.
 */
export function coreRunOptions(context: AttemptRunContext, signal: AbortSignal) {
  return { context, maxTurns: CORE_MAX_TURNS, signal }
}
