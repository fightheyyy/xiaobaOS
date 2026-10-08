import * as fs from 'fs';
import * as path from 'path';
import { sandboxExecutor } from '../sandbox/executor';
import { toolSandboxPolicy } from '../sandbox/tool-execution';
import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../types/tool';
import { Logger } from '../utils/logger';
import { isToolAllowed, isBashCommandAllowed } from '../utils/safety';
import { toolBlocked, toolFailure, toolSuccess, toolTimeout } from './tool-result';


/**
 * Shell 工具 - 执行 shell 命令
 */
export class ShellTool implements Tool {
  definition: ToolDefinition = {
    name: 'execute_shell',
    description: '使用系统默认 shell 执行命令。可以运行 git、npm、ls 等命令行工具。',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令'
        },
        description: {
          type: 'string',
          description: '命令描述（可选），用于说明命令的作用'
        },
        timeout: {
          type: 'number',
          description: '超时时间（毫秒），默认 30000ms'
        }
      },
      required: ['command']
    }
  };

  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    const { command, description, timeout = 30000 } = args;

    const toolPermission = isToolAllowed(this.definition.name);
    if (!toolPermission.allowed) {
      return toolBlocked(
        `执行被阻止: ${toolPermission.reason}`,
        'TOOL_BLOCKED',
        toolPermission.reason || 'Tool execution is blocked by policy.',
      );
    }

    const commandPermission = isBashCommandAllowed(command);
    if (!commandPermission.allowed) {
      return toolBlocked(
        `执行被阻止: ${commandPermission.reason}`,
        'COMMAND_BLOCKED',
        commandPermission.reason || 'Command is blocked by policy.',
      );
    }

    // 显示命令信息
    if (description) {
      Logger.info(`执行命令: ${description}`);
    }
    Logger.info(`$ ${command}`);
    Logger.info(`工作目录: ${context.workingDirectory}`);

    const startTime = Date.now();

    try {
      const policy = toolSandboxPolicy(context);
      let execution;
      try {
        execution = await sandboxExecutor.execute({ policy, command, timeoutMs: timeout, abortSignal: context.abortSignal, inheritExistingSandbox: !context.sandboxPolicy });
      } finally {
        if (!context.sandboxPolicy) fs.rmSync(path.dirname(policy.home), { recursive: true, force: true });
      }
      if (execution.errorCode === 'SANDBOX_UNAVAILABLE') return toolBlocked(execution.error?.message || execution.stderr, 'SANDBOX_UNAVAILABLE', execution.error?.message || 'Sandbox is unavailable.');
      if (execution.errorCode === 'SANDBOX_CANCELLED') return { toolContent: '命令执行已取消。', status: 'cancelled', error_code: execution.errorCode, retryable: false };
      if (execution.errorCode === 'SANDBOX_TIMEOUT') return toolTimeout(execution.error?.message || 'Sandbox command timed out.');
      if (execution.status !== 0 || execution.errorCode) return toolFailure(execution.stderr || execution.error?.message || `Command exited with status ${execution.status}`, execution.errorCode || 'COMMAND_FAILED');
      const { stdout, stderr } = execution;

      const output = stdout || '';
      if (stderr) {
        Logger.warning(`stderr: ${stderr.substring(0, 200)}`);
      }

      const executionTime = Date.now() - startTime;
      const outputLines = output.split('\n').length;
      const outputSize = Buffer.byteLength(output, 'utf-8');

      Logger.success(`✓ 命令执行成功 (耗时: ${executionTime}ms)`);
      Logger.info(`  输出: ${outputLines} 行 | ${(outputSize / 1024).toFixed(2)} KB`);

      // 如果输出很长，显示预览
      if (outputLines > 20) {
        const previewLines = output.split('\n').slice(0, 10);
        Logger.info(`  输出预览（前10行）:`);
        previewLines.forEach(line => {
          const displayLine = line.length > 100 ? line.substring(0, 97) + '...' : line;
          Logger.info(`    ${displayLine}`);
        });
        Logger.info(`    ... (还有 ${outputLines - 10} 行)`);
      }

      return toolSuccess(`命令执行成功:\n$ ${command}\n\n执行时间: ${executionTime}ms\n输出行数: ${outputLines}\n\n${output}`);
    } catch (error: any) {
      const executionTime = Date.now() - startTime;
      const errorOutput = error.stderr || error.stdout || error.message;
      const content = `命令执行失败:\n$ ${command}\n\n执行时间: ${executionTime}ms\n错误信息:\n${errorOutput}`;

      Logger.error(`✗ 命令执行失败 (耗时: ${executionTime}ms)`);
      Logger.error(`  错误: ${error.message}`);

      const timedOut = Boolean(error.killed)
        || error.signal === 'SIGTERM'
        || /timeout|timed out|ETIMEDOUT|超时/i.test(String(error.message || errorOutput || ''));
      return timedOut
        ? toolTimeout(content)
        : toolFailure(content, 'COMMAND_FAILED');
    }
  }
}
