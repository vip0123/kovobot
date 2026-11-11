-- Pictures a Bot makes are kept as Attachments of its reply, with the description it made them
-- from, so later Tasks know what each picture shows. Null for the Customer's own files.
ALTER TABLE attachments ADD COLUMN prompt text;
