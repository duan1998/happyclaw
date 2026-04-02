/**
 * Agent runtime metadata — defines the supported AI runtimes (Claude, Codex)
 * and their filesystem conventions.
 */

export type AgentRuntimeId = 'claude' | 'codex';

export interface AgentRuntimeMetadata {
  id: AgentRuntimeId;
  label: string;
  memoryFileName: string;      // CLAUDE.md vs AGENTS.md
  stateDirectoryName: string;  // .claude vs .codex
  settingsFileName: string;    // settings.json location relative to stateDir
}

const RUNTIMES: Record<AgentRuntimeId, AgentRuntimeMetadata> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    memoryFileName: 'CLAUDE.md',
    stateDirectoryName: '.claude',
    settingsFileName: 'settings.json',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    memoryFileName: 'AGENTS.md',
    stateDirectoryName: '.codex',
    settingsFileName: 'config.toml',
  },
};

export function getRuntimeMetadata(id: AgentRuntimeId): AgentRuntimeMetadata {
  return RUNTIMES[id];
}

export function getAllRuntimes(): AgentRuntimeMetadata[] {
  return Object.values(RUNTIMES);
}

export function isValidRuntime(id: string): id is AgentRuntimeId {
  return id === 'claude' || id === 'codex';
}
