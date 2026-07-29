import * as fs from 'fs';
import * as path from 'path';
import { CandidateTestResult } from '../roles/evolution-cat/evolution-workflow';
import { validateEvolutionCandidatePackage } from '../roles/evolution-cat/candidate-package';
import type { Candidate } from '../roles/evolution-cat/evolution-workflow';

export function runCandidatePackageTest(input: {
  working_directory: string;
  candidate: Readonly<Candidate>;
  out_dir: string;
}): CandidateTestResult {
  const outDir = path.resolve(input.out_dir);
  fs.mkdirSync(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'test-result.json');
  try {
    const verified = validateEvolutionCandidatePackage(
      input.working_directory,
      input.candidate,
    );
    const result: CandidateTestResult = {
      status: 'pass',
      evidence_refs: [resultPath],
      reasons: [],
    };
    fs.writeFileSync(resultPath, `${JSON.stringify({
      test_type: 'candidate_package',
      candidate_id: input.candidate.candidate_id,
      status: result.status,
      artifact_ref: input.candidate.artifact_ref,
      artifact_fingerprint: verified.artifact_fingerprint,
    }, null, 2)}\n`, 'utf-8');
    return result;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result: CandidateTestResult = {
      status: 'fail',
      evidence_refs: [resultPath],
      reasons: [reason],
    };
    fs.writeFileSync(resultPath, `${JSON.stringify({
      test_type: 'candidate_package',
      candidate_id: input.candidate.candidate_id,
      status: result.status,
      reasons: result.reasons,
    }, null, 2)}\n`, 'utf-8');
    return result;
  }
}
