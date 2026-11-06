create or replace function search_entries(q text, in_scope text default null, max_rows int default 10)
returns table (id bigint, kind text, scope text, project text, title text, summary text, rank real)
language sql stable as $$
  with query as (select websearch_to_tsquery('english', q) as tsq),
  notes as (
    select e.id, e.kind, e.scope, e.project, e.title, e.summary,
           (ts_rank_cd(e.tsv, query.tsq) + 0.3 * greatest(similarity(e.title, q), word_similarity(q, e.body)))::real as rank
    from current_entry e, query
    where e.kind <> 'turn'
      and (in_scope is null or e.scope = in_scope)
      and (e.tsv @@ query.tsq or e.title % q or q <% e.body)
  ),
  turns as (
    select e.id, e.kind, e.scope, e.project, e.title, e.summary,
           (0.5 * ts_rank_cd(e.tsv, query.tsq, 32))::real as rank
    from current_entry e, query
    where e.kind = 'turn'
      and (in_scope is null or e.scope = in_scope)
      and e.tsv @@ query.tsq
  )
  select * from (select * from notes union all select * from turns) r
  order by rank desc
  limit max_rows
$$;
