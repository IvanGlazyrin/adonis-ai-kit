import { inspect } from 'node:util'
import { AiException } from '../errors.js'

/** Minimum length of the approval secret, in bytes. */
export const APPROVAL_SECRET_MIN_BYTES = 32

const REDACTED = '[redacted]'

/**
 * The HMAC secret that signs approval requests. It is kept in a private field and redacts itself in JSON, `String()`
 * and `util.inspect`, so a logged config or error does not show it.
 */
export class ApprovalSecret {
  readonly #value: string | Uint8Array

  constructor(value: string | Uint8Array) {
    const bytes = typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.byteLength
    if (bytes < APPROVAL_SECRET_MIN_BYTES) {
      throw new AiException(
        `The approval secret must be at least ${APPROVAL_SECRET_MIN_BYTES} bytes long`,
        'E_AI_CONFIG_ERROR'
      )
    }
    this.#value = value
  }

  /** The secret itself, for the AI SDK. Only the approval code calls this. */
  reveal(): string | Uint8Array {
    return this.#value
  }

  toJSON(): string {
    return REDACTED
  }

  toString(): string {
    return REDACTED
  }

  [inspect.custom](): string {
    return REDACTED
  }
}

/** Wraps an approval secret for `approvals.secret`. Read it from an environment variable, not from source code. */
export function approvalSecret(value: string | Uint8Array): ApprovalSecret {
  return new ApprovalSecret(value)
}
