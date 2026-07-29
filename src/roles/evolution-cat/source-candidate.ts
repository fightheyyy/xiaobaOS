import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  Candidate,
} from './evolution-workflow';

export const SOURCE_CANDIDATE_NAME = 'xiaoba-source';

const SOURCE_DIRECTORIES = [
  'desktop',
  'docs',
  'eval',
  'prompts',
  'roles',
  'scripts',
  'skills',
  'src',
  'test',
];

const SOURCE_ROOT_FILES = [
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.gitmodules',
  'AGENTS.md',
  'LICENSE',
  'README.en.md',
  'README.md',
  'package-lock.json',
  'package.json',
  'requirement.txt',
  'skill-registry.json',
  'tsconfig.json',
];

export interface SourceCandidateWorkspace {
  artifact_path: string;
  base_version: string;
  base_source_fingerprint: string;
}

export function createSourceCandidateWorkspace(input: {
  working_directory: string;
  candidates_root: string;
}): SourceCandidateWorkspace {
  const root = fs.realpathSync(path.resolve(input.working_directory));
  const candidatesRoot = path.resolve(input.candidates_root);
  const artifactPath = path.join(candidatesRoot, SOURCE_CANDIDATE_NAME);
  assertInside(artifactPath, candidatesRoot, 'Source Candidate workspace');
  fs.rmSync(artifactPath, { recursive: true, force: true });
  fs.mkdirSync(artifactPath, { recursive: true });

  for (const relative of SOURCE_DIRECTORIES) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) continue;
    copyOwnedTree(source, path.join(artifactPath, relative));
  }
  for (const relative of SOURCE_ROOT_FILES) {
    const source = path.join(root, relative);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.copyFileSync(source, path.join(artifactPath, relative));
    fs.chmodSync(path.join(artifactPath, relative), fs.statSync(source).mode);
  }

  const baseSourceFingerprint = fingerprintSourceTree(root);
  const copiedFingerprint = fingerprintSourceTree(artifactPath);
  if (copiedFingerprint !== baseSourceFingerprint) {
    fs.rmSync(artifactPath, { recursive: true, force: true });
    throw new Error('Source Candidate workspace does not match its production base');
  }
  return {
    artifact_path: artifactPath,
    base_version: fingerprintSourceVersion(root),
    base_source_fingerprint: baseSourceFingerprint,
  };
}

export function createSourceCandidate(input: {
  working_directory: string;
  candidates_root: string;
  case_id: string;
  artifact_path: string;
  base_version: string;
  base_source_fingerprint: string;
}): Candidate {
  const root = path.resolve(input.working_directory);
  const candidatesRoot = path.resolve(input.candidates_root);
  const artifactPath = path.resolve(input.artifact_path);
  assertInside(artifactPath, candidatesRoot, 'Source Candidate artifact');
  if (path.basename(artifactPath) !== SOURCE_CANDIDATE_NAME) {
    throw new Error(`Source Candidate directory must be ${SOURCE_CANDIDATE_NAME}`);
  }
  const artifactFingerprint = fingerprintSourceTree(artifactPath);
  if (artifactFingerprint === input.base_source_fingerprint) {
    throw new Error('EngineerCat Source Candidate contains no source change');
  }
  return {
    candidate_id: [
      safeSegment(input.case_id),
      'code',
      artifactFingerprint.slice(0, 12),
    ].join('-'),
    owner: 'engineer-cat',
    candidate_type: 'code',
    candidate_name: SOURCE_CANDIDATE_NAME,
    artifact_ref: displayPath(artifactPath, root),
    artifact_fingerprint: artifactFingerprint,
    base_version: input.base_version,
  };
}

