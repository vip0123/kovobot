-- A firing whose Task a restart cut off is answered again, once (ticket 22): this marks the
-- message whose answer was started over, so a second cut-off says so instead of looping.
ALTER TABLE messages ADD COLUMN answered_again boolean NOT NULL DEFAULT false;

-- Each sweep looks at the last day's firings for one a restart cut off.
CREATE INDEX schedules_last_run ON schedules (last_run_at) WHERE last_run_at IS NOT NULL;

-- Deleting a schedule clears it from its messages; without this, that reads every message.
CREATE INDEX messages_schedule_id ON messages (schedule_id) WHERE schedule_id IS NOT NULL;
