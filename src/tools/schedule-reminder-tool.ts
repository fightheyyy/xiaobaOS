import { Tool, ToolDefinition, ToolExecutionContext, ToolExecutionOutput } from '../types/tool';
import { SessionReminderStore, ReminderOwner, ReminderInput } from '../events/session-reminders';
import { toolFailure, toolSuccess } from './tool-result';

export class ScheduleReminderTool implements Tool {
  definition: ToolDefinition = {
    name: 'schedule_reminder',
    description: '当前 session 的一次性定时提醒/检查。用户明确要求提醒用 source=user、mode=remind；你判断需要稍后跟进用 source=agent、mode=check。支持创建、列出、修改、取消。due_at 必须是带时区的未来 ISO 时间；中国用户通常用 +08:00。只有成功后才确认已设置。',
    parameters: { type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['create','list','update','cancel'] },
      reminder_id: { type: 'string', description: 'update/cancel 必须是当前 session 的已有 ID。' },
      due_at: { type: 'string', description: '未来绝对时间，如 2026-10-09T15:00:00+08:00。不要省略时区；时间有歧义先澄清。' },
      purpose: { type: 'string', description: 'remind 为要交付的简短提醒正文；check 为检查目标和上下文，最多1000字。' },
      source: { type: 'string', enum: ['user','agent'], description: '仅用户明确要求时标 user；主动安排标 agent。' },
      mode: { type: 'string', enum: ['remind','check'], description: 'remind 直接发送提醒；check 唤醒你判断是否需要行动/说话。' },
    } },
  };
  async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionOutput> {
    if (!context.sessionId || context.parentSessionId || !['cli','feishu','weixin','pet'].includes(context.surface || '')) return toolFailure('需要当前主 session 和入口上下文。', 'REMINDER_OWNER_REQUIRED');
    if (context.surface !== 'cli' && !context.channel?.chatId) return toolFailure('需要原入口的 channel。', 'REMINDER_CHANNEL_REQUIRED');
    const owner: ReminderOwner = { sessionKey: context.sessionId, surface: context.surface as ReminderOwner['surface'], channelId: context.channel?.chatId || context.sessionId };
    const store = new SessionReminderStore(context.workingDirectory);
    try {
      let result: unknown;
      if (args?.action === 'create') result = await store.create(owner, { dueAt: args.due_at, purpose: args.purpose, source: args.source, mode: args.mode });
      else if (args?.action === 'list') {
        const records = store.list(owner);
        result = { active: records.filter(record => ['pending','running'].includes(record.status)),
          recent: records.filter(record => ['completed','cancelled','failed'].includes(record.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20) };
      }
      else if (args?.action === 'cancel') result = await store.cancel(owner, args.reminder_id);
      else if (args?.action === 'update') {
        const patch: Partial<ReminderInput> = {};
        if (args.due_at !== undefined) patch.dueAt = args.due_at;
        if (args.purpose !== undefined) patch.purpose = args.purpose;
        if (args.source !== undefined) patch.source = args.source;
        if (args.mode !== undefined) patch.mode = args.mode;
        if (!Object.keys(patch).length) throw new Error('REMINDER_UPDATE_REQUIRED');
        result = await store.update(owner, args.reminder_id, patch);
      } else throw new Error('REMINDER_ACTION_INVALID');
      return toolSuccess(JSON.stringify({ ok: true, action: args.action, result, current_time: new Date().toISOString(), delivery: '原入口在线且空闲时触发；离线保留 pending，check 可保持静默。' }));
    } catch (error: any) { return toolFailure(error.message || String(error), /^REMINDER_/.test(error.message) ? error.message : 'REMINDER_STORE_FAILED'); }
  }
}
