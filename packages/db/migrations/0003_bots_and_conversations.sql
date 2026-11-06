-- A Customer's Bots. There is no limit on how many.
CREATE TABLE bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  model text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX bots_customer_id ON bots (customer_id, created_at);

-- A Bot's conversation on one Channel. On the web Channel each Bot has one.
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  channel text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX conversations_one_web_per_bot ON conversations (bot_id) WHERE channel = 'web';

-- Messages in a conversation; id orders them.
CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX messages_conversation_id ON messages (conversation_id, id);
