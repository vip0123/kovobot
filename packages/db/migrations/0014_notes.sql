-- A Bot's notes, which it keeps across Conversations (ticket 21). The Bot writes them as it
-- works; the Customer sees, adds, edits and deletes them. They go with the Bot.
CREATE TABLE notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  -- Who last wrote it: the Bot, or the Customer.
  written_by text NOT NULL CHECK (written_by IN ('bot', 'customer')),
  -- The Bot wrote it after reading Outside content in the same Task, so the Customer should check it.
  after_outside_content boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX notes_bot_id ON notes (bot_id, id);
