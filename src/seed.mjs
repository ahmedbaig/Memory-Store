import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import YAML from 'yaml';
import { connect, inTransaction, withClient } from './db.mjs';
import { config } from './config.mjs';
import { planTranscripts, storeTranscripts } from './transcripts.mjs';

const HOME = homedir();
const HOST = config.host ?? hostname();
const { claudeProjects: CLAUDE_PROJECTS, extraMemoryRoots, vault: VAULT, vaultSkip: VAULT_SKIP, homelabDirs: HOMELAB_DIRS, workRe: WORK_RE, homelabRe: HOMELAB_RE, homeProject, projectFolderPrefixes } = config;
const KIND_BY_TYPE = { feedback: 'rule', user: 'profile', project: 'project', reference: 'reference', entity: 'entity' };
const SEEDED_KINDS = ['memory_file', 'vault_page', 'instructions', 'export_memory', 'chat_summary', 'document'];

const sha256 = text => createHash('sha256').update(text).digest('hex');
const count = (re, text) => (text.match(re) ?? []).length;
const slug = text => text.toLowerCase().replace(/[`*_[\]()]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const listDirs = dir => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => join(dir, d.name)) : []);
const listMd = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').map(f => join(dir, f)) : []);

const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    if (d.name.startsWith('.')) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? walk(path) : d.name.endsWith('.md') ? [path] : [];
  });

const splitFrontmatter = text => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  try {
    return { meta: YAML.parse(m[1]) ?? {}, body: m[2] };
  } catch {
    return { meta: {}, body: m[2] };
  }
};

const wikilinks = text => [...text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map(m => m[1].trim());

const inferScope = (text, forced) => {
  if (forced) return forced;
  const work = count(WORK_RE, text);
  const lab = count(HOMELAB_RE, text);
  if (work >= 3 && work >= lab) return 'work';
  if (lab >= 2) return 'homelab';
  return 'personal';
};

const projectFromEncoded = encoded => {
  if (encoded === homeProject) return null;
  const tail = encoded.slice(homeProject.length).replace(/^-/, '').replace(/^Work-/, '');
  const prefix = projectFolderPrefixes.find(p => tail.startsWith(`${p}-`));
  return prefix ? tail.slice(prefix.length + 1) : tail.toLowerCase();
};

const memoryFileLocations = () => [
  ...listDirs(CLAUDE_PROJECTS).flatMap(p => listMd(join(p, 'memory')).map(file => ({ file, project: projectFromEncoded(basename(p)), workPath: basename(p) !== homeProject }))),
  ...extraMemoryRoots.flatMap(listDirs).flatMap(p => listMd(join(p, 'memory')).map(file => ({ file, project: basename(p), workPath: true }))),
];

const collectMemory = () => {
  const byContent = new Map();
  const seenPaths = new Set();
  for (const loc of memoryFileLocations()) {
    const real = realpathSync(loc.file);
    if (seenPaths.has(real)) continue;
    seenPaths.add(real);
    const content = readFileSync(real, 'utf8');
    const hash = sha256(content);
    if (byContent.has(hash)) {
      byContent.get(hash).aliases.push(real);
      continue;
    }
    byContent.set(hash, { ...loc, real, content, hash, aliases: [], mtime: statSync(real).mtime });
  }
  return [...byContent.values()].map(toMemorySource);
};

const toMemorySource = ({ real, content, hash, aliases, project, workPath, mtime }) => {
  const { meta, body } = splitFrontmatter(content);
  const name = meta.name ?? basename(real, '.md');
  const type = meta.metadata?.type ?? meta.type ?? 'fact';
  const modified = meta.metadata?.modified ?? mtime.toISOString();
  return {
    kind: 'memory_file',
    uri: `file://${real}`,
    title: name,
    hash,
    content,
    meta: { path: real, aliases, description: meta.description ?? null, type },
    entries: [
      {
        anchor: 'file',
        kind: KIND_BY_TYPE[type] ?? 'fact',
        scope: inferScope(`${name} ${meta.description ?? ''} ${body}`, workPath ? 'work' : null),
        project,
        title: name,
        summary: meta.description ?? null,
        body: body.trim(),
        tags: [type],
        provenance: type === 'feedback' || type === 'user' ? 'user' : 'imported',
        confidence: type === 'feedback' ? 0.9 : 0.7,
        validFrom: modified,
        links: wikilinks(body),
        data: { file: basename(real) },
      },
    ],
  };
};

