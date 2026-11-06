alter table entry drop constraint if exists entry_kind_check;
alter table entry add constraint entry_kind_check
  check (kind in ('rule', 'fact', 'decision', 'procedure', 'event', 'entity', 'profile', 'reference', 'project', 'page', 'section', 'turn'));

alter table source drop constraint if exists source_kind_check;
alter table source add constraint source_kind_check
  check (kind in ('memory_file', 'vault_page', 'transcript', 'manual', 'instructions', 'export_memory', 'chat_summary', 'document'));

create index if not exists source_kind_host_idx on source (kind, (meta->>'host'));
create index if not exists entry_session_idx on entry ((data->>'session')) where kind = 'turn';
