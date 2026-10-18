import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const file = process.env.MEMORY_STORE_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), '../memory-store.config.json');

const defaults = {
  claudeProjects: '~/.claude/projects',
  homeProject: `-${HOME.slice(1).replace(/[/.]/g, '-')}`,
  extraMemoryRoots: [],
  projectFolderPrefixes: [],
  vault: '~/Documents/Obsidian Vault',
  vaultSkip: ['Operations/Credentials.md'],
  homelabDirs: ['Infrastructure', 'Network', 'Monitoring', 'Operations', 'Lab Map.md'],
  instructionFiles: ['~/.claude/CLAUDE.md', '~/CLAUDE.md'],
  exportMemoryRoots: [],
  exportMemoryTypes: {},
  chatSummaryRoots: [],
  documentRoots: [],
  host: null,
  workPattern: 'a^',
  homelabPattern: 'proxmox|homelab|\\bCT ?1\\d\\d\\b|gitlab\\.lab|adguard|wireguard|thin pool|grafana|prometheus|obsidian|unbound',
};

const expand = path => path.replace(/^~(?=\/|$)/, HOME);

const loaded = { ...defaults, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) };

export const config = {
  ...loaded,
  claudeProjects: expand(loaded.claudeProjects),
  extraMemoryRoots: loaded.extraMemoryRoots.map(expand),
  instructionFiles: loaded.instructionFiles.map(expand),
  exportMemoryRoots: loaded.exportMemoryRoots.map(expand),
  chatSummaryRoots: loaded.chatSummaryRoots.map(expand),
  documentRoots: loaded.documentRoots.map(expand),
  vault: expand(loaded.vault),
  vaultSkip: new Set(loaded.vaultSkip),
  homelabDirs: new Set(loaded.homelabDirs),
  workRe: new RegExp(loaded.workPattern, 'gi'),
  homelabRe: new RegExp(loaded.homelabPattern, 'gi'),
};
