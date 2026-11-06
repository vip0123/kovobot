-- Customers sign up and sign in by a one-time email link or with Google.
-- No passwords are stored anywhere.
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  google_subject text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One-time sign-in links. Only a SHA-256 hash of each token is stored.
-- A link creates the Customer on first use, so unused links leave no Customer behind.
CREATE TABLE sign_in_links (
  token_hash bytea PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX sign_in_links_email_created_at ON sign_in_links (email, created_at);

-- Signed-in sessions. Only a SHA-256 hash of each session token is stored.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_customer_id ON sessions (customer_id);
