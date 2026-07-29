import { Command } from 'commander';
import * as path from 'path';
import { runEvaluation } from '../eval/evaluation';
import {
  loadCaseSet,
  writeEvaluationResult,
} from '../eval/evaluation-files';
import { createReviewerCatJudge } from '../eval/reviewer-cat-judge';
import { verifyReplayTrace } from '../eval/verifier-registry';
import { createCaseReplayAdapter } from '../replay/case-replay';
import { PathResolver } from '../utils/path-resolver';

export function registerEvalCommand(program: Command): void {
  const evalCommand = program
    .command('eval')
    .description('Evaluate real Agent behavior from executable Cases');

  evalCommand
    .command('run')
    .requiredOption('--case-set <file>', 'CaseSet JSON file')
    .option('--runs <n>', 'Replay runs per Case; default 3')
    .option('--cwd <dir>', 'Runtime working directory')
    .option('--out <dir>', 'Evaluation output directory')
    .action(async (options: EvalRunOptions) => {
      const workingDirectory = path.resolve(
        options.cwd ?? PathResolver.getProjectRoot(),
      );
      const caseSet = loadCaseSet(options.caseSet);
      const runsPerCase = parsePositiveInteger(options.runs, '--runs') ?? 3;
      const outDir = path.resolve(
        options.out
          ?? path.join(
            workingDirectory,
            'output',
            'eval',
            safeSegment(caseSet.case_set_id),
            new Date().toISOString().replace(/[:.]/g, '-'),
          ),
      );
      const result = await runEvaluation(
        {
          case_set: caseSet,
          runs_per_case: runsPerCase,
        },
        {
          replay: createCaseReplayAdapter({
            working_directory: workingDirectory,
            code_root: PathResolver.getProjectRoot(),
            out_root: path.join(outDir, 'replay'),
          }),
          verify: async input => verifyReplayTrace(input),
          review: createReviewerCatJudge({
            working_directory: workingDirectory,
          }),
        },
      );
      const files = writeEvaluationResult(result, outDir);
      process.stdout.write(`${JSON.stringify({
        case_set_id: result.case_set_id,
        metrics: result.metrics,
        ...files,
      }, null, 2)}\n`);
    });
}

interface EvalRunOptions {
  caseSet: string;
  runs?: string;
  cwd?: string;
  out?: string;
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'case-set';
}
