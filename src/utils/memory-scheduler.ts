import { WorkspaceSchedule, ScheduleOptions } from '../events/scheduler';

/** Compatibility facade for the shared workspace cron and schedule configuration. */
export class MemoryMaintenanceSchedule {
  private readonly shared: WorkspaceSchedule;
  constructor(options: ScheduleOptions) { this.shared = new WorkspaceSchedule(options); }
  install() { const result = this.shared.install(['memory']); return { ...this.shared.status('memory'), changed: result.changed }; }
  remove() { const result = this.shared.remove(['memory']); return { ...this.shared.status('memory'), changed: result.changed }; }
  status() { return this.shared.status('memory'); }
}
