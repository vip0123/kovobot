-- MCP servers a Customer connects to a Bot (ticket 17): remote, over streamable HTTP. The Bot
-- uses their tools. They go with the Bot.
CREATE TABLE mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  url text NOT NULL,
  -- The name the server gives itself; null until it has answered.
  name text,
  state text NOT NULL CHECK (state IN ('connected', 'needs_sign_in')),
  -- The OAuth client, tokens and the sign-in in progress, for a server that wants signing in.
  auth jsonb NOT NULL DEFAULT '{}',
  -- The server's tools as it listed them when it was connected: name, description, input schema, whether it only reads.
  tools jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX mcp_servers_one_url_per_bot ON mcp_servers (bot_id, url);
-- A sign-in coming back is matched to its server by the OAuth state it was sent with.
CREATE INDEX mcp_servers_sign_in_state ON mcp_servers ((auth ->> 'state'));
