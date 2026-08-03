import { Router } from 'express';
import { Tool } from '../types/tool';
import { RoleResolver } from '../utils/role-resolver';
import { ConfigManager } from '../utils/config';
import { AIService } from '../utils/ai-service';
import { SkillManager } from '../skills/skill-manager';
import { ToolManager } from '../tools/tool-manager';
import { AnalyzeLogTool } from './inspector-cat/tools/analyze-log-tool';
import { GuideTpcEvalAnalysisTool } from './guide/tools/eval-analysis-tool';
import { GuideTpcEnvBaselineTool } from './guide/tools/env-baseline-tool';
import { GuideTpcBaselineTool } from './guide/tools/tpc-baseline-tool';
import { ResearchBoardReadTool, ResearchBoardUpdateTool } from './researcher-cat/tools/research-board-tools';
import { ResearchAutoResearchRunTool } from './researcher-cat/tools/research-auto-run-tool';
import { FeishuAuthLoginCompleteTool, FeishuAuthLoginStartTool, FeishuAuthStatusTool } from './secretary-cat/tools/feishu-auth-tools';
import { DefaultLarkCliRunner } from './secretary-cat/utils/lark-cli-runner';
import {
  FeishuCalendarAgendaTool,
  FeishuCalendarCreateTool,
  FeishuCalendarDeleteTool,
  FeishuCalendarUpdateTool,
} from './secretary-cat/tools/feishu-calendar-tools';
import {
  FeishuBaseFieldListTool,
  FeishuBaseRecordListTool,
  FeishuBaseRecordUpsertConfirmedTool,
  FeishuBaseTableListTool,
  FeishuSheetsAppendConfirmedTool,
  FeishuSheetsReadTool,
} from './secretary-cat/tools/feishu-data-tools';
import {
  FeishuDocsCreateConfirmedTool,
  FeishuDocsFetchTool,
  FeishuDocsSearchTool,
  FeishuDocsUpdateConfirmedTool,
} from './secretary-cat/tools/feishu-doc-tools';
import {
  FeishuDriveDownloadTool,
  FeishuDriveImportConfirmedTool,
  FeishuDriveSearchTool,
  FeishuDriveUploadConfirmedTool,
} from './secretary-cat/tools/feishu-drive-tools';
import {
  FeishuMailDraftCreateTool,
  FeishuMailDraftSendConfirmedTool,
  FeishuMailReadTool,
  FeishuMailTriageTool,
} from './secretary-cat/tools/feishu-mail-tools';
import {
  FeishuContactSearchTool,
  FeishuMessageDraftTool,
  FeishuMessageSendConfirmedTool,
} from './secretary-cat/tools/feishu-message-tools';
import {
  FeishuMinutesDownloadTool,
  FeishuMinutesGetTool,
  FeishuMinutesNotesTool,
  FeishuMinutesSearchTool,
} from './secretary-cat/tools/feishu-minutes-tools';
import {
  FeishuTaskCreateConfirmedTool,
  FeishuTaskListTool,
  FeishuTaskStateConfirmedTool,
  FeishuTaskUpdateConfirmedTool,
} from './secretary-cat/tools/feishu-task-tools';
import { UserTraceRunTool } from './user-cat/tools/user-trace-run-tool';
import { createBrowserCatTools } from './browser-cat';
import { createGuiCatTools } from './gui-cat';
import { EvolutionRememberTool } from './evolution-cat/tools/remember-tool';
import { createEngineerCatTools } from './engineer-cat';

export interface RoleRuntimeSupport {
  stop(): Promise<void>;
}

export interface RoleRuntimeServiceOptions {
  workingDirectory?: string;
}

function normalizeRole(roleName?: string): string {
  const requested = roleName || RoleResolver.getActiveRoleName();
  const resolved = requested ? RoleResolver.resolveRoleDirectoryName(requested) : undefined;
  return RoleResolver.normalizeRoleName(resolved || '');
}

export function getRoleSpecificToolsForRole(roleName?: string): Tool[] {
  return getRoleSpecificToolsForNormalizedRole(normalizeRole(roleName));
}

/**
 * Compose native tools for a role name that has already been resolved by an
 * isolated runtime boundary (for example an Arena role overlay).
 */
export function getRoleSpecificToolsForResolvedRole(roleName?: string): Tool[] {
  return getRoleSpecificToolsForNormalizedRole(RoleResolver.normalizeRoleName(roleName || ''));
}

