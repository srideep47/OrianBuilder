import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/* ── Conversations ─────────────────────────── */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  mode: text('mode').notNull().default('agent'),
  modelId: text('model_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

/* ── Models (downloaded GGUF) ──────────────── */
export const models = sqliteTable('models', {
  id: text('id').primaryKey(),
  org: text('org').notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  downloadedAt: integer('downloaded_at', { mode: 'timestamp' }).notNull(),
});

/* ── Library items ─────────────────────────── */
export const libraryItems = sqliteTable('library_items', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'theme' | 'prompt' | 'media'
  title: text('title').notNull(),
  body: text('body'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Model = typeof models.$inferSelect;
export type LibraryItem = typeof libraryItems.$inferSelect;
