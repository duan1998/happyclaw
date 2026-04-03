/**
 * Predefined and user-defined SubAgent definitions for HappyClaw.
 *
 * User definitions are loaded from ~/.claude/agents/*.md and merged with the
 * built-ins below. User files can override built-in names intentionally.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

type FrontmatterValue = string | string[];

export const PREDEFINED_AGENTS: Record<string, AgentDefinition> = {
  'code-reviewer': {
    description:
      'Code review agent that analyzes code quality, best practices, and potential issues',
    prompt:
      'You are a strict code reviewer. Focus on correctness, security, performance, and maintainability. ' +
      'Point out specific issues with file:line references. Be concise and actionable.',
    tools: ['Read', 'Glob', 'Grep'],
    maxTurns: 15,
  },
  'web-researcher': {
    description:
      'Web research agent that searches and extracts information from web pages',
    prompt:
      'You are an efficient web researcher. Search for information, extract key facts, and summarize findings. ' +
      'Always cite sources with URLs. Prefer authoritative sources.',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
    maxTurns: 20,
  },
};

function getAgentsDir(): string {
  const configDir =
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || os.homedir(), '.claude');
  return path.join(configDir, 'agents');
}

function extractTools(frontmatter: Record<string, FrontmatterValue>): string[] {
  const raw = frontmatter.tools;
  return Array.isArray(raw)
    ? raw.filter(
        (tool): tool is string => typeof tool === 'string' && !!tool.trim(),
      )
    : typeof raw === 'string'
      ? raw.split(',').map((tool) => tool.trim()).filter(Boolean)
      : [];
}

function parseFrontmatter(content: string): Record<string, FrontmatterValue> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | 'list' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w-]+):\s*(.*)$/);
    if (keyMatch) {
      if (currentKey) {
        result[currentKey] =
          multilineMode === 'list'
            ? currentValue
            : currentValue.join(multilineMode === 'literal' ? '\n' : ' ');
      }

      currentKey = keyMatch[1];
      const value = keyMatch[2].trim();

      if (value === '>') {
        multilineMode = 'folded';
        currentValue = [];
      } else if (value === '|') {
        multilineMode = 'literal';
        currentValue = [];
      } else if (value === '') {
        multilineMode = 'list';
        currentValue = [];
      } else {
        result[currentKey] = value;
        currentKey = null;
        currentValue = [];
        multilineMode = null;
      }
    } else if (currentKey && multilineMode) {
      const trimmedLine = line.trimStart();
      if (multilineMode === 'list' && trimmedLine.startsWith('- ')) {
        currentValue.push(trimmedLine.slice(2).trim());
      } else if (trimmedLine) {
        currentValue.push(trimmedLine);
      }
    }
  }

  if (currentKey) {
    result[currentKey] =
      multilineMode === 'list'
        ? currentValue
        : currentValue.join(multilineMode === 'literal' ? '\n' : ' ');
  }

  return result;
}

function splitFrontmatterAndBody(content: string): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: content.trim() };
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) {
    return { frontmatter: {}, body: content.trim() };
  }

  const body = lines.slice(endIndex + 2).join('\n').trim();
  return {
    frontmatter: parseFrontmatter(content),
    body,
  };
}

function parseOptionalPositiveInt(
  value: FrontmatterValue | undefined,
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadUserAgentDefinitions(): Record<string, AgentDefinition> {
  const agentsDir = getAgentsDir();
  if (!fs.existsSync(agentsDir)) return {};

  const agents: Record<string, AgentDefinition> = {};
  try {
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const agentId = entry.name.replace(/\.md$/, '');
      const filePath = path.join(agentsDir, entry.name);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const { frontmatter, body } = splitFrontmatterAndBody(content);
        if (!body) continue;

        const description =
          typeof frontmatter.description === 'string' &&
          frontmatter.description.trim()
            ? frontmatter.description.trim()
            : agentId;
        const tools = extractTools(frontmatter);
        const model =
          typeof frontmatter.model === 'string' && frontmatter.model.trim()
            ? frontmatter.model.trim()
            : undefined;
        const maxTurns = parseOptionalPositiveInt(frontmatter.maxTurns);

        agents[agentId] = {
          description,
          prompt: body,
          ...(tools.length > 0 ? { tools } : {}),
          ...(model ? { model } : {}),
          ...(maxTurns ? { maxTurns } : {}),
        };
      } catch (err) {
        console.error(
          `[agent-runner] Failed to load user agent definition ${filePath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    console.error(
      `[agent-runner] Failed to scan user agent definitions in ${agentsDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return agents;
}

export function loadAllAgents(): Record<string, AgentDefinition> {
  return {
    ...PREDEFINED_AGENTS,
    ...loadUserAgentDefinitions(),
  };
}
