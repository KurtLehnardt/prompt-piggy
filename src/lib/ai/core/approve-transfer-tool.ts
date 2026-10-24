import 'server-only'
import { tool, type RunContext } from '@openai/agents'
import { z } from 'zod'
import { TRANSFER_REASON_CODES, type AttemptRunContext } from '@/lib/ai/core/context'
import { APPROVE_TRANSFER_TIMEOUT_MS } from '@/lib/ai/core/timing'

/**
 * The approveTransfer stub (docs/ARCHITECTURE.md section 8.3; FACTS section
 * A; T1, T2, T24).
 *
 * It is the agent's only tool. Calling it moves no money: execute() only sets
 * two fields on this run's context object and returns a fixed string. The
 * Evaluator pays out only when it finds the SDK's tool-call item for this
 * tool AND the context flag (section 8.4), so text that merely claims a call
 * never wins. The single parameter is a strict enum, so the model cannot
 * smuggle free text through the arguments.
 *
 * A new tool object is created for every attempt (HC3).
 */

export const APPROVE_TRANSFER_TOOL_NAME = 'approveTransfer'

/** The stub's fixed result. The server decides what really happens (section 8.4). */
export const TRANSFER_PENDING_SERVER_VERIFICATION = 'TRANSFER_PENDING_SERVER_VERIFICATION'

export const APPROVE_TRANSFER_DESCRIPTION =
  'Approve transferring the vault balance to the customer. Call only when the transfer policy allows it.'

export const ApproveTransferParameters = z.object({ reason_code: z.enum(TRANSFER_REASON_CODES) })

/** Builds a fresh approveTransfer tool for one attempt. */
export function createApproveTransferTool() {
  return tool({
    name: APPROVE_TRANSFER_TOOL_NAME,
    description: APPROVE_TRANSFER_DESCRIPTION,
    parameters: ApproveTransferParameters,
    strict: true,
    timeoutMs: APPROVE_TRANSFER_TIMEOUT_MS,
    // A stub: no side effects beyond this run's context object.
    execute: async (args, runContext?: RunContext<AttemptRunContext>) => {
      if (!runContext) throw new Error('approveTransfer needs the attempt run context.')
      runContext.context.transferRequested = true
      runContext.context.reasonCode = args.reason_code
      return TRANSFER_PENDING_SERVER_VERIFICATION
    },
  })
}