function getRoleSpecificToolsForNormalizedRole(normalizedRole: string): Tool[] {
  if (normalizedRole === 'engineer-cat') {
    return createEngineerCatTools();
  }

  if (normalizedRole === 'evolution-cat') {
    return [new EvolutionRememberTool()];
  }

  if (normalizedRole === 'browser-cat') {
    return createBrowserCatTools();
  }

  if (normalizedRole === 'gui-cat') {
    return createGuiCatTools();
  }

  if (normalizedRole === 'guide') {
    return [
      new GuideTpcBaselineTool(),
      new GuideTpcEvalAnalysisTool(),
      new GuideTpcEnvBaselineTool(),
    ];
  }

  if (normalizedRole === 'user-cat') {
    return [
      new UserTraceRunTool({
        createServices: ({ cwd, targetRole, runId }) => ({
          aiService: new AIService(),
          toolManager: new ToolManager(
            cwd,
            { roleName: targetRole, runId },
            getRoleSpecificToolsForRole(targetRole),
          ),
          skillManager: new SkillManager(targetRole),
          roleName: targetRole,
        }),
      }),
    ];
  }
  if (normalizedRole === 'researcher-cat') {
    return [
      new ResearchAutoResearchRunTool(),
      new ResearchBoardUpdateTool(),
      new ResearchBoardReadTool(),
    ];
  }
  if (normalizedRole === 'inspector-cat') {
    return [new AnalyzeLogTool()];
  }
  if (normalizedRole === 'secretary-cat') {
    const surfaceAppId = String(
      process.env.FEISHU_APP_ID || ConfigManager.getConfig().feishu?.appId || '',
    ).trim();
    const larkCli = new DefaultLarkCliRunner(
      'lark-cli',
      surfaceAppId ? { ...process.env, FEISHU_APP_ID: surfaceAppId } : process.env,
    );
    return [
      new FeishuAuthStatusTool(larkCli),
      new FeishuAuthLoginStartTool(larkCli),
      new FeishuAuthLoginCompleteTool(larkCli),
      new FeishuCalendarAgendaTool(larkCli),
      new FeishuCalendarCreateTool(larkCli),
      new FeishuCalendarUpdateTool(larkCli),
      new FeishuCalendarDeleteTool(larkCli),
      new FeishuContactSearchTool(larkCli),
      new FeishuMessageDraftTool(),
      new FeishuMessageSendConfirmedTool(larkCli),
      new FeishuTaskListTool(larkCli),
      new FeishuTaskCreateConfirmedTool(larkCli),
      new FeishuTaskUpdateConfirmedTool(larkCli),
      new FeishuTaskStateConfirmedTool(larkCli),
      new FeishuMailTriageTool(larkCli),
      new FeishuMailReadTool(larkCli),
      new FeishuMailDraftCreateTool(larkCli),
      new FeishuMailDraftSendConfirmedTool(larkCli),
      new FeishuMinutesSearchTool(larkCli),
      new FeishuMinutesGetTool(larkCli),
      new FeishuMinutesNotesTool(larkCli),
      new FeishuMinutesDownloadTool(larkCli),
      new FeishuDocsSearchTool(larkCli),
      new FeishuDocsFetchTool(larkCli),
      new FeishuDocsCreateConfirmedTool(larkCli),
      new FeishuDocsUpdateConfirmedTool(larkCli),
      new FeishuDriveSearchTool(larkCli),
      new FeishuDriveUploadConfirmedTool(larkCli),
      new FeishuDriveDownloadTool(larkCli),
      new FeishuDriveImportConfirmedTool(larkCli),
      new FeishuSheetsReadTool(larkCli),
      new FeishuSheetsAppendConfirmedTool(larkCli),
      new FeishuBaseTableListTool(larkCli),
      new FeishuBaseFieldListTool(larkCli),
      new FeishuBaseRecordListTool(larkCli),
      new FeishuBaseRecordUpsertConfirmedTool(larkCli),
    ];
  }
  return [];
}

export function getRoleSpecificTools(): Tool[] {
  return getRoleSpecificToolsForRole(RoleResolver.getActiveRoleName());
}

export function registerRoleSpecificApiRoutes(_router: Router): void {
  return;
}

export async function startRoleRuntimeServices(
  _options: RoleRuntimeServiceOptions = {},
): Promise<RoleRuntimeSupport | null> {
  return null;
}
