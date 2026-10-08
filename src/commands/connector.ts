import { GmailWatchStore } from '../connectors/gmail-watch';
import { Command } from 'commander';
import { appId, ConnectorError } from '../connectors/app-connector';
import { AgentConnectorService } from '../connectors/service';
import { DEFAULT_CREDENTIAL_REFS, CredentialRefs } from '../connectors/credentials';

/** Local management only. This command is not exposed as a chat tool or unauthenticated dashboard route. */
export function registerConnectorCommand(program: Command, dependencies: { root?: string; service?: AgentConnectorService } = {}): void {
  const root = dependencies.root || process.cwd();
  const service = dependencies.service || new AgentConnectorService(dependencies.root || process.cwd());
  const connector = program.command('connector').description('管理 Agent 自有的 Gmail / Notion / GitHub 连接');
  connector.command('list').description('连接状态；不输出凭据').action(() => console.log(JSON.stringify(service.status(),null,2)));
  connector.command('describe [app]').description('应用能力和操作参数').action(app => console.log(JSON.stringify(service.describe(app === undefined ? undefined : appId(app)),null,2)));
  connector.command('configure <app>').description('启用/禁用连接；只保存凭据的环境变量名称')
    .option('--disable','禁用连接').option('--token-env <name>','GitHub / Notion token 环境变量名')
    .option('--client-id-env <name>','Gmail OAuth client ID 环境变量名').option('--client-secret-env <name>','Gmail OAuth client secret 环境变量名')
    .option('--refresh-token-env <name>','Gmail OAuth refresh token 环境变量名')
    .action((raw,options) => {
      const app = appId(raw), previous = service.config.read().connections[app]?.credentialRefs || DEFAULT_CREDENTIAL_REFS[app];
      if (app === 'gmail' && options.tokenEnv || app !== 'gmail' && (options.clientIdEnv || options.clientSecretEnv || options.refreshTokenEnv)) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR','Credential fields do not match the app.');
      const refs: CredentialRefs = app === 'gmail' ? { clientId: options.clientIdEnv || previous.clientId, clientSecret: options.clientSecretEnv || previous.clientSecret, refreshToken: options.refreshTokenEnv || previous.refreshToken }
        : { token: options.tokenEnv || previous.token };
      service.config.configure(app,!options.disable,refs);
      console.log(JSON.stringify(service.status().find(item => item.app === app),null,2));
    });
  connector.command('watch-gmail').description('轮询 Gmail 新邮件并唤醒指定 session；首次配置只建立游标，不推送旧邮件')
    .requiredOption('--session <key>', '原聊天 session key').requiredOption('--surface <name>', 'cli / feishu / weixin / pet')
    .requiredOption('--channel <id>', '原聊天 channel ID').option('--disable', '停用轮询').option('--reset', '明确丢弃旧游标并以当前邮箱历史建立基线')
    .action(options => {const store=new GmailWatchStore(root);store.configure({sessionKey:options.session,surface:options.surface,channelId:options.channel},!options.disable,options.reset);console.log(JSON.stringify(store.read(),null,2));});
  connector.command('watch-status').description('查看 Gmail 变化订阅配置')
    .action(() => console.log(JSON.stringify(new GmailWatchStore(root).read() || {enabled:false},null,2)));
  connector.command('receipts').description('查看写操作回执（不输出请求参数或结果正文）')
    .action(() => console.log(JSON.stringify(service.actionReceipts.list(),null,2)));
  connector.command('review <id>').description('核对外部 App 后解除未知结果拦截；原调用 ID 永不重放')
    .requiredOption('--checked', '已在外部 App 核对实际结果')
    .action(id => {service.actionReceipts.review(id);console.log(JSON.stringify({id,status:'reviewed'}));});
  connector.command('verify <app>').description('只读验证连接，识别 Agent 的实际账户').action(async raw => {
    const app = appId(raw);
    const result = await service.invoke(app,{ operation: 'account.get', args: {} },{ surface: 'cli', sessionId: 'local-connector-management' });
    console.log(JSON.stringify({ app, ...result },null,2));
  });
}
