import { Command } from 'commander';
import { DailyEventScheduler, WorkspaceSchedule, ScheduledJobId } from '../events';
import { consumeEvolutionSleep, EvolutionCommandDependencies } from './evolution';
import { previousLocalDate } from '../roles/evolution-cat/evolution-observer';
import { MemoryMaintenance, MemoryPlanner } from '../utils/memory-maintenance';
import { createMemoryPlanner } from './memory';

export interface ScheduleCommandDependencies {
  root?: string;
  schedule?: WorkspaceSchedule;
  now?: () => Date;
  evolution?: EvolutionCommandDependencies;
  memoryPlanner?: MemoryPlanner;
}

export function createWorkspaceEventScheduler(root: string, dependencies: ScheduleCommandDependencies = {}): DailyEventScheduler {
  const scheduler = new DailyEventScheduler(root);
  scheduler.register('evolution', async event => {
    // Preserve the existing trace harvester's host-local calendar semantics.
    await consumeEvolutionSleep({ workingDirectory: root, targetDate: previousLocalDate(new Date(event.occurredAt)),
      minOccurrences: 2, runsPerCase: 3, verbose: false }, dependencies.evolution);
  });
  scheduler.register('memory', async event => {
    const payload = event.payload as { timezone?: string };
    // Scheduler owns time gating and daily admission; maintenance owns scoped incremental cursors.
    await new MemoryMaintenance(root, dependencies.memoryPlanner || createMemoryPlanner(root)).run({ now: new Date(event.occurredAt), timezone: payload.timezone });
  });
  return scheduler;
}

export function registerScheduleCommand(program: Command, dependencies: ScheduleCommandDependencies = {}): void {
  const root = dependencies.root || process.cwd();
  const command = program.command('schedule').description('共享夜间 Scheduler：一个 cron tick、两个 Event 消费者');
  command.command('tick').description('检查所有已安装任务并派发到 Event 层')
    .action(async () => {
      const configuration = dependencies.schedule || new WorkspaceSchedule({ workingDirectory: root });
      const result = await createWorkspaceEventScheduler(root, dependencies).tick(configuration.schedules(), dependencies.now?.());
      console.log(JSON.stringify(result));
      if (result.failed.length) throw new Error(`SCHEDULE_JOBS_FAILED: ${result.failed.map(item => `${item.id}: ${item.error}`).join('; ')}`);
    });
  command.command('install').description('注册任务并迁移此工作区旧 cron 到统一 tick')
    .option('--jobs <ids>', 'memory,evolution（需要可用的 Sandbox Runtime）', 'memory,evolution')
    .option('--hour <hour>', '小时', '3').option('--minute <minute>', '分钟', '17')
    .option('--timezone <zone>', 'IANA 时区', 'Asia/Shanghai')
    .action(options => console.log(JSON.stringify(new WorkspaceSchedule({ workingDirectory: root, hour: Number(options.hour), minute: Number(options.minute), timezone: options.timezone }).install(parseJobs(options.jobs)))));
  command.command('status').action(() => console.log(JSON.stringify((dependencies.schedule || new WorkspaceSchedule({ workingDirectory: root })).status())));
  command.command('remove').option('--jobs <ids>', '移除指定任务，保留其他任务', 'memory,evolution')
    .action(options => console.log(JSON.stringify((dependencies.schedule || new WorkspaceSchedule({ workingDirectory: root })).remove(parseJobs(options.jobs)))));
}
function parseJobs(value: string): ScheduledJobId[] {
  const jobs = value.split(',').map(id => id.trim());
  if (!jobs.length || jobs.some(id => !['memory','evolution'].includes(id)) || new Set(jobs).size !== jobs.length) throw new Error('SCHEDULE_INVALID_JOB');
  return jobs as ScheduledJobId[];
}
