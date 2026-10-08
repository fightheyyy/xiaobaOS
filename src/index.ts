#!/usr/bin/env node

import { Command } from 'commander';
import { Logger } from './utils/logger';
import { chatCommand } from './commands/chat';
import { configCommand } from './commands/config';
import { registerSkillCommand } from './commands/skill';
import { registerRoleCommand } from './commands/role';
import { registerArenaCommand } from './commands/arena';
import { registerEvalCommand } from './commands/eval';
import { registerScheduleCommand } from './commands/schedule';
import { registerSandboxCommand } from './commands/sandbox';
import { registerConnectorCommand } from './commands/connector';
import { registerMemoryCommand } from './commands/memory';
import { registerEvolutionCommand } from './commands/evolution';
import { registerDoctorCommand } from './commands/doctor';
import { feishuCommand } from './commands/feishu';
import { APP_VERSION } from './version';
import { RoleResolver } from './utils/role-resolver';
// import { LogUploadScheduler } from './utils/log-upload-scheduler';

// 启动日志上传调度器
// const uploadScheduler = new LogUploadScheduler();
// uploadScheduler.start();

// 优雅退出
// process.on('SIGINT', () => {
//   uploadScheduler.stop();
//   process.exit(0);
// });

function addRoleOption(command: Command): Command {
  return command.option('-r, --role <name>', '使用指定角色（roles/<name>）');
}

async function main() {
  const program = new Command();

  addRoleOption(program)
    .name('xiaoba')
    .description('XiaoBa - 您的智能AI命令行助手')
    .version(APP_VERSION)
    .option('-s, --skill <name>', '启动时绑定指定 skill')
    .option('--resume', '默认聊天入口恢复上次 CLI 对话上下文')
    .option('--verbose', '默认聊天入口显示 CLI 运行时日志');

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const isDoctor = actionCommand.name() === 'doctor';
    const isStrictDoctorJson = isDoctor && actionCommand.opts().json === true;
    const isStrictArenaContractJson = actionCommand.name() === 'live-contract'
      && actionCommand.opts().json === true;
    const isSandboxCheck = actionCommand.name() === 'check' && actionCommand.parent?.name() === 'sandbox';
    if (!isStrictDoctorJson && !isStrictArenaContractJson && !isSandboxCheck) {
      Logger.brand();
    }
    if (isDoctor) return;
    try {
      const options = actionCommand.optsWithGlobals() as { role?: string };
      RoleResolver.activateRole(options.role);
    } catch (error: any) {
      Logger.error(error.message);
      process.exit(1);
    }
  });

  // 聊天命令
  addRoleOption(program
    .command('chat')
    .description('开始与XiaoBa对话')
    .option('-i, --interactive', '进入交互式对话模式')
    .option('-m, --message <message>', '发送单条消息')
    .option('-s, --skill <name>', '启动时绑定指定 skill')
    .option('--resume', '恢复上次 CLI 对话上下文')
    .option('--verbose', '显示 CLI 运行时日志'))
    .action(chatCommand);

  // 配置命令
  addRoleOption(program
    .command('config')
    .description('配置XiaoBa的API设置'))
    .action(configCommand);

  // 飞书机器人命令
  addRoleOption(program
    .command('feishu')
    .description('启动飞书机器人（WebSocket 长连接模式）'))
    .action(feishuCommand);

  // 微信机器人命令
  addRoleOption(program
    .command('weixin')
    .description('启动微信机器人'))
    .action(async () => {
      const { weixinCommand } = await import('./commands/weixin');
      await weixinCommand();
    });

  // Pet 桌宠入口
  addRoleOption(program
    .command('pet')
    .description('启动 XiaoBa Pet 桌宠入口')
    .option('-p, --port <port>', '指定端口号')
    .option('--host <host>', '指定监听地址（默认 127.0.0.1，可设为 0.0.0.0）')
    .option('--no-desktop', '只启动 Pet 服务，不打开桌宠窗口'))
    .action(async (options) => {
      const { petCommand } = await import('./commands/pet');
      await petCommand(options);
    });

  // Dashboard 命令
  addRoleOption(program
    .command('dashboard')
    .description('启动 XiaoBa Dashboard 管理面板')
    .option('-p, --port <port>', '指定端口号', '3800'))
    .option('--host <host>', '指定监听地址（默认 127.0.0.1，可设为 0.0.0.0）')
    .action(async (options) => {
      const { dashboardCommand } = await import('./commands/dashboard');
      await dashboardCommand(options);
    });

  addRoleOption(program
    .command('replay')
    .description('从历史 trace 复跑同款用户输入')
    .requiredOption('--trace <file>', '历史 logs/sessions/**/traces.jsonl')
    .option('--out <dir>', '输出目录')
    .option('--cwd <dir>', '工作目录，默认当前目录')
    .option('--pet-id <id>', 'Pet id，默认从 trace session_id 推断')
    .option('--session-key <key>', 'replay session key 前缀（runtime 会追加 replay provenance）')
    .option('--max-turns <n>', '只复跑前 n 个用户输入')
    .option('--timeout-ms <n>', '单轮超时时间，默认 180000'))
    .action(async (options) => {
      const { replayCommand } = await import('./commands/replay');
      await replayCommand(options);
    });

  // Skill 管理命令
  registerSkillCommand(program);

  // Role 管理命令
  registerRoleCommand(program);

  // Arena 能力审判场命令
  registerArenaCommand(program);

  // Agent 行为评测
  registerEvalCommand(program);

  // EvolutionCat 夜间演化入口
  registerEvolutionCommand(program);
  registerMemoryCommand(program);
  registerConnectorCommand(program);
  registerScheduleCommand(program);
  registerSandboxCommand(program);

  // 本机环境与能力诊断
  registerDoctorCommand(program);

  // 默认命令 - 进入交互模式
  program
    .action(async () => {
      const opts = program.opts();
      await chatCommand({
        interactive: true,
        skill: opts.skill,
        resume: opts.resume,
        verbose: opts.verbose,
      });
    });

  await program.parseAsync();
}

main().catch((error: any) => {
  Logger.error(error?.message || String(error));
  process.exit(1);
});
