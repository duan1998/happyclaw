import fs from 'fs';
import os from 'os';
import path from 'path';

export type AgentDefinitionFrontmatterValue = string | string[];

export interface ParsedAgentDefinitionFile {
  id: string;
  name: string;
  description: string;
  tools: string[];
  content: string;
  promptBody: string;
  updatedAt: string;
  model?: string;
  maxTurns?: number;
}

export function getClaudeAgentsDir(): string {
  return path.join(os.homedir(), '.claude', 'agents');
}

export function extractTools(
  frontmatter: Record<string, AgentDefinitionFrontmatterValue>,
): string[] {
  return Array.isArray(frontmatter.tools)
    ? frontmatter.tools.filter(
        (tool): tool is string => typeof tool === 'string' && !!tool.trim(),
      )
    : typeof frontmatter.tools === 'string'
      ? frontmatter.tools.split(',').map((t) => t.trim()).filter(Boolean)
      : [];
}

export function parseFrontmatter(
  content: string,
): Record<string, AgentDefinitionFrontmatterValue> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === '---');
  if (endIndex === -1) return {};

  const frontmatterLines = lines.slice(1, endIndex + 1);
  const result: Record<string, AgentDefinitionFrontmatterValue> = {};
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  let multilineMode: 'folded' | 'literal' | 'list' | null = null;

  for (const line of frontmatterLines) {
    const keyMatch = line.match(/^([\w\-]+):\s*(.*)$/);
    if (keyMatch) {
      if (currentKey) {
        if (multilineMode === 'list') {
          result[currentKey] = currentValue;
        } else {
          result[currentKey] = currentValue.join(
            multilineMode === 'literal' ? '\n' : ' ',
          );
        }
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
    if (multilineMode === 'list') {
      result[currentKey] = currentValue;
    } else {
      result[currentKey] = currentValue.join(
        multilineMode === 'literal' ? '\n' : ' ',
      );
    }
  }

  return result;
}

export function splitFrontmatterAndBody(content: string): {
  frontmatter: Record<string, AgentDefinitionFrontmatterValue>;
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

  return {
    frontmatter: parseFrontmatter(content),
    body: lines.slice(endIndex + 2).join('\n').trim(),
  };
}

function parseOptionalPositiveInt(
  value: AgentDefinitionFrontmatterValue | undefined,
): number | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadAgentDefinitionFiles(
  agentsDir = getClaudeAgentsDir(),
): ParsedAgentDefinitionFile[] {
  if (!fs.existsSync(agentsDir)) return [];

  const agents: ParsedAgentDefinitionFile[] = [];
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    try {
      const filePath = path.join(agentsDir, entry.name);
      const id = entry.name.replace(/\.md$/, '');
      const content = fs.readFileSync(filePath, 'utf-8');
      const { frontmatter, body } = splitFrontmatterAndBody(content);
      const stats = fs.statSync(filePath);

      agents.push({
        id,
        name: (frontmatter.name as string) || id,
        description: (frontmatter.description as string) || '',
        tools: extractTools(frontmatter),
        content,
        promptBody: body,
        updatedAt: stats.mtime.toISOString(),
        model:
          typeof frontmatter.model === 'string' && frontmatter.model.trim()
            ? frontmatter.model.trim()
            : undefined,
        maxTurns: parseOptionalPositiveInt(frontmatter.maxTurns),
      });
    } catch {
      continue;
    }
  }

  return agents;
}