export function validateSourceCandidate(
  workingDirectory: string,
  candidate: Readonly<Candidate>,
): {
  artifact_path: string;
  artifact_fingerprint: string;
  base_version: string;
} {
  if (
    candidate.candidate_type !== 'code'
    || candidate.owner !== 'engineer-cat'
    || candidate.candidate_name !== SOURCE_CANDIDATE_NAME
  ) {
    throw new Error('Source Candidate requires EngineerCat-owned code/xiaoba-source identity');
  }
  const root = path.resolve(workingDirectory);
  const artifactPath = path.resolve(root, candidate.artifact_ref);
  const candidatesRoot = path.join(root, 'output', 'evolution');
  assertInside(artifactPath, candidatesRoot, 'Source Candidate artifact');
  const artifactFingerprint = fingerprintSourceTree(artifactPath);
  if (artifactFingerprint !== candidate.artifact_fingerprint) {
    throw new Error(`Source Candidate changed after creation: ${candidate.candidate_id}`);
  }
  return {
    artifact_path: artifactPath,
    artifact_fingerprint: artifactFingerprint,
    base_version: fingerprintSourceVersion(root),
  };
}

export function fingerprintSourceTree(rootDirectory: string): string {
  return fingerprintFileMap(collectSourceFiles(path.resolve(rootDirectory)));
}

export function fingerprintSourceVersion(rootDirectory: string): string {
  const root = path.resolve(rootDirectory);
  const source = fingerprintSourceTree(root);
  const dist = fingerprintPath(path.join(root, 'dist'));
  return crypto.createHash('sha256')
    .update(`source:${source}\ndist:${dist}\n`)
    .digest('hex');
}

export function activateSourceCandidate(input: {
  working_directory: string;
  candidate: Readonly<Candidate>;
  out_dir: string;
}): void {
  const root = path.resolve(input.working_directory);
  const verified = validateSourceCandidate(root, input.candidate);
  if (verified.base_version !== input.candidate.base_version) {
    throw new Error('Production source changed after Source Candidate creation');
  }
  const candidateDist = path.join(verified.artifact_path, 'dist');
  if (!fs.existsSync(path.join(candidateDist, 'index.js'))) {
    throw new Error('Source Candidate requires a successful build before activation');
  }

  const productionSource = collectSourceFiles(root);
  const candidateSource = collectSourceFiles(verified.artifact_path);
  const productionDist = collectFiles(path.join(root, 'dist'));
  const builtDist = collectFiles(candidateDist);
  const changes = [
    ...diffFileMaps(productionSource, candidateSource),
    ...diffFileMaps(productionDist, builtDist, 'dist'),
  ];
  if (changes.length === 0) {
    throw new Error('Source Candidate activation found no changed file');
  }

  const outDir = path.resolve(input.out_dir);
  const transactionRoot = path.join(
    outDir,
    `.source-activation-${crypto.randomUUID()}`,
  );
  const backupRoot = path.join(transactionRoot, 'backup');
  fs.mkdirSync(backupRoot, { recursive: true });
  const applied: Array<{ target: string; backup?: string }> = [];
  try {
    for (const change of changes) {
      const target = path.join(root, change.relative);
      assertInside(target, root, 'Source activation target');
      const backup = path.join(backupRoot, change.relative);
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile()) {
          throw new Error(`Source activation target is not a file: ${change.relative}`);
        }
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.renameSync(target, backup);
      }
      applied.push({
        target,
        ...(fs.existsSync(backup) ? { backup } : {}),
      });
      if (change.source) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.activate-${crypto.randomUUID()}`;
        fs.copyFileSync(change.source, temporary);
        fs.chmodSync(temporary, fs.statSync(change.source).mode);
        fs.renameSync(temporary, target);
      }
    }

    const expectedVersion = fingerprintCandidateVersion(verified.artifact_path);
    if (fingerprintSourceVersion(root) !== expectedVersion) {
      throw new Error('Activated source does not match the tested Source Candidate');
    }
  } catch (error) {
    rollbackAppliedFiles(applied);
    fs.rmSync(transactionRoot, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(transactionRoot, { recursive: true, force: true });

  fs.mkdirSync(outDir, { recursive: true });
  atomicWriteJson(path.join(outDir, `${safeSegment(input.candidate.candidate_id)}.json`), {
    activation_version: 1,
    candidate_id: input.candidate.candidate_id,
    candidate_type: 'code',
    candidate_name: input.candidate.candidate_name,
    artifact_fingerprint: input.candidate.artifact_fingerprint,
    changed_refs: changes.map(change => change.relative),
    scope: 'next_process',
    activated_at: new Date().toISOString(),
  });
}

function fingerprintCandidateVersion(artifactPath: string): string {
  const source = fingerprintSourceTree(artifactPath);
  const dist = fingerprintPath(path.join(artifactPath, 'dist'));
  return crypto.createHash('sha256')
    .update(`source:${source}\ndist:${dist}\n`)
    .digest('hex');
}

function collectSourceFiles(root: string): Map<string, FileFact> {
  const files = new Map<string, FileFact>();
  for (const relative of SOURCE_DIRECTORIES) {
    const directory = path.join(root, relative);
    for (const [child, fact] of collectFiles(directory)) {
      files.set(path.posix.join(relative, child), fact);
    }
  }
  for (const relative of SOURCE_ROOT_FILES) {
    const filePath = path.join(root, relative);
    if (!fs.existsSync(filePath)) continue;
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Source tree requires a regular file: ${relative}`);
    }
    files.set(relative, fileFact(filePath, stat));
  }
  return files;
}

