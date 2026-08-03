import { Tool } from '../../types/tool';
import { CodexExecutor, OfficialCodexSdkAdapter } from './codex-sdk-adapter';
import { EngineerCodexRunTool } from './codex-run-tool';

export interface EngineerCatToolDependencies {
  codexExecutor?: CodexExecutor;
}

export function createEngineerCatTools(dependencies: EngineerCatToolDependencies = {}): Tool[] {
  return [
    new EngineerCodexRunTool(dependencies.codexExecutor ?? new OfficialCodexSdkAdapter()),
  ];
}

export * from './codex-sdk-adapter';
export * from './codex-run-tool';
