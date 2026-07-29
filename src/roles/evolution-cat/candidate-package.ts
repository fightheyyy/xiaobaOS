import * as fs from 'fs';
import * as path from 'path';
import { fingerprintArenaDirectory } from '../../arena/arena-manager';
import { SkillParser } from '../../skills/skill-parser';
import { Candidate, CandidateType } from './evolution-workflow';

const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createCapabilityCandidate(input: {
  working_directory: string;
  candidates_root: string;
  case_id: string;
  candidate_type: CandidateType;
  candidate_name: string;
  artifact_path: string;
}): Candidate {
  if (input.candidate_type === 'code') {
    throw new Error('Code Candidate must use the EngineerCat Source Candidate adapter');
  }
  const root = path.resolve(input.working_directory);
  const candidatesRoot = path.resolve(input.candidates_root);
  const candidateName = validateCandidateName(input.candidate_name);
  const artifactPath = path.resolve(input.working_directory, input.artifact_path);
  assertInside(artifactPath, candidatesRoot, 'Candidate artifact');
  if (path.basename(artifactPath) !== candidateName) {
    throw new Error('Candidate artifact directory must match candidate_name');
  }
  const artifactFingerprint = validatePackage(
    artifactPath,
    input.candidate_type,
    candidateName,
  );
  const baseVersion = fingerprintProductionTarget(
    root,
    input.candidate_type,
    candidateName,
  );
  const candidateId = [
    safeSegment(input.case_id),
    input.candidate_type,
    candidateName,
    artifactFingerprint.slice(0, 12),
  ].join('-');
  return {
    candidate_id: candidateId,
    owner: 'evolution-cat',
    candidate_type: input.candidate_type,
    candidate_name: candidateName,
    artifact_ref: displayPath(artifactPath, root),
    artifact_fingerprint: artifactFingerprint,
    base_version: baseVersion,
  };
}

export function validateEvolutionCandidatePackage(
  workingDirectory: string,
  candidate: Readonly<Candidate>,
): {
  artifact_path: string;
  artifact_fingerprint: string;
  production_path: string;
  base_version: string;
} {
  if (candidate.candidate_type === 'code') {
    throw new Error('Code Candidate is not a Role/Skill package');
  }
  const root = path.resolve(workingDirectory);
  const candidateName = validateCandidateName(candidate.candidate_name);
  const artifactPath = path.resolve(root, candidate.artifact_ref);
  const artifactFingerprint = validatePackage(
    artifactPath,
    candidate.candidate_type,
    candidateName,
  );
  if (artifactFingerprint !== candidate.artifact_fingerprint) {
    throw new Error(`Candidate artifact changed after creation: ${candidate.candidate_id}`);
  }
  const productionPath = productionTargetPath(
    root,
    candidate.candidate_type,
    candidateName,
  );
  return {
    artifact_path: artifactPath,
    artifact_fingerprint: artifactFingerprint,
    production_path: productionPath,
    base_version: fingerprintProductionTarget(
      root,
      candidate.candidate_type,
      candidateName,
    ),
  };
}

export function fingerprintProductionTarget(
  workingDirectory: string,
  candidateType: CandidateType,
  candidateName: string,
): string {
  if (candidateType === 'code') {
    throw new Error('Code Candidate has no capability package target');
  }
  const targetPath = productionTargetPath(
    path.resolve(workingDirectory),
    candidateType,
    validateCandidateName(candidateName),
  );
  if (!fs.existsSync(targetPath)) return 'absent';
  return fingerprintArenaDirectory(targetPath);
}

export function productionTargetPath(
  workingDirectory: string,
  candidateType: CandidateType,
  candidateName: string,
): string {
  if (candidateType === 'code') {
    throw new Error('Code Candidate has no capability package target');
  }
  const rootName = candidateType === 'skill' ? 'skills' : 'roles';
  return path.join(
    path.resolve(workingDirectory),
    rootName,
    validateCandidateName(candidateName),
  );
}

function validatePackage(
  artifactPath: string,
  candidateType: CandidateType,
  candidateName: string,
): string {
  if (candidateType === 'code') {
    throw new Error('Code Candidate is not a Role/Skill package');
  }
  if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isDirectory()) {
    throw new Error(`Candidate artifact directory does not exist: ${artifactPath}`);
  }
  const fingerprint = fingerprintArenaDirectory(artifactPath);
  if (candidateType === 'skill') {
    const skillPath = path.join(artifactPath, 'SKILL.md');
    if (!fs.existsSync(skillPath) || !fs.statSync(skillPath).isFile()) {
      throw new Error('Skill Candidate requires SKILL.md');
    }
    const skill = SkillParser.parse(skillPath);
    if (skill.metadata.name !== candidateName) {
      throw new Error(
        `Skill Candidate name mismatch: ${skill.metadata.name} != ${candidateName}`,
      );
    }
    return fingerprint;
  }

  const rolePath = path.join(artifactPath, 'role.json');
  if (!fs.existsSync(rolePath) || !fs.statSync(rolePath).isFile()) {
    throw new Error('Role Candidate requires role.json');
  }
  const role = JSON.parse(fs.readFileSync(rolePath, 'utf-8')) as Record<string, unknown>;
  if (role.name !== candidateName) {
    throw new Error(`Role Candidate name mismatch: ${String(role.name || '')} != ${candidateName}`);
  }
  const promptFile = typeof role.promptFile === 'string' ? role.promptFile.trim() : '';
  if (!promptFile || path.basename(promptFile) !== promptFile) {
    throw new Error('Role Candidate requires a safe promptFile');
  }
  const promptPath = path.join(artifactPath, 'prompts', promptFile);
  if (!fs.existsSync(promptPath) || !fs.statSync(promptPath).isFile()) {
    throw new Error(`Role Candidate prompt does not exist: prompts/${promptFile}`);
  }
  assertInside(fs.realpathSync(promptPath), fs.realpathSync(artifactPath), 'Role prompt');
  return fingerprint;
}

function validateCandidateName(value: string): string {
  const name = value.trim();
  if (!SAFE_NAME.test(name)) {
    throw new Error(`Candidate name must match ${SAFE_NAME}: ${value}`);
  }
  return name;
}

function assertInside(candidate: string, parent: string, label: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a child of ${parent}`);
  }
}

function displayPath(filePath: string, root: string): string {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'case';
}
