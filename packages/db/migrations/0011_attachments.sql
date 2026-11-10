-- Files a Customer sends a Bot with a message: images, PDFs and text files, kept with the message.
CREATE TABLE attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id bigint NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  -- The file's place among its message's files, as the Customer attached them.
  position smallint NOT NULL,
  name text NOT NULL,
  -- Decided from the file's own bytes, never from what the browser said.
  media_type text NOT NULL,
  size integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX attachments_message_id ON attachments (message_id);
