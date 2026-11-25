import type Configure from '@adonisjs/core/commands/configure'
import { stubsRoot } from './stubs/main.js'

/**
 * Runs on `node ace add adonis-ai-kit` and `node ace configure adonis-ai-kit`:
 * registers the provider and the Ace commands, defines the env variables and
 * creates `config/ai.ts` (an existing file is kept).
 */
export async function configure(command: Configure): Promise<void> {
  const codemods = await command.createCodemods()

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('adonis-ai-kit/providers/ai_provider')
    rcFile.addCommand('adonis-ai-kit/commands')
  })

  await codemods.defineEnvVariables({ OPENAI_API_KEY: '' }, { omitFromExample: [] })
  await codemods.defineEnvValidations({
    leadingComment: 'adonis-ai-kit',
    variables: {
      OPENAI_API_KEY: 'Env.schema.string.optional()',
      ANTHROPIC_API_KEY: 'Env.schema.string.optional()',
    },
  })

  await codemods.makeUsingStub(stubsRoot, 'config/ai.stub', {})

  const publishMigration = await command.prompt.confirm(
    'Publish the conversations migration? (needs @adonisjs/lucid)',
    { default: false }
  )
  if (publishMigration) {
    await codemods.makeUsingStub(stubsRoot, 'migrations/create_ai_conversations_tables.stub', {})
  }
}
