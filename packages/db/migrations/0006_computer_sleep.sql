-- How long a Bot's Computer may sit with nothing going on before it goes Asleep (the
-- Customer picks 15 minutes to 4 hours), when it last had a viewer or a Bot at work,
-- and when it went Asleep: after 30 days Asleep it is Shut down.
ALTER TABLE bots
  ADD COLUMN computer_sleep_after_minutes integer NOT NULL DEFAULT 15
    CHECK (computer_sleep_after_minutes BETWEEN 15 AND 240),
  ADD COLUMN computer_active_at timestamptz,
  ADD COLUMN computer_asleep_at timestamptz;
