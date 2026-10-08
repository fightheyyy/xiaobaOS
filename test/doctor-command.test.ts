import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import { Command } from 'commander';
import { registerDoctorCommand } from '../src/commands/doctor';
import { ReadinessReport } from '../src/doctor/types';

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
});

function report(ready: boolean): ReadinessReport {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-17T00:00:00.000Z',
    overall: ready ? 'ready' : 'not_ready',
    ready,
    app: {
      name: 'xiaoba-cli',
      version: '0.2.0',
      nodeVersion: 'v24.19.0',
      platform: 'darwin',
      arch: 'arm64',
    },
    context: {
      cwd: '/project',
      projectRoot: '/project',
      rolesRoot: '/project/roles',
      requestedRole: 'base',
      activeRole: null,
    },
    summary: {
      total: 1,
      passed: ready ? 1 : 0,
      warnings: 0,
      failed: ready ? 0 : 1,
      blocked: 0,
      requiredIssues: ready ? 0 : 1,
    },
    checks: [{
      id: 'runtime.node',
      category: 'runtime',
      label: 'Runtime',
      status: ready ? 'pass' : 'fail',
      required: true,
      summary: ready ? 'Ready.' : 'Not ready.',
      ...(!ready && { nextAction: 'Fix the runtime.' }),
    }],
  };
}

function program(): Command {
  return new Command()
    .exitOverride()
    .configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
}

describe('registerDoctorCommand', () => {
  test('writes one machine-readable JSON document', async () => {
    const outputs: string[] = [];
    const cli = program();
    registerDoctorCommand(cli, {
      run: async () => report(true),
      write: output => outputs.push(output),
    });

    await cli.parseAsync(['node', 'xiaoba', 'doctor', '--json']);

    assert.strictEqual(outputs.length, 1);
    const parsed = JSON.parse(outputs[0]);
    assert.strictEqual(parsed.schemaVersion, 1);
    assert.strictEqual(parsed.overall, 'ready');
    assert.strictEqual(process.exitCode, originalExitCode);
  });

  test('passes the requested role and sets a deferred unhealthy exit code', async () => {
    const outputs: string[] = [];
    let requestedRole = '';
    const cli = program();
    registerDoctorCommand(cli, {
      run: async options => {
        requestedRole = options.requestedRole || '';
        return report(false);
      },
      write: output => outputs.push(output),
    });

    process.exitCode = undefined;
    await cli.parseAsync(['node', 'xiaoba', 'doctor', '--role', 'browser-cat']);

    assert.strictEqual(requestedRole, 'browser-cat');
    assert.strictEqual(process.exitCode, 1);
    assert.match(outputs[0], /Overall: NOT_READY/);
    assert.match(outputs[0], /Next actions/);
  });
});
