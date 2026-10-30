import { AiException } from '../errors.js'

/**
 * The conversation does not exist, or belongs to another owner. Both cases give the same error, so the message does
 * not reveal which one it is, nor the owner.
 */
export class ConversationNotFoundError extends AiException {
  constructor() {
    super('Conversation not found', 'E_AI_CONVERSATION_NOT_FOUND')
    this.name = 'ConversationNotFoundError'
  }
}

/** The conversation changed since it was read (its version is not the expected one). Nothing was appended. */
export class ConversationConflictError extends AiException {
  constructor(public conversationId: string, public expectedVersion: number) {
    super(
      `Conversation was changed by another request (expected version ${expectedVersion})`,
      'E_AI_CONVERSATION_CONFLICT'
    )
    this.name = 'ConversationConflictError'
  }
}

/** A stored message does not match the `ModelMessage` format, so the history cannot be sent to a model. */
export class ConversationCorruptError extends AiException {
  constructor(public conversationId: string, detail: string) {
    super(`Stored conversation is unreadable: ${detail}`, 'E_AI_CONVERSATION_CORRUPT')
    this.name = 'ConversationCorruptError'
  }
}
