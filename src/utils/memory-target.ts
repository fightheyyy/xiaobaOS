import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { ConversationSurface } from './conversation-journal';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function registerMemoryTarget(root: string, target: { sessionKey: string; surface: ConversationSurface }): void {
  const directory = path.join(root, 'data/memory/targets');
  const id = digest(JSON.stringify([target.surface, target.sessionKey]));
  const file = path.join(directory, `${id}.json`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(target), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
