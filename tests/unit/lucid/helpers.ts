import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AppFactory } from '@adonisjs/core/factories/app'
import { EmitterFactory } from '@adonisjs/core/factories/events'
import { LoggerFactory } from '@adonisjs/core/factories/logger'
import { Database } from '@adonisjs/lucid/database'
import type { DatabaseConfig } from '@adonisjs/lucid/types/database'

export interface TestDatabaseHandle {
  db: Database
  /** Opens a second `Database` pointing at the same file/server (to verify durability across restarts). */
  reopen(): Promise<Database>
  close(): Promise<void>
}

function buildConfig(sqlitePath: string): DatabaseConfig {
  if (process.env.LUCID_TEST_CLIENT === 'pg') {
    return {
      connection: 'pg',
      connections: {
        pg: {
          client: 'pg',
          connection: {
            host: process.env.PG_HOST ?? '127.0.0.1',
            port: Number(process.env.PG_PORT ?? 5432),
            user: process.env.PG_USER ?? 'postgres',
            password: process.env.PG_PASSWORD ?? 'postgres',
            database: process.env.PG_DATABASE ?? 'postgres',
          },
        },
      },
    }
  }

  return {
    connection: 'sqlite',
    connections: {
      sqlite: {
        client: 'better-sqlite3',
        connection: { filename: sqlitePath },
        useNullAsDefault: true,
      },
    },
  }
}

function makeDatabase(config: DatabaseConfig): Database {
  const app = new AppFactory().create(pathToFileURL(`${process.cwd()}/`))
  const logger = new LoggerFactory().create()
  const emitter = new EmitterFactory().create(app)
  return new Database(config, logger as never, emitter)
}

async function createTables(db: Database): Promise<void> {
  const schema = db.connection().schema
  await schema.dropTableIfExists('ai_conversation_messages')
  await schema.dropTableIfExists('ai_conversations')

  await schema.createTable('ai_conversations', (table) => {
    table.string('id', 36).primary()
    table.string('owner').notNullable()
    table.string('agent_name').nullable()
    table.integer('version').notNullable().defaultTo(0)
    table.text('state').nullable()
    table.text('metadata').nullable()
    table.timestamp('created_at').notNullable()
    table.timestamp('updated_at').notNullable()
    table.index(['owner', 'updated_at'])
  })

  await schema.createTable('ai_conversation_messages', (table) => {
    table.increments('id').primary()
    table
      .string('conversation_id', 36)
      .notNullable()
      .references('id')
      .inTable('ai_conversations')
      .onDelete('CASCADE')
    table.integer('seq').notNullable()
    table.text('message').notNullable()
    table.timestamp('created_at').notNullable()
    table.unique(['conversation_id', 'seq'])
  })
}

/**
 * Creates a real Lucid `Database` (file-backed SQLite by default, or PostgreSQL when `LUCID_TEST_CLIENT=pg`)
 * with the conversation tables created. File-backed so `reopen()` opens a second independent instance.
 */
export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-ai-lucid-'))
  const sqlitePath = join(dir, 'conversations.sqlite')
  const config = buildConfig(sqlitePath)
  const opened: Database[] = []

  const db = makeDatabase(config)
  opened.push(db)
  await createTables(db)

  return {
    db,
    async reopen() {
      const next = makeDatabase(config)
      opened.push(next)
      return next
    },
    async close() {
      for (const instance of opened) {
        await instance.manager.closeAll()
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
