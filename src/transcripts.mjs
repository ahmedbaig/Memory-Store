import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const KIND = 'transcript';
const TAIL_BYTES = 65536;
const KEEP_TYPES = new Set(['user', 'assistant', 'system', 'attachment', 'ai-title', 'custom-title', 'agent-name']);
const TYPE_PREFIX_RE = /^\{"type":"([^"]+)"/;

const sha256 = data => createHash('sha256').update(data).digest('hex');

const globRe = pattern => new RegExp(`^${pattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

const readRange = (path, start, end) => {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (!n) break;
      read += n;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
};

const tailHash = (path, offset) => sha256(readRange(path, Math.max(0, offset - TAIL_BYTES), offset));

const truncate = (text, max) => {
  if (!max || text.length <= max) return text;
  const head = Math.floor(max * 0.75);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… truncated ${text.length - max} chars …]\n${text.slice(-tail)}`;
};

const listJsonl = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => join(dir, f)) : []);

const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
};

const discover = (root, opts) => {
  const include = opts.include.map(globRe);
  const exclude = opts.exclude.map(globRe);
  const wanted = slug => include.some(re => re.test(slug)) && !exclude.some(re => re.test(slug));
  if (!existsSync(root)) return { files: [], excluded: 0 };
  const projects = readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory());
  const excluded = projects.filter(d => !wanted(d.name)).length;
  const files = projects
    .filter(d => wanted(d.name))
    .flatMap(d => {
      const dir = join(root, d.name);
      const sessions = listJsonl(dir).map(path => ({ path, slug: d.name, session: basename(path, '.jsonl'), parent: null }));
      const subagents = !opts.subagents
        ? []
        : readdirSync(dir, { withFileTypes: true })
            .filter(s => s.isDirectory())
            .flatMap(s =>
              listJsonl(join(dir, s.name, 'subagents')).map(path => ({
                path,
                slug: d.name,
                session: basename(path, '.jsonl'),
                parent: { session: s.name, uri: `file://${join(dir, `${s.name}.jsonl`)}`, ...readJson(path.replace(/\.jsonl$/, '.meta.json')) },
              })),
            );
      return [...sessions, ...subagents];
    });
  return { files, excluded };
};

const textOf = content =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(c => (typeof c === 'string' ? c : c?.type === 'text' ? c.text ?? '' : c?.type ? `[${c.type}]` : '')).join('\n')
      : content == null
        ? ''
        : JSON.stringify(content);

const renderInput = input =>
  input && typeof input === 'object'
    ? Object.entries(input).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n')
    : String(input ?? '');

const blocksOf = (rec, opts) => {
  const ts = rec.timestamp ?? null;
  if (rec.type === 'attachment') {
    const a = rec.attachment;
    return a?.type === 'queued_command' && a.prompt ? [{ role: 'user', ts: a.timestamp ?? ts, text: textOf(a.prompt), prompt: true, label: 'user queued' }] : [];
  }
  if (rec.type === 'system') {
    const text = textOf(rec.content).trim();
    return text && text !== 'null' ? [{ role: 'system', ts, text, label: `system ${rec.subtype ?? ''}`.trim() }] : [];
  }
  const content = rec.message?.content;
  if (rec.type === 'user') {
    const meta = rec.isMeta || rec.isCompactSummary;
    const label = rec.isCompactSummary ? 'user compact-summary' : rec.isMeta ? 'user meta' : 'user';
    if (typeof content === 'string') return content.trim() ? [{ role: 'user', ts, text: content, prompt: !meta, label }] : [];
    if (!Array.isArray(content)) return [];
    return content.flatMap(c => {
      if (c?.type === 'tool_result') {
        const text = truncate(textOf(c.content), opts.toolOutputChars);
        return [{ role: 'tool_result', ts, text, label: `tool_result ${c.tool_use_id ?? ''}${c.is_error ? ' error' : ''}`.trim() }];
      }
      if (c?.type === 'text') return c.text?.trim() ? [{ role: 'user', ts, text: c.text, prompt: !meta, label }] : [];
      return c?.type ? [{ role: 'user', ts, text: `[${c.type}]`, label }] : [];
    });
  }
  if (rec.type === 'assistant' && Array.isArray(content)) {
    return content.flatMap(c => {
      if (c?.type === 'text') return c.text?.trim() ? [{ role: 'assistant', ts, text: c.text, label: 'assistant' }] : [];
      if (c?.type === 'thinking') return c.thinking?.trim() ? [{ role: 'thinking', ts, text: c.thinking, label: 'thinking' }] : [];
      if (c?.type === 'tool_use') return [{ role: 'tool_use', ts, text: truncate(renderInput(c.input), opts.toolInputChars), label: `tool_use ${c.name ?? ''} ${c.id ?? ''}`.trim() }];
      return c?.type ? [{ role: 'assistant', ts, text: `[${c.type}]`, label: 'assistant' }] : [];
    });
  }
  return [];
};

