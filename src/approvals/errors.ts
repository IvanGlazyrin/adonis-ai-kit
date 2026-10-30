import { AiException } from '../errors.js'

/** No open approval has this id in this conversation (unknown, already decided, or from another conversation). */
export class ApprovalNotFoundError extends AiException {
  constructor() {
    super('Tool approval not found', 'E_AI_APPROVAL_NOT_FOUND')
    this.name = 'ApprovalNotFoundError'
  }
}

/** A paused step needs one decision for each of its approvals, in the same call. Nothing was written. */
export class ApprovalIncompleteError extends AiException {
  constructor(public missing: string[]) {
    super(`Every approval of the step needs a decision in the same call (missing: ${missing.join(', ')})`, 'E_AI_APPROVAL_INCOMPLETE')
    this.name = 'ApprovalIncompleteError'
  }
}

/**
 * The model's approval request does not match its signature (the stored call was changed, or the signature is missing).
 * The tool did not run, and the step was closed with a denial.
 */
export class ApprovalSignatureError extends AiException {
  constructor() {
    super('Tool approval signature is invalid; the step was closed with a denial', 'E_AI_APPROVAL_INVALID')
    this.name = 'ApprovalSignatureError'
  }
}
