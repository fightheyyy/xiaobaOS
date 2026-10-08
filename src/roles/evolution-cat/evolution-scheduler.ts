import { WorkspaceSchedule, ScheduleOptions } from '../../events/scheduler';
export type { CrontabAdapter } from '../../events/scheduler';
export type EvolutionScheduleOptions = ScheduleOptions;
export interface EvolutionScheduleStatus { installed: boolean; schedule: string; command: string; marker: string }

/** Compatibility facade. Configuration, cron and time handling belong to shared Scheduler. */
export class EvolutionSleepSchedule {
  private readonly shared: WorkspaceSchedule;
  constructor(options: EvolutionScheduleOptions) {
    this.shared = new WorkspaceSchedule(options);
  }
  install() { const result = this.shared.install(['evolution']); return { ...this.shared.status('evolution'), changed: result.changed }; }
  remove() { const result = this.shared.remove(['evolution']); return { ...this.shared.status('evolution'), changed: result.changed }; }
  status() { return this.shared.status('evolution'); }
}
