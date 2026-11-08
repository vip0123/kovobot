-- The Computer each Bot drives, as the Computer service names it. Null until one is created.
ALTER TABLE bots ADD COLUMN computer_id uuid UNIQUE;