const parseRange = (path, offset, size, opts) => {
  const raw = readRange(path, offset, size);
  const lastNl = raw.lastIndexOf(0x0a);
  const usable = lastNl < 0 ? raw.subarray(0, 0) : raw.subarray(0, lastNl + 1);
  const state = { blocks: [], titles: {}, records: 0, malformed: 0, skippedTypes: 0, cwd: null, branch: null, version: null };
  usable
    .toString('utf8')
    .split('\n')
    .forEach(line => {
      if (!line.trim()) return;
      const prefix = line.slice(0, 64).match(TYPE_PREFIX_RE)?.[1];
      if (prefix && !KEEP_TYPES.has(prefix)) {
        state.skippedTypes++;
        return;
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        state.malformed++;
        return;
      }
      if (!rec || typeof rec !== 'object' || !KEEP_TYPES.has(rec.type)) {
        state.skippedTypes++;
        return;
      }
      state.records++;
      if (rec.type === 'ai-title' && rec.aiTitle) state.titles.ai = rec.aiTitle;
      if (rec.type === 'custom-title' && rec.customTitle) state.titles.custom = rec.customTitle;
      if (rec.type === 'agent-name' && rec.agentName) state.titles.agent = rec.agentName;
      if (rec.cwd) state.cwd = rec.cwd;
      if (rec.gitBranch) state.branch = rec.gitBranch;
      if (rec.version) state.version = rec.version;
      try {
        state.blocks.push(...blocksOf(rec, opts));
      } catch {
        state.malformed++;
      }
    });
  return { ...state, end: offset + usable.length };
};

const chunk = (blocks, max) => {
  const chunks = [];
  let cur = null;
  const flush = () => {
    if (cur?.parts.length) chunks.push(cur);
    cur = null;
  };
  const open = b => (cur = { parts: [], size: 0, from: b.ts, to: b.ts, roles: {}, prompt: null });
  blocks.forEach(b => {
    const header = `[${b.label}${b.ts ? ` ${b.ts}` : ''}]\n`;
    const pieces = [];
    for (let i = 0; i < Math.max(1, b.text.length); i += max) pieces.push(b.text.slice(i, i + max));
    pieces.forEach((piece, i) => {
      const text = `${i ? `[${b.label} continued]\n` : header}${piece}`;
      if (cur && ((b.prompt && i === 0) || cur.size + text.length > max)) flush();
      if (!cur) open(b);
      cur.parts.push(text);
      cur.size += text.length + 2;
      cur.to = b.ts ?? cur.to;
      cur.from = cur.from ?? b.ts;
      cur.roles[b.role] = (cur.roles[b.role] ?? 0) + 1;
      if (b.prompt && !cur.prompt) cur.prompt = piece;
    });
  });
  flush();
  return chunks;
};

const countRoles = blocks => blocks.reduce((acc, b) => ({ ...acc, [b.role]: (acc[b.role] ?? 0) + 1 }), {});

const addCounts = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, (a[k] ?? 0) + (b[k] ?? 0)]));

const clean = text => text.replace(/\u0000/g, '').toWellFormed();

const oneLine = (text, n) => clean((text ?? '').replace(/\s+/g, ' ').trim().slice(0, n));

