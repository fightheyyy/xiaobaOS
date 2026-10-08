import { sandboxExecutor } from '../src/sandbox/executor';
import { createSandboxPolicy } from '../src/sandbox/policy';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  activateSourceCandidate,
  createSourceCandidate,
  createSourceCandidateWorkspace,
  fingerprintSourceVersion,
  validateSourceCandidate,
} from '../src/roles/evolution-cat/source-candidate';
import { runSourceCandidateTest } from '../src/testing/source-candidate-test';

describe('EngineerCat Source Candidate', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-source-candidate-'));
    write(root, 'src/value.ts', 'export const value = "old";\n');
    write(root, 'dist/index.js', 'exports.value = "old";\n');
    write(root, 'package.json', '{"name":"fixture","version":"1.0.0"}\n');
    write(root, 'tsconfig.json', JSON.stringify({
      compilerOptions: {
        module: 'commonjs',
        target: 'ES2022',
        outDir: 'dist',
        skipLibCheck: true,
        types: [],
      },
      include: ['src/**/*.ts'],
    }));
    write(
      root,
      'scripts/run-tests.mjs',
      [
        'if (process.env.XIAOBA_PROJECT_ROOT || process.env.XIAOBA_APP_ROOT) process.exit(2);',
        'process.stdout.write("fixture tests passed\\n");',
        '',
      ].join('\n'),
    );
    fs.symlinkSync(
      path.dirname(path.dirname(path.dirname(require.resolve('typescript/bin/tsc')))),
      path.join(root, 'node_modules'),
      'dir',
    );
    write(root, '.env', 'SECRET_MUST_NOT_COPY=1\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('copies a secret-free source base and creates an immutable code Candidate', () => {
    const candidatesRoot = path.join(root, 'output', 'evolution', 'runs', 'one', 'candidates');
    const workspace = createSourceCandidateWorkspace({
      working_directory: root,
      candidates_root: candidatesRoot,
    });
    assert.equal(fs.existsSync(path.join(workspace.artifact_path, '.env')), false);
    write(workspace.artifact_path, 'src/value.ts', 'export const value = "new";\n');

    const candidate = createSourceCandidate({
      working_directory: root,
      candidates_root: candidatesRoot,
      case_id: 'source-fix',
      artifact_path: workspace.artifact_path,
      base_version: workspace.base_version,
      base_source_fingerprint: workspace.base_source_fingerprint,
    });
    assert.equal(candidate.owner, 'engineer-cat');
    assert.equal(candidate.candidate_type, 'code');
    assert.match(candidate.artifact_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(validateSourceCandidate(root, candidate).artifact_path, workspace.artifact_path);
  });

  test('activates tested source plus dist transactionally for the next process', () => {
    const candidatesRoot = path.join(root, 'output', 'evolution', 'runs', 'two', 'candidates');
    const workspace = createSourceCandidateWorkspace({
      working_directory: root,
      candidates_root: candidatesRoot,
    });
    write(workspace.artifact_path, 'src/value.ts', 'export const value = "new";\n');
    const candidate = createSourceCandidate({
      working_directory: root,
      candidates_root: candidatesRoot,
      case_id: 'activate-source',
      artifact_path: workspace.artifact_path,
      base_version: workspace.base_version,
      base_source_fingerprint: workspace.base_source_fingerprint,
    });
    write(workspace.artifact_path, 'dist/index.js', 'exports.value = "new";\n');

    const outDir = path.join(root, 'output', 'evolution', 'activation');
    activateSourceCandidate({
      working_directory: root,
      candidate,
      out_dir: outDir,
    });

    assert.match(fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf-8'), /new/);
    assert.match(fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf-8'), /new/);
    const evidence = JSON.parse(
      fs.readFileSync(path.join(outDir, `${candidate.candidate_id}.json`), 'utf-8'),
    );
    assert.equal(evidence.scope, 'next_process');
    assert.deepEqual(evidence.changed_refs.sort(), ['dist/index.js', 'src/value.ts']);
    assert.equal(fingerprintSourceVersion(root), fingerprintSourceVersion(workspace.artifact_path));
  });

  test('fails closed when production source changes after Candidate creation', () => {
    const candidatesRoot = path.join(root, 'output', 'evolution', 'runs', 'three', 'candidates');
    const workspace = createSourceCandidateWorkspace({
      working_directory: root,
      candidates_root: candidatesRoot,
    });
    write(workspace.artifact_path, 'src/value.ts', 'export const value = "candidate";\n');
    const candidate = createSourceCandidate({
      working_directory: root,
      candidates_root: candidatesRoot,
      case_id: 'stale-source',
      artifact_path: workspace.artifact_path,
      base_version: workspace.base_version,
      base_source_fingerprint: workspace.base_source_fingerprint,
    });
    write(workspace.artifact_path, 'dist/index.js', 'exports.value = "candidate";\n');
    write(root, 'src/value.ts', 'export const value = "concurrent";\n');

    assert.throws(
      () => activateSourceCandidate({
        working_directory: root,
        candidate,
        out_dir: path.join(root, 'output', 'evolution', 'activation'),
      }),
      /changed after Source Candidate creation/,
    );
    assert.match(fs.readFileSync(path.join(root, 'src', 'value.ts'), 'utf-8'), /concurrent/);
  });

  test('runs build and repository tests in the native sandbox without root env overrides', async context => {
    if (process.env.XIAOBA_SOURCE_CANDIDATE_TEST === '1') {
      context.skip('Source Candidate Test does not recursively execute itself');
      return;
    }
    const candidatesRoot = path.join(root, 'output', 'evolution', 'runs', 'sandbox', 'candidates');
    const workspace = createSourceCandidateWorkspace({
      working_directory: root,
      candidates_root: candidatesRoot,
    });
    write(workspace.artifact_path, 'src/value.ts', 'export const value = "sandboxed";\n');
    const candidate = createSourceCandidate({
      working_directory: root,
      candidates_root: candidatesRoot,
      case_id: 'sandbox-source',
      artifact_path: workspace.artifact_path,
      base_version: workspace.base_version,
      base_source_fingerprint: workspace.base_source_fingerprint,
    });

    const result = await runSourceCandidateTest({
      working_directory: root,
      candidate,
      out_dir: path.join(root, 'output', 'evolution', 'test'),
    });

    const probe = await sandboxExecutor.probe(createSandboxPolicy({ cwd: root, scratchRoot: path.join(root, 'probe') }));
    if (probe.available) {
      const diagnostic = result.evidence_refs
        .filter(ref => fs.existsSync(ref))
        .map(ref => `${ref}\n${fs.readFileSync(ref, 'utf-8')}`)
        .join('\n');
      assert.equal(result.status, 'pass', `${result.reasons.join('\n')}\n${diagnostic}`);
      assert.match(
        fs.readFileSync(path.join(root, 'output', 'evolution', 'test', 'tests.log'), 'utf-8'),
        /fixture tests passed/,
      );
    } else {
      assert.equal(result.status, 'blocked');
      assert.match(result.reasons.join('\n'), /sandbox|Sandbox/);
    }
  });
});

function write(root: string, relative: string, content: string): void {
  const filePath = path.join(root, relative);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}
