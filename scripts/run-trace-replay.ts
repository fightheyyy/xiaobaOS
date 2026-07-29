import { runTraceReplay, renderTraceReplayReport } from '../src/replay/trace-replay-runner';
import {
  createReplayServices,
  ReplaySandboxMode,
} from '../src/replay/replay-services';

interface CliOptions {
  trace?: string;
  out?: string;
  cwd?: string;
  petId?: string;
  sessionKey?: string;
  maxTurns?: number;
  timeoutMs?: number;
  source?: string;
  sandboxMode?: ReplaySandboxMode;
  parentSessionId?: string;
  role?: string;
  requiredActiveSkillName?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--trace') {
      options.trace = next;
      index++;
    } else if (arg === '--out') {
      options.out = next;
      index++;
    } else if (arg === '--cwd') {
      options.cwd = next;
      index++;
    } else if (arg === '--pet-id') {
      options.petId = next;
      index++;
    } else if (arg === '--session-key') {
      options.sessionKey = next;
      index++;
    } else if (arg === '--max-turns') {
      options.maxTurns = parsePositiveInt(next, '--max-turns');
      index++;
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = parsePositiveInt(next, '--timeout-ms');
      index++;
    } else if (arg === '--source') {
      options.source = next;
      index++;
    } else if (arg === '--read-only') {
      options.sandboxMode = 'read_only';
    } else if (arg === '--sandbox-mode') {
      if (next !== 'read_only' && next !== 'workspace_write') {
        throw new Error('--sandbox-mode must be read_only or workspace_write');
      }
      options.sandboxMode = next;
      index++;
    } else if (arg === '--parent-session-id') {
      options.parentSessionId = next;
      index++;
    } else if (arg === '--role') {
      options.role = next;
      index++;
    } else if (arg === '--required-active-skill') {
      options.requiredActiveSkillName = next;
      index++;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function printHelp(): void {
  console.log([
    'Usage: npm run replay:trace -- --trace <logs/sessions/.../traces.jsonl> [options]',
    '',
    'Options:',
    '  --trace <file>        Historical session trace JSONL to replay.',
    '  --out <dir>           Output directory. Defaults to output/replay/trace-rerun/<run-id>.',
    '  --cwd <dir>           Working directory. Defaults to current directory.',
    '  --pet-id <id>         Pet id. Defaults to pet id inferred from trace session_id.',
    '  --session-key <key>   Fresh replay session key. Defaults to pet:<pet-id>:trace-replay-...',
    '  --max-turns <n>       Replay only the first n trace inputs.',
    '  --timeout-ms <n>      Per-turn timeout. Defaults to 180000.',
    '  --source <name>        Replay provenance source.',
    '  --sandbox-mode <mode>  Internal Case Replay mode: read_only|workspace_write.',
    '  --read-only            Compatibility alias for --sandbox-mode read_only.',
    '  --parent-session-id    Trusted parent id required by sandbox mode.',
    '  --role <name>          Optional target role for sandbox mode.',
    '  --required-active-skill <name>  Internal evaluator Skill pin.',
  ].join('\n'));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.trace) {
    printHelp();
    throw new Error('--trace is required');
  }

  if (options.sandboxMode && !options.parentSessionId) {
    throw new Error('--sandbox-mode requires --parent-session-id');
  }
  const services = options.sandboxMode
    ? await createReplayServices({
        working_directory: options.cwd || process.cwd(),
        parent_session_id: options.parentSessionId || '',
        sandbox_mode: options.sandboxMode,
        role_name: options.role,
      })
    : undefined;

  const report = await runTraceReplay({
    tracePath: options.trace,
    outDir: options.out,
    cwd: options.cwd,
    petId: options.petId,
    sessionKey: options.sessionKey,
    maxTurns: options.maxTurns,
    timeoutMs: options.timeoutMs,
    source: options.source,
    services,
    requiredActiveSkillName: options.requiredActiveSkillName,
  });

  console.log(renderTraceReplayReport(report));
  console.log(`Artifacts: ${report.out_dir}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
