/**
 * Deterministic implementation tests that drive the real Runtime with
 * prewritten model actions.
 *
 * These APIs intentionally live under testing. They must never be used as
 * evidence of Agent behavioral capability.
 */
export {
  runScriptedRuntimeTestSuite,
  loadEvalSuite as loadScriptedRuntimeTestSuite,
} from './scripted-runtime-runner';
export {
  renderScriptedRuntimeTestReport,
  writeScriptedRuntimeTestResult,
} from './scripted-runtime-result';
export {
  runScriptedRuntimeTestBenchmark,
  writeScriptedRuntimeTestBenchmarkResult,
  loadEvalBenchmark as loadScriptedRuntimeTestSet,
  assertScriptedRuntimeTestSet,
} from './scripted-runtime-test-set';
export type {
  EvalDecision as TestDecision,
  EvalScorecard as ScriptedRuntimeTestResult,
} from './scripted-runtime-types';
export { runCandidatePackageTest } from './candidate-package-test';
