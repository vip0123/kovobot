-- Approvals (ticket 18): a Bot's action that sends, changes, deletes or pays outside the Bot
-- waits for the Customer's Approval of exactly that action, unless a Pre-approval covers it.
CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  -- The reply whose Task asked, once it's saved.
  message_id bigint REFERENCES messages (id) ON DELETE CASCADE,
  -- What Pre-approvals know the tool by, e.g. mcp:<server id>:<tool name>.
  tool_key text NOT NULL,
  -- { source, label, name, ref }: what the Customer sees of the tool, and how to run it.
  tool jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('send', 'change', 'delete', 'pay')),
  -- Exactly what runs: the model can't change it once asked.
  arguments jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('waiting', 'declined', 'running', 'done', 'failed')),
  -- Ran at once under a Pre-approval, rather than asked.
  pre_approved boolean NOT NULL DEFAULT false,
  -- What the action returned, or why it failed.
  result text,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  finished_at timestamptz
);
CREATE INDEX approvals_conversation ON approvals (conversation_id, created_at);
CREATE INDEX approvals_bot ON approvals (bot_id);

-- A standing OK for one kind of action on one tool of one Bot. Paying is never pre-approved.
CREATE TABLE pre_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  tool_key text NOT NULL,
  tool jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('send', 'change', 'delete')),
  created_at timestamptz NOT NULL,
  UNIQUE (bot_id, tool_key, kind)
);

-- The message that tells the model what the Customer decided, so it carries on.
ALTER TABLE messages ADD COLUMN approval_id uuid REFERENCES approvals (id) ON DELETE SET NULL;