const build = (file, stat, prev, mode, opts, helpers) => {
  const offset = mode === 'append' ? prev.meta.offset : 0;
  const parsed = parseRange(file.path, offset, stat.size, opts);
  const old = mode === 'append' ? prev.meta : {};
  const firstPrompt = old.firstPrompt || oneLine((parsed.blocks.find(b => b.prompt && !b.text.trimStart().startsWith('<')) ?? parsed.blocks.find(b => b.prompt))?.text, 300) || null;
  const titles = Object.fromEntries(Object.entries({ ...(old.titles ?? {}), ...parsed.titles }).map(([k, v]) => [k, clean(String(v))]));
  const title = clean(titles.custom ?? titles.ai ?? titles.agent ?? (file.parent?.description ? `${file.parent.agentType ?? 'agent'}: ${file.parent.description}` : null) ?? (firstPrompt ? oneLine(firstPrompt, 80) : null) ?? file.session);
  const project = helpers.project(file.slug);
  const forcedScope = helpers.workSlug(file.slug) ? 'work' : null;
  const startSeq = mode === 'append' ? old.chunks ?? 0 : 0;
  const chunks = chunk(parsed.blocks, opts.chunkChars);
  const start = old.start ?? parsed.blocks.find(b => b.ts)?.ts ?? null;
  const end = [...parsed.blocks].reverse().find(b => b.ts)?.ts ?? old.end ?? null;
  const meta = {
    session: file.session,
    slug: file.slug,
    project,
    cwd: parsed.cwd ?? old.cwd ?? null,
    branch: parsed.branch ?? old.branch ?? null,
    version: parsed.version ?? old.version ?? null,
    path: file.path,
    start,
    end,
    titles,
    firstPrompt,
    counts: addCounts(old.counts, countRoles(parsed.blocks)),
    records: (old.records ?? 0) + parsed.records,
    malformed: (old.malformed ?? 0) + parsed.malformed,
    chunks: startSeq + chunks.length,
    size: stat.size,
    mtime: stat.mtimeMs,
    offset: parsed.end,
    tailHash: tailHash(file.path, parsed.end),
    ...(file.parent ? { parentSession: file.parent.session, parentUri: file.parent.uri, agentType: file.parent.agentType ?? null, agentDescription: file.parent.description ?? null, toolUseId: file.parent.toolUseId ?? null } : {}),
  };
  const content = clean([title, `session ${file.session}`, `project ${file.slug}`, meta.cwd && `cwd ${meta.cwd}`, meta.branch && `branch ${meta.branch}`, file.parent && `subagent of ${file.parent.session}`, firstPrompt && `first prompt: ${firstPrompt}`]
    .filter(Boolean)
    .join('\n'));
  const entries = chunks.map((c, i) => {
    const seq = startSeq + i + 1;
    const body = clean(c.parts.join('\n\n'));
    return {
      anchor: `c${String(seq).padStart(5, '0')}`,
      kind: 'turn',
      scope: helpers.inferScope(`${title}\n${body}`, forcedScope),
      project,
      title: `${title} · ${seq}`,
      summary: oneLine(`${(c.from ?? '').slice(0, 10)} ${c.prompt ?? c.parts[0].replace(/^\[[^\]]*\]\n/, '')}`, 240),
      body,
      tags: ['transcript', ...(file.parent ? ['subagent'] : []), ...Object.keys(c.roles)],
      provenance: 'imported',
      confidence: 0.5,
      validFrom: c.from ?? start ?? new Date(stat.mtimeMs).toISOString(),
      links: [],
      data: { session: file.session, seq, from: c.from, to: c.to, roles: c.roles, ...(file.parent ? { parentSession: file.parent.session } : {}) },
    };
  });
  return { kind: KIND, uri: `file://${file.path}`, title, hash: meta.tailHash, content, meta, entries, mode, existingId: prev?.id ?? null };
};

