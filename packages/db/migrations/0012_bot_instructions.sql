-- What the Customer tells the Bot about how to work for them; it reaches the model with
-- every Task. Empty for none.
ALTER TABLE bots ADD COLUMN instructions text NOT NULL DEFAULT '';
