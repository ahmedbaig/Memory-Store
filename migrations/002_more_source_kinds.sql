alter table source drop constraint if exists source_kind_check;
alter table source add constraint source_kind_check
  check (kind in ('memory_file', 'vault_page', 'transcript', 'manual', 'instructions', 'export_memory', 'chat_summary', 'document'));

create index if not exists source_host_idx on source ((meta->>'host'));