export const planTranscripts = async (client, { root, host, opts, helpers }) => {
  const started = Date.now();
  const { files, excluded } = discover(root, opts);
  const existing = new Map(
    (await client.query(`select id, uri, meta from source where kind = $1 and meta->>'host' = $2`, [KIND, host])).rows.map(r => [r.uri, r]),
  );
  const plan = { sources: [], keep: [], skipped: [], unchanged: 0, excludedProjects: excluded, files: files.length };
  files.forEach(file => {
    const uri = `file://${file.path}`;
    const stat = statSync(file.path);
    const prev = existing.get(uri);
    if (opts.maxFileBytes && stat.size > opts.maxFileBytes) {
      plan.skipped.push({ uri, reason: `larger than maxFileBytes (${stat.size})` });
      plan.keep.push(uri);
      return;
    }
    if (prev && prev.meta.size === stat.size && prev.meta.mtime === stat.mtimeMs && !opts.force) {
      plan.unchanged++;
      plan.keep.push(uri);
      return;
    }
    const canAppend = prev && !opts.force && stat.size > prev.meta.offset && prev.meta.offset > 0 && tailHash(file.path, prev.meta.offset) === prev.meta.tailHash;
    const source = build(file, stat, prev, canAppend ? 'append' : 'full', opts, helpers);
    if (!source.entries.length && !prev) {
      plan.skipped.push({ uri, reason: 'no conversation records' });
      return;
    }
    if (!source.entries.length && canAppend) {
      plan.keep.push(uri);
      plan.touch = [...(plan.touch ?? []), { id: prev.id, meta: source.meta }];
      return;
    }
    plan.sources.push(source);
  });
  plan.parseMs = Date.now() - started;
  return plan;
};

const insertEntries = async (client, sourceId, entries) => {
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    const params = [];
    const rows = batch.map(e => {
      const values = [e.kind, e.scope, e.project, e.title, e.summary, e.body, e.tags, { ...e.data, redactions: e.redacted ?? 0 }, sourceId, e.anchor, e.provenance, e.confidence, e.validFrom];
      const base = params.length;
      params.push(...values);
      return `(${values.map((_, j) => `$${base + j + 1}`).join(', ')})`;
    });
    await client.query(
      `insert into entry (kind, scope, project, title, summary, body, tags, data, source_id, anchor, provenance, confidence, valid_from) values ${rows.join(', ')}
       on conflict (source_id, anchor) do update set scope = excluded.scope, title = excluded.title, summary = excluded.summary, body = excluded.body, tags = excluded.tags, data = excluded.data, valid_from = excluded.valid_from, updated_at = now()`,
      params,
    );
  }
};

export const storeTranscripts = async (pool, plan, { host, inTransaction }) => {
  const stats = { full: 0, appended: 0, entries: 0, pruned: 0, touched: 0 };
  stats.pruned = await inTransaction(pool, client =>
    client.query(`delete from source where kind = $1 and meta->>'host' = $2 and not (uri = any($3))`, [KIND, host, [...plan.keep, ...plan.sources.map(s => s.uri)]]).then(r => r.rowCount),
  );
  for (const t of plan.touch ?? []) {
    await inTransaction(pool, client => client.query(`update source set meta = $2 || jsonb_build_object('host', $3::text) where id = $1`, [t.id, t.meta, host]));
    stats.touched++;
  }
  for (const s of plan.sources) {
    await inTransaction(pool, async client => {
      const { rows } = await client.query(
        `insert into source (kind, uri, title, sha256, content, meta) values ($1, $2, $3, $4, $5, $6)
         on conflict (uri) do update set title = excluded.title, sha256 = excluded.sha256, content = excluded.content, meta = excluded.meta, imported_at = now()
         returning id`,
        [s.kind, s.uri, s.title, s.hash, s.content, s.meta],
      );
      const id = rows[0].id;
      if (s.mode === 'full') await client.query('delete from entry where source_id = $1', [id]);
      else await client.query(`update entry set title = $2 || ' · ' || (data->>'seq') where source_id = $1 and title <> $2 || ' · ' || (data->>'seq')`, [id, s.title]);
      await insertEntries(client, id, s.entries);
    });
    stats[s.mode === 'full' ? 'full' : 'appended']++;
    stats.entries += s.entries.length;
  }
  return stats;
};

export const transcriptDefaults = {
  enabled: true,
  include: ['*'],
  exclude: [],
  subagents: true,
  chunkChars: 16000,
  toolInputChars: 8000,
  toolOutputChars: 16000,
  maxFileBytes: 0,
};
