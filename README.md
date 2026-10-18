# memory-store

Structured long-term memory for Claude in Postgres: typed entries with scope, provenance, confidence, validity windows and links, searchable by keyword, fuzzy match and (later) embeddings.

Runs against the `memory` database on the homelab Postgres (CT 112, `10.10.20.4`, Postgres 17 + pgvector + pg_trgm). The connection string comes from `homelab-secrets/memory/postgres.sops.yaml` (or `MEMORY_DATABASE_URL`).

```bash
npm install
npm run migrate          # apply migrations/*.sql
npm run seed             # import memory files + Obsidian vault (changed files only)
npm run seed -- --force  # re-import everything
```

## Model

| Table | What |
|---|---|
| `source` | One imported file (Claude memory note, vault page) with its full text and hash |
| `entry` | One unit of knowledge: `kind` (rule, fact, decision, procedure, event, entity, profile, reference, project, page, section), `scope` (work, personal, homelab), `project`, `provenance` (user, inferred, verified, imported), `confidence`, `valid_from`/`valid_to`, `superseded_by`, `verify_cmd`, `embedding` |
| `relation` | Typed edges between entries (`links_to` from `[[wikilinks]]`, `part_of` from page sections) |
| `current_entry` | View of entries that are neither superseded nor expired |

```sql
select * from search_entries('thin pool cleanup', 'homelab', 5);
```

## Sources

- Claude memory notes: `~/.claude/projects/*/memory/*.md` plus any `extraMemoryRoots`, de-duplicated by real path and content
- Obsidian vault: every page except `Operations/Credentials.md`, split into one entry per `##` section
- `instructionFiles`: CLAUDE.md files (glob patterns with `*`), one rule entry per `##` section
- `exportMemoryRoots`: memory exported from claude.ai; `exportMemoryTypes` maps a file or top folder to a type
- `chatSummaryRoots`: one markdown file per chat (title, `Chat link:`, `Last updated:`, `## Summary`), stored as events
- `documentRoots`: plain markdown documents, split per section

Every source carries the machine's `host` (config `host`, else the hostname). A seed prunes this host's sources whose files are gone and never touches other hosts' rows or `manual` sources. Seeds take a Postgres advisory lock, so machines never write at the same time.

## Keeping it in sync

`scripts/sync.sh` runs the seeder quietly with a local lock and a pending flag, so bursts of edits collapse into one or two runs. Log: `~/.local/state/memory-store/sync.log`.

| Command | Use |
|---|---|
| `scripts/sync.sh run` | sync now |
| `scripts/sync.sh hook` | Claude Code `PostToolUse` hook: reads the hook JSON and syncs in the background only when the tool touched a memory note, CLAUDE.md, the vault or the archive (`MEMORY_SYNC_MATCH`) |
| `scripts/sync.sh bg` | background sync, for `SessionEnd` |
| `scripts/sync.sh install` / `uninstall` | macOS launchd job every `MEMORY_SYNC_INTERVAL` seconds (default 900) |

Hooks in `~/.claude/settings.json`:

```json
"PostToolUse": [{ "matcher": "Write|Edit|MultiEdit|NotebookEdit|Bash", "hooks": [{ "type": "command", "command": "<repo>/scripts/sync.sh hook", "timeout": 10 }] }],
"SessionEnd": [{ "hooks": [{ "type": "command", "command": "<repo>/scripts/sync.sh bg", "timeout": 10 }] }]
```

On Linux, run `scripts/sync.sh run` from a systemd timer or cron instead of `install`.

## Local config

Machine-specific settings (extra memory roots, project folder prefixes, the keyword patterns that decide `work` / `homelab` / `personal` scope) live in `memory-store.config.json`, which is gitignored. Start from `memory-store.config.example.json`.

## Next

Tracked as [issues](https://github.com/ahmedbaig/memory-store/issues).
