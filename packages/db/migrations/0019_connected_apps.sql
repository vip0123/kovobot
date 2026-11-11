-- Connected apps (ticket 20, ADR 0010): a Customer's accounts on outside apps, through Composio,
-- which hosts each app's sign-in and holds its tokens. Each is granted to Bots one by one.
CREATE TABLE connected_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  -- Composio's toolkit, e.g. gmail.
  toolkit text NOT NULL,
  -- The app's name, e.g. Gmail.
  app_name text NOT NULL,
  -- Composio's connected account; null for an app that needs no sign-in.
  composio_account_id text UNIQUE,
  -- Which account, when there are several for one app: the name Composio gives it.
  label text,
  state text NOT NULL CHECK (state IN ('connecting', 'connected', 'failed')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX connected_apps_customer ON connected_apps (customer_id, created_at);

-- Which of the Customer's Connected apps each Bot may use.
CREATE TABLE bot_connected_apps (
  bot_id uuid NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
  connected_app_id uuid NOT NULL REFERENCES connected_apps (id) ON DELETE CASCADE,
  PRIMARY KEY (bot_id, connected_app_id)
);
CREATE INDEX bot_connected_apps_app ON bot_connected_apps (connected_app_id);

-- Each action run through Composio, recorded at $0 until Composio has a price (ADR 0010).
CREATE TABLE composio_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  bot_id uuid REFERENCES bots (id) ON DELETE SET NULL,
  connected_app_id uuid REFERENCES connected_apps (id) ON DELETE SET NULL,
  tool text NOT NULL,
  successful boolean NOT NULL,
  cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL
);
CREATE INDEX composio_calls_customer ON composio_calls (customer_id, created_at);
