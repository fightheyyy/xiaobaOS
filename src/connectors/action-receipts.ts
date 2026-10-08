import * as fs from 'node:fs';
import * as path from 'node:path';
import { hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { AppId, AppRequest, AppResult, ConnectorError } from './app-connector';

export interface ActionReceipt {
  version: 1; id: string; fingerprint: string; app: AppId; operation: string;
  status: 'running' | 'succeeded' | 'uncertain' | 'rejected' | 'reviewed';
  createdAt: string; updatedAt: string; pid: number; host: string; result?: AppResult;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

/** Agent-local evidence, never a claim of exactly-once execution at an external API. */
export class ConnectorActionReceipts {
  private readonly directory: string;
  constructor(root: string) { this.directory = path.join(root, 'data/connectors/actions'); }
  list(): Omit<ActionReceipt, 'result'>[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const { result: _result, ...record } = this.read(name.slice(0,-5))!; return record;
    });
  }
  async execute(app: AppId, request: AppRequest, scope: { sessionId?: string; surface?: string }, actionId: string | undefined,
    invoke: () => Promise<AppResult>): Promise<AppResult> {
    const fingerprint = hash([app, request.operation, canonical(request.args)]);
    const id = hash([scope.surface, scope.sessionId, app, actionId || randomUUID()]);
    const admission = this.lock(() => {
      const previous = this.read(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ConnectorError('CONNECTOR_ACTION_CONFLICT', 'Action identity was reused with different arguments.');
        if (previous.status === 'succeeded' && previous.result) return previous.result;
        throw new ConnectorError('CONNECTOR_ACTION_REVIEW_REQUIRED', `Action ${id} already attempted; inspect its receipt before issuing a new action.`);
      }
      if (this.list().some(record => record.fingerprint === fingerprint && ['running','uncertain'].includes(record.status))) {
        throw new ConnectorError('CONNECTOR_ACTION_REVIEW_REQUIRED', 'An identical write is running or has an unknown outcome. Inspect connector receipts before retrying.');
      }
      const now = new Date().toISOString();
      this.write({ version:1,id,fingerprint,app,operation:request.operation,status:'running',createdAt:now,updatedAt:now,pid:process.pid,host:hostname() });
      return undefined;
    });
    if (admission) return admission;
    let result: AppResult;
    try { result = await invoke(); }
    catch (error) {
      // Definite HTTP rejection can be retried as a NEW confirmed action. Transport
      // failures and unreadable/lost successful responses require external review.
      const rejected = error instanceof ConnectorError && error.httpStatus !== undefined && [400,401,403,404,409,422,429].includes(error.httpStatus);
      this.finish(id, rejected ? 'rejected' : 'uncertain');
      throw error;
    }
    // A failed local receipt commit also leaves the durable running claim intact.
    this.finish(id, 'succeeded', result);
    return result;
  }
  /** Local operator only, after checking the app. Never exposed as an Agent tool. */
  review(id: string): void {
    this.lock(() => {
      const record = this.read(id);
      if (!record || !['running','uncertain'].includes(record.status)) throw new ConnectorError('CONNECTOR_ACTION_CONFLICT', 'Receipt does not require review.');
      if (record.status === 'running') {
        let alive=true;
        if(record.host===hostname()) { try {process.kill(record.pid,0);} catch(error:any) {if(error.code==='ESRCH') alive=false;} }
        if(alive) throw new ConnectorError('CONNECTOR_ACTION_REVIEW_REQUIRED', 'Running receipt may belong to a live process; stop the original service and reconcile it before clearing.');
      }
      this.write({ ...record, status:'reviewed',updatedAt:new Date().toISOString() });
    });
  }
  private finish(id: string, status: ActionReceipt['status'], result?: AppResult): void {
    this.lock(() => { const record=this.read(id)!; this.write({ ...record,status,updatedAt:new Date().toISOString(),...(result ? {result}: {}) }); });
  }
  private read(id: string): ActionReceipt | undefined {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new ConnectorError('CONNECTOR_ACTION_CONFLICT','Invalid action receipt identity.');
    const file=path.join(this.directory,id+'.json'); if(!fs.existsSync(file)) return undefined;
    try {
      const record=JSON.parse(fs.readFileSync(file,'utf8'));
      if(record.version!==1 || record.id!==id || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !['running','succeeded','uncertain','rejected','reviewed'].includes(record.status)
        || !Number.isSafeInteger(record.pid) || record.pid < 1 || typeof record.host !== 'string' || !['gmail','github','notion'].includes(record.app) || typeof record.operation!=='string' || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))
        || record.status==='succeeded' && (!record.result || !Object.prototype.hasOwnProperty.call(record.result,'data'))) throw new Error();
      return record;
    } catch { throw new ConnectorError('CONNECTOR_CONFIG_INVALID','Corrupt action receipt; inspect before executing writes.'); }
  }
  private write(record: ActionReceipt): void {
    const file=path.join(this.directory,record.id+'.json'), tmp=file+'.'+randomUUID()+'.tmp';
    try { fs.writeFileSync(tmp,JSON.stringify(record)+'\n',{mode:0o600});fs.renameSync(tmp,file); }
    finally { fs.rmSync(tmp,{force:true}); }
  }
  private lock<T>(action: () => T): T {
    fs.mkdirSync(this.directory,{recursive:true,mode:0o700});const lock=path.join(this.directory,'mutation.lock');
    try {fs.mkdirSync(lock,{mode:0o700});} catch {throw new ConnectorError('CONNECTOR_ACTION_REVIEW_REQUIRED','Receipt storage is busy or interrupted. Inspect before retrying.');}
    try {return action();} finally {fs.rmdirSync(lock);}
  }
}