function collectFiles(directory: string): Map<string, FileFact> {
  const files = new Map<string, FileFact>();
  if (!fs.existsSync(directory)) return files;
  const root = path.resolve(directory);
  walk(root, '');
  return files;

  function walk(current: string, relative: string): void {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const child = path.join(current, entry.name);
      const childRelative = path.posix.join(relative, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Source Candidate does not allow symlinks: ${childRelative}`);
      }
      if (entry.isDirectory()) {
        walk(child, childRelative);
      } else if (entry.isFile()) {
        files.set(childRelative, fileFact(child, fs.statSync(child)));
      }
    }
  }
}

interface FileFact {
  path: string;
  digest: string;
  mode: number;
}

function fileFact(filePath: string, stat: fs.Stats): FileFact {
  return {
    path: filePath,
    digest: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
    mode: stat.mode & 0o777,
  };
}

function fingerprintFileMap(files: ReadonlyMap<string, FileFact>): string {
  const hash = crypto.createHash('sha256');
  for (const [relative, fact] of [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fact.digest);
    hash.update('\0');
    hash.update(String(fact.mode));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function fingerprintPath(directory: string): string {
  return fs.existsSync(directory)
    ? fingerprintFileMap(collectFiles(directory))
    : 'absent';
}

function diffFileMaps(
  before: ReadonlyMap<string, FileFact>,
  after: ReadonlyMap<string, FileFact>,
  prefix = '',
): Array<{ relative: string; source?: string }> {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.flatMap(relative => {
    const prior = before.get(relative);
    const next = after.get(relative);
    if (prior?.digest === next?.digest && prior?.mode === next?.mode) return [];
    return [{
      relative: prefix ? path.posix.join(prefix, relative) : relative,
      ...(next ? { source: next.path } : {}),
    }];
  });
}

function rollbackAppliedFiles(
  applied: readonly { target: string; backup?: string }[],
): void {
  for (const item of [...applied].reverse()) {
    if (fs.existsSync(item.target)) fs.rmSync(item.target, { force: true });
    if (item.backup && fs.existsSync(item.backup)) {
      fs.mkdirSync(path.dirname(item.target), { recursive: true });
      fs.renameSync(item.backup, item.target);
    }
  }
}

function copyOwnedTree(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Source Candidate does not copy symlink: ${source}`);
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported source entry: ${source}`);
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source).sort()) {
    copyOwnedTree(path.join(source, entry), path.join(destination, entry));
  }
}

function assertInside(candidate: string, parent: string, label: string): void {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${parent}`);
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

function atomicWriteJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporary, filePath);
}
