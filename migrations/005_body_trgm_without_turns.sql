create index if not exists entry_body_trgm_notes_idx on entry using gin (body gin_trgm_ops) where kind <> 'turn';
drop index if exists entry_body_trgm_idx;
