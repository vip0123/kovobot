-- Schedules (ticket 22): a Bot does a task on its own, once or repeating, in a time zone.
-- Each firing is one Task; its message and reply go into the Bot's web Conversation.
CREATE TABLE schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  task text NOT NULL CHECK (char_length(task) BETWEEN 1 AND 2000),
  -- When it runs: { repeat: once | daily | weekdays | weekly | monthly, time: "HH:MM", date?, days?, dayOfMonth? }
  rule jsonb NOT NULL,
  time_zone text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- Null when it won't run again: switched off, or a one-off that has run.
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by text NOT NULL CHECK (created_by IN ('customer', 'bot')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX schedules_bot_id ON schedules (bot_id, created_at);
CREATE INDEX schedules_due ON schedules (next_run_at) WHERE enabled;

-- The schedule whose firing sent a message, rather than the Customer.
ALTER TABLE messages ADD COLUMN schedule_id uuid REFERENCES schedules (id) ON DELETE SET NULL;

-- The Customer's time zone, as their browser last gave it: what "9am" means to them.
ALTER TABLE customers ADD COLUMN time_zone text;