const splitSections = body => {
  const parts = body.split(/^(?=## )/m);
  const preamble = parts[0].startsWith('## ') ? '' : parts.shift();
  const used = new Map();
  return {
    preamble: preamble.replace(/^# .*\n/, '').trim(),
    sections: parts.map(part => {
      const heading = part.match(/^## (.*)$/m)[1].trim();
      const base = slug(heading) || 'section';
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return { heading, anchor: n > 1 ? `${base}-${n}` : base, text: part.replace(/^## .*\n/, '').trim() };
    }),
  };
};

const vaultScope = (rel, text) => {
  const top = rel.split('/')[0];
  const work = count(WORK_RE, text);
  if (work >= 8 && work > count(HOMELAB_RE, text)) return 'work';
  return HOMELAB_DIRS.has(top) ? 'homelab' : inferScope(text);
};

const collectVault = () =>
  walk(VAULT)
    .map(path => ({ path, rel: relative(VAULT, path) }))
    .filter(({ rel }) => !VAULT_SKIP.has(rel))
    .map(({ path, rel }) => {
      const content = readFileSync(path, 'utf8');
      const { meta, body } = splitFrontmatter(content);
      const title = meta.title ?? basename(rel, '.md');
      const scope = vaultScope(rel, content);
      const validFrom = meta.updated ? new Date(meta.updated).toISOString() : statSync(path).mtime.toISOString();
      const tags = [...(Array.isArray(meta.tags) ? meta.tags : []), rel.split('/')[0].replace(/\.md$/, '')].map(String);
      const { preamble, sections } = splitSections(body);
      const page = {
        anchor: 'page',
        kind: 'page',
        scope,
        project: null,
        title,
        summary: meta.description ?? null,
        body: preamble || meta.description || title,
        tags,
        provenance: 'imported',
        confidence: 0.8,
        validFrom,
        links: wikilinks(preamble),
        data: { path: rel },
      };
      const sectionEntries = sections.map(s => ({
        anchor: s.anchor,
        kind: 'section',
        scope: vaultScope(rel, `${s.heading}\n${s.text}`) === 'work' ? 'work' : scope,
        project: null,
        title: `${title} › ${s.heading}`,
        summary: null,
        body: s.text || s.heading,
        tags,
        provenance: 'imported',
        confidence: 0.8,
        validFrom,
        links: wikilinks(s.text),
        partOf: 'page',
        data: { path: rel, heading: s.heading },
      }));
      return { kind: 'vault_page', uri: `obsidian://${rel}`, title, hash: sha256(content), content, meta: { path: rel, ...meta }, entries: [page, ...sectionEntries] };
    });

const walkIfExists = dir => (existsSync(dir) ? walk(dir) : []);

const globMatch = part => new RegExp(`^${part.split('*').map(escapeRe).join('[^/]*')}$`);

const expandGlob = pattern =>
  pattern
    .split('/')
    .slice(1)
    .reduce(
      (paths, part) =>
        paths.flatMap(p =>
          !part.includes('*')
            ? [join(p, part)]
            : existsSync(p) && statSync(p).isDirectory()
              ? readdirSync(p).filter(n => globMatch(part).test(n)).map(n => join(p, n))
              : [],
        ),
      ['/'],
    )
    .filter(p => existsSync(p));

const uniqueReal = paths => [...new Map(paths.map(p => [realpathSync(p), p])).keys()];

const sectionedEntries = ({ title, body, scope, pageKind, sectionKind, project = null, tags, validFrom, data, provenance = 'imported', confidence = 0.8, summary = null }) => {
  const { preamble, sections } = splitSections(body);
  const base = { scope, project, tags, provenance, confidence, validFrom };
  return [
    { ...base, anchor: 'page', kind: pageKind, title, summary, body: preamble || summary || title, links: wikilinks(preamble), data },
    ...sections.map(s => ({
      ...base,
      anchor: s.anchor,
      kind: sectionKind,
      scope: inferScope(`${s.heading}\n${s.text}`, null) === 'work' ? 'work' : scope,
      title: `${title} › ${s.heading}`,
      summary: null,
      body: s.text || s.heading,
      links: wikilinks(s.text),
      partOf: 'page',
      data: { ...data, heading: s.heading },
    })),
  ];
};

const instructionTitle = real => {
  const dir = dirname(real);
  return dir === HOME ? 'CLAUDE.md · ~' : dir === join(HOME, '.claude') ? 'CLAUDE.md · ~/.claude' : `CLAUDE.md · ${basename(dir)}`;
};

const collectInstructions = () =>
  uniqueReal(config.instructionFiles.flatMap(expandGlob)).map(real => {
    const content = readFileSync(real, 'utf8');
    const title = instructionTitle(real);
    const project = [HOME, join(HOME, '.claude')].includes(dirname(real)) ? null : basename(dirname(real));
    return {
      kind: 'instructions',
      uri: `file://${real}`,
      title,
      hash: sha256(content),
      content,
      meta: { path: real },
      entries: sectionedEntries({ title, body: content, scope: inferScope(content), pageKind: 'rule', sectionKind: 'rule', project, tags: ['instructions'], validFrom: statSync(real).mtime.toISOString(), data: { path: real }, provenance: 'user', confidence: 0.9 }),
    };
  });

const exportMemoryType = (meta, rel) => meta.metadata?.type ?? meta.type ?? config.exportMemoryTypes[rel] ?? config.exportMemoryTypes[rel.split('/')[0]] ?? 'fact';

const collectExportMemory = () =>
  config.exportMemoryRoots.flatMap(root =>
    walkIfExists(root).map(path => {
      const rel = relative(root, path);
      const content = readFileSync(path, 'utf8');
      const { meta, body } = splitFrontmatter(content);
      const name = meta.name ?? basename(path, '.md');
      const type = exportMemoryType(meta, rel);
      return {
        kind: 'export_memory',
        uri: `file://${realpathSync(path)}`,
        title: name,
        hash: sha256(content),
        content,
        meta: { path: rel, description: meta.description ?? null, type },
        entries: [
          {
            anchor: 'file',
            kind: KIND_BY_TYPE[type] ?? 'fact',
            scope: inferScope(`${name} ${meta.description ?? ''} ${body}`),
            project: null,
            title: name,
            summary: meta.description ?? null,
            body: body.trim(),
            tags: [type, 'claude.ai'],
            provenance: 'user',
            confidence: 0.8,
            validFrom: statSync(path).mtime.toISOString(),
            links: wikilinks(body),
            data: { file: rel },
          },
        ],
      };
    }),
  );

const collectChatSummaries = () =>
  config.chatSummaryRoots.flatMap(root =>
    walkIfExists(root).map(path => {
      const content = readFileSync(path, 'utf8');
      const title = content.match(/^# (.+)$/m)?.[1].trim() ?? basename(path, '.md');
      const date = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/)?.[1] ?? basename(path).match(/^\d{4}-\d{2}-\d{2}/)?.[0];
      const link = content.match(/Chat link:\s*(\S+)/)?.[1] ?? null;
      const body = (content.split(/^## Summary\s*$/m)[1] ?? content).trim();
      return {
        kind: 'chat_summary',
        uri: `file://${realpathSync(path)}`,
        title,
        hash: sha256(content),
        content,
        meta: { path: relative(root, path), link, date },
        entries: [
          {
            anchor: 'chat',
            kind: 'event',
            scope: inferScope(`${title}\n${body}`),
            project: null,
            title,
            summary: date ? `claude.ai chat, ${date}` : 'claude.ai chat',
            body,
            tags: ['chat', 'claude.ai'],
            provenance: 'imported',
            confidence: 0.6,
            validFrom: date ? new Date(date).toISOString() : statSync(path).mtime.toISOString(),
            links: [],
            data: { link, file: basename(path) },
          },
        ],
      };
    }),
  );

const collectDocuments = () =>
  config.documentRoots.flatMap(root =>
    walkIfExists(root).map(path => {
      const content = readFileSync(path, 'utf8');
      const title = content.match(/^# (.+)$/m)?.[1].trim() ?? basename(path, '.md');
      return {
        kind: 'document',
        uri: `file://${realpathSync(path)}`,
        title,
        hash: sha256(content),
        content,
        meta: { path: relative(root, path) },
        entries: sectionedEntries({ title, body: content, scope: inferScope(content), pageKind: 'page', sectionKind: 'section', tags: ['document'], validFrom: statSync(path).mtime.toISOString(), data: { path: relative(root, path) } }),
      };
    }),
  );

const REGEX_REDACTIONS = [
  [/((?:password|passwd|pwd|secret|token|api[_-]?key)\s*(?:[:=]|\bis\b)\s*[`"']?)(?![$<{]|\[REDACTED)([^\s`'"|,]{4,})/gi, '$1[REDACTED]'],
  [/(\bcurl\b[^\n]*?\s-u\s+'?[^:\s']+:)([^\s']+)/g, '$1[REDACTED]'],
  [/(\b(?:mysql|mariadb)\b[^\n]*?\s-p)([^\s]+)/g, '$1[REDACTED]'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/g, '$1[REDACTED]$3'],
  [/(Authorization:\s*(?:Basic|Bearer)\s+)([A-Za-z0-9+/=._-]{8,})/g, '$1[REDACTED]'],
];

const SECRET_KEY_RE = /password|passwd|secret|token|api_?key|hash|cookie|htpasswd|private_key|psk|preshared|auth$|_key$/i;
const NOT_SECRET_KEY_RE = /config|vhost|target|domain|selector|url|host|_id$/i;
const DICTIONARY = existsSync('/usr/share/dict/words') ? new Set(readFileSync('/usr/share/dict/words', 'utf8').toLowerCase().split('\n')) : new Set();
const SECRETS_DIR = process.env.HOMELAB_SECRETS ?? join(HOME, 'Work/PersonalProjects/homelab-secrets');

const flattenSecrets = (value, key = '') =>
  typeof value === 'string'
    ? SECRET_KEY_RE.test(key) && !NOT_SECRET_KEY_RE.test(key) ? [value] : []
    : value && typeof value === 'object'
      ? Object.entries(value).flatMap(([k, v]) => flattenSecrets(v, Array.isArray(value) ? key : k))
      : [];

const sopsYamlFiles = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    if (d.name.startsWith('.')) return [];
    const path = join(dir, d.name);
    return d.isDirectory() ? sopsYamlFiles(path) : d.name.endsWith('.sops.yaml') ? [path] : [];
  });

const knownSecrets = () =>
  [...new Set(
    sopsYamlFiles(SECRETS_DIR)
      .flatMap(file => flattenSecrets(YAML.parse(execFileSync('sops', ['decrypt', file], { encoding: 'utf8' }))))
      .map(v => v.trim())
      .filter(v => v.length >= 4 && !/\s/.test(v) && !/^\$|^\{\{/.test(v)),
  )].sort((a, b) => b.length - a.length);

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isWeak = v => v.length < 10 || DICTIONARY.has(v.toLowerCase()) || /^[a-z]+$/.test(v);

const knownRedactor = secrets => {
  const patterns = secrets.map(v =>
    isWeak(v)
      ? new RegExp(`(?<=[\`"':=]|\\s-p)${escapeRe(v)}(?=[\`"'@|,;)]|\\s|$)`, 'gm')
      : new RegExp(`(?<![A-Za-z0-9])${escapeRe(v)}(?![A-Za-z0-9])`, 'g'),
  );
  return text => patterns.reduce((acc, re) => acc.replace(re, '[REDACTED:known]'), text);
};

let knownRedact = text => text;

const regexRedact = text => knownRedact(REGEX_REDACTIONS.reduce((acc, [re, rep]) => acc.replace(re, rep), text));

const gitleaksRedact = sources => {
  const dir = mkdtempSync(join(tmpdir(), 'memseed-'));
  try {
    const flat = sources.flatMap((s, si) => [
      { si, ei: -1, file: join(dir, `${si}-src.txt`) },
      ...s.entries.map((e, ei) => ({ si, ei, file: join(dir, `${si}-${ei}.txt`) })),
    ]);
    const read = ({ si, ei }) => (ei < 0 ? sources[si].content : sources[si].entries[ei].body);
    flat.forEach(f => writeFileSync(f.file, read(f)));
    const report = join(dir, 'report.json');
    execFileSync('gitleaks', ['dir', dir, '--no-banner', '--exit-code', '0', '--report-format', 'json', '--report-path', report], { stdio: 'ignore' });
    const findings = JSON.parse(readFileSync(report, 'utf8') || '[]');
    const byFile = new Map(flat.map(f => [basename(f.file), f]));
    findings.forEach(({ File, Secret, RuleID }) => {
      const hit = byFile.get(basename(File));
      if (!hit || !Secret) return;
      const source = sources[hit.si];
      const swap = text => text.split(Secret).join(`[REDACTED:${RuleID}]`);
      source.content = swap(source.content);
      source.entries.forEach(e => {
        if (e.body.includes(Secret)) {
          e.body = swap(e.body);
          e.redacted = (e.redacted ?? 0) + 1;
        }
      });
    });
    return findings.length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const redactAll = sources => {
  sources.forEach(s => {
    s.content = regexRedact(s.content);
    s.entries.forEach(e => {
      const next = regexRedact(e.body);
      if (next !== e.body) e.redacted = (e.redacted ?? 0) + 1;
      e.body = next;
    });
  });
  return gitleaksRedact(sources);
};

const upsertSource = async (client, s) => {
  const existing = (await client.query(`select id, sha256, meta->>'host' as host from source where uri = $1`, [s.uri])).rows[0];
  if (existing && existing.sha256 === s.hash && !process.argv.includes('--force')) {
    if (existing.host !== HOST) await client.query(`update source set meta = meta || jsonb_build_object('host', $2::text) where id = $1`, [existing.id, HOST]);
    return { id: existing.id, changed: false };
  }
  const { rows } = await client.query(
    `insert into source (kind, uri, title, sha256, content, meta) values ($1, $2, $3, $4, $5, $6)
     on conflict (uri) do update set title = excluded.title, sha256 = excluded.sha256, content = excluded.content, meta = excluded.meta, imported_at = now()
     returning id`,
    [s.kind, s.uri, s.title, s.hash, s.content, s.meta],
  );
  await client.query('delete from entry where source_id = $1', [rows[0].id]);
  return { id: rows[0].id, changed: true };
};

const insertEntry = (client, sourceId, e) =>
  client
    .query(
      `insert into entry (kind, scope, project, title, summary, body, tags, data, source_id, anchor, provenance, confidence, valid_from)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning id`,
      [e.kind, e.scope, e.project, e.title, e.summary, e.body, e.tags, { ...e.data, redactions: e.redacted ?? 0 }, sourceId, e.anchor, e.provenance, e.confidence, e.validFrom],
    )
    .then(r => r.rows[0].id);

const storeSources = (pool, sources) =>
  inTransaction(pool, async client => {
    const stats = { new: 0, unchanged: 0, entries: 0, pruned: 0 };
    stats.pruned = (
      await client.query(
        `delete from source where kind = any($1) and (meta->>'host' = $2 or meta->>'host' is null) and not (uri = any($3))`,
        [SEEDED_KINDS, HOST, sources.map(s => s.uri)],
      )
    ).rowCount;
    for (const s of sources) {
      const { id, changed } = await upsertSource(client, s);
      if (!changed) {
        stats.unchanged++;
        continue;
      }
      stats.new++;
      for (const e of s.entries) {
        await insertEntry(client, id, e);
        stats.entries++;
      }
    }
    return stats;
  });

const rebuildRelations = (pool, sources) =>
  inTransaction(pool, async client => {
    const { rows } = await client.query(
      `select e.id, e.anchor, e.title, e.kind, s.uri, s.title as source_title from entry e join source s on s.id = e.source_id
       where s.kind = any($1) order by (s.kind = 'memory_file'), s.id`,
      [SEEDED_KINDS],
    );
    const byUriAnchor = new Map(rows.map(r => [`${r.uri}#${r.anchor}`, r.id]));
    const target = new Map();
    rows.filter(r => ['page', 'file', 'chat'].includes(r.anchor)).forEach(r => {
      target.set(r.source_title.toLowerCase(), r.id);
      target.set(basename(r.uri.replace(/^\w+:\/\//, ''), '.md').toLowerCase(), r.id);
    });
    await client.query(`delete from relation where rel in ('links_to', 'part_of')`);
    const unresolved = new Set();
    let made = 0;
    for (const s of sources) {
      for (const e of s.entries) {
        const src = byUriAnchor.get(`${s.uri}#${e.anchor}`);
        if (!src) continue;
        if (e.partOf) {
          await client.query('insert into relation (src, rel, dst) values ($1, $2, $3) on conflict do nothing', [src, 'part_of', byUriAnchor.get(`${s.uri}#${e.partOf}`)]);
          made++;
        }
        for (const link of e.links) {
          const dst = target.get(link.toLowerCase());
          if (!dst) {
            unresolved.add(link);
            continue;
          }
          if (dst === src) continue;
          await client.query('insert into relation (src, rel, dst) values ($1, $2, $3) on conflict do nothing', [src, 'links_to', dst]);
          made++;
        }
      }
    }
    return { made, unresolved: [...unresolved].sort() };
  });

const summary = pool =>
  withClient(pool, client =>
    client.query(`select scope, kind, count(*)::int as n from current_entry group by 1, 2 order by 1, 2`).then(r => r.rows),
  );

const workSlug = slug => {
  const tail = slug.slice(homeProject.length).replace(/^-/, '').replace(/^Work-/, '');
  return slug.startsWith(homeProject) && projectFolderPrefixes.some(p => tail === p || tail.startsWith(`${p}-`));
};

const syncTranscripts = async pool => {
  const started = Date.now();
  const plan = await withClient(pool, client =>
    planTranscripts(client, {
      root: CLAUDE_PROJECTS,
      host: HOST,
      opts: { ...config.transcripts, force: process.argv.includes('--force') },
      helpers: { inferScope, workSlug, project: slug => (slug.startsWith(homeProject) ? projectFromEncoded(slug) : slug) },
    }),
  );
  plan.sources.forEach(s => (s.meta.host = HOST));
  const leaks = redactAll(plan.sources);
  const redactedEntries = plan.sources.reduce((n, s) => n + s.entries.filter(e => e.redacted).length, 0);
  const stats = await storeTranscripts(pool, plan, { host: HOST, inTransaction });
  console.log(
    `transcripts: ${plan.files} files, ${plan.unchanged} unchanged, ${stats.full} full, ${stats.appended} appended, ${stats.touched} touched, +${stats.entries} entries, pruned ${stats.pruned}; gitleaks findings redacted: ${leaks}; entries with redactions: ${redactedEntries}; parse ${plan.parseMs}ms, total ${Date.now() - started}ms`,
  );
  plan.skipped.forEach(s => console.log(`transcript skipped: ${s.uri} (${s.reason})`));
};

const SEED_LOCK = 'memory-store-seed';

knownRedact = knownRedactor(knownSecrets());
const pool = connect();
const lock = await pool.connect();
await lock.query('select pg_advisory_lock(hashtext($1))', [SEED_LOCK]);
try {
  const collected = {
    memory: collectMemory(),
    vault: collectVault(),
    instructions: collectInstructions(),
    exportMemory: collectExportMemory(),
    chats: collectChatSummaries(),
    documents: collectDocuments(),
  };
  const sources = Object.values(collected).flat();
  sources.forEach(s => (s.meta.host = HOST));
  const leaks = redactAll(sources);
  const counts = Object.entries(collected).map(([k, v]) => `${v.length} ${k}`).join(', ');
  console.log(`${new Date().toISOString()} host ${HOST}: collected ${counts}; ${sources.reduce((n, s) => n + s.entries.length, 0)} entries; gitleaks findings redacted: ${leaks}`);
  console.log('store', await storeSources(pool, sources));
  const rel = await rebuildRelations(pool, sources);
  console.log(`relations: ${rel.made}; unresolved links: ${rel.unresolved.length ? rel.unresolved.join(', ') : 'none'}`);
  if (config.transcripts.enabled) await syncTranscripts(pool);
  if (!process.argv.includes('--quiet')) console.table(await summary(pool));
} finally {
  await lock.query('select pg_advisory_unlock(hashtext($1))', [SEED_LOCK]);
  lock.release();
  await pool.end();
}
