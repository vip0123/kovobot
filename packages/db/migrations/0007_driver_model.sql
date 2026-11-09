-- The model a Bot uses to operate its Computer, which the Customer picks: OpenAI,
-- Anthropic and Google models only. Null until picked; the Bot can't drive without one.
ALTER TABLE bots ADD COLUMN driver_model text;
