-- While a Bot is replying in a conversation, the next message waits, so replies
-- never interleave. A claim older than 5 minutes counts as abandoned (the
-- server stopped mid-reply).
ALTER TABLE conversations ADD COLUMN replying_since timestamptz;
