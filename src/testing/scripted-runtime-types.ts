export type EvalDecision = 'pass' | 'fail' | 'blocked' | 'quarantine';

export type EvalVerifierStatus = 'pass' | 'fail' | 'blocked';

export type EvalJudgeStatus = 'pass' | 'fail' | 'blocked';

export type EvalJudgeProviderType = 'fixture' | 'openai_compatible';

export type EvalLane =
  | 'contract_sentinel'
  | 'trace_replay'
  | 'requirement_acceptance'
  | 'role_arena'
  | 'red_team';

export type EvalTargetModule =
  | 'runtime'
  | 'surface'
  | 'role'
  | 'skill'
  | 'tool'
  | 'provider'
  | 'state_evidence'
  | 'external';

export type EvalRiskLevel = 'low' | 'medium' | 'high' | 'release_blocking';

export type EvalFailureRoute = EvalTargetModule;

export interface EvalSuite {
  suite_id: string;
  name: string;
  version: string;
  description?: string;
  source?: string;
  cases: EvalCase[];
  decision_policy?: EvalDecisionPolicy;
}

export interface EvalDecisionPolicy {
  fail_on_any_hard_failure?: boolean;
  fail_on_required_artifact_failure?: boolean;
  block_on_missing_evidence?: boolean;
  min_pass_rate?: number;
}

export interface EvalCase {
  case_id: string;
  name: string;
  lane: EvalLane;
  target_module: EvalTargetModule;
  risk_level: EvalRiskLevel;
  task?: string;
  inputs?: EvalCaseInputs;
  replay?: EvalReplaySpec;
  hard_verifiers: EvalVerifierSpec[];
  soft_judges?: Array<string | EvalJudgeSpec>;
  budgets?: EvalBudgets;
  required_artifacts?: EvalRequiredArtifact[];
  failure_route?: EvalFailureRoute;
  quarantine?: boolean;
}

export interface EvalReplaySpec {
  mode: 'surface_runtime';
  surface?: 'cli' | 'feishu' | 'weixin' | 'pet' | 'agent' | 'research' | 'unknown';
  role_name?: string;
  use_role_tools?: boolean;
  capture_internal_trace?: boolean;
  include_surface_history?: boolean;
  settle_ms?: number;
  user_message: string;
  surface_turns?: EvalReplaySurfaceTurn[];
  timeout_ms?: number;
  env?: Record<string, string>;
  surface_event?: EvalReplaySurfaceEvent;
  model_responses: EvalReplayModelResponse[];
  subagent_model_responses?: EvalReplayModelResponse[];
  workspace_files?: EvalReplayWorkspaceFile[];
}

export interface EvalReplaySurfaceTurn {
  user_message: string;
  surface_event?: EvalReplaySurfaceEvent;
}

export interface EvalReplayWorkspaceFile {
  path: string;
  content: string;
}

export interface EvalReplaySurfaceEvent {
  event_id?: string;
  event_type?: string;
  message_ref?: string;
  room_ref?: string;
  user_ref?: string;
  adapter_config?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export interface EvalReplayModelResponse {
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    name: string;
    arguments?: Record<string, unknown> | string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export interface EvalReplayDeliveryEvidence {
  delivery_id?: string;
  surface?: string;
  channel_id?: string;
  delivery_type: 'text' | 'file';
  status: 'delivered' | 'failed' | 'blocked';
  timestamp: string;
  text_preview?: string;
  file_name?: string;
  file_path?: string;
  error_code?: string;
}

export interface EvalExternalDeliveryReceipt {
  receipt_id?: string;
  receipt_type: 'message' | 'file' | 'upload' | 'download';
  surface?: string;
  status: 'accepted' | 'available' | 'delivered' | 'failed' | 'blocked';
  timestamp: string;
  platform_message_id?: string;
  platform_file_key?: string;
  delivery_id?: string;
  file_name?: string;
  artifact_path?: string;
  evidence_refs?: string[];
  error_code?: string;
  metadata?: Record<string, unknown>;
}

export interface EvalCaseInputs {
  jsonl?: string;
  jsonl_selector?: {
    trace_id?: string;
    episode_id?: string;
    session_id?: string;
    trace_index?: number;
  };
  jsonl_schema?: 'session-log-v2';
  jsonl_contract?: 'user-trace-candidate-v0';
  jsonl_contract_reason?: string;
  artifacts_dir?: string;
}

export interface EvalVerifierSpec {
  id: string;
  config?: Record<string, unknown>;
}

export interface EvalJudgeSpec {
  id: string;
  config?: Record<string, unknown>;
  min_score?: number;
  weight?: number;
  provider?: EvalJudgeProviderSpec;
  rubric?: EvalJudgeRubricCriterion[];
  prompt?: string;
}

export interface EvalJudgeProviderSpec {
  type: EvalJudgeProviderType;
  name?: string;
  fixture_path?: string;
  base_url?: string;
  model?: string;
  api_key_env?: string;
  timeout_ms?: number;
  temperature?: number;
  modalities?: Array<'text' | 'image'>;
}

export interface EvalJudgeRubricCriterion {
  id: string;
  description: string;
  weight?: number;
}

export interface EvalRubricPack {
  $schema?: string;
  rubric_version: '0.1';
  rubric_id: string;
  name: string;
  description?: string;
  source?: string;
  applies_to?: {
    agent?: string;
    scope?: string[];
  };
  score_scale: {
    min: 0;
    max: 4;
    anchors: EvalRubricScoreAnchor[];
  };
  decision_labels: Array<{
    label: EvalDecision;
    meaning: string;
  }>;
  hard_gates: EvalRubricHardGate[];
  dimensions: EvalRubricDimension[];
  quality_formula: {
    normalization: 'weighted_average_0_to_100';
    missing_dimension_policy: 'renormalize_applicable_weights' | 'zero_missing';
    total_weight: number;
    notes?: string;
  };
  judge_mapping: EvalRubricJudgeMapping[];
  human_review_triggers: EvalRubricHumanReviewTrigger[];
}

export interface EvalRubricScoreAnchor {
  score: number;
  label: string;
  criteria: string;
}

export interface EvalRubricHardGate {
  id: string;
  name: string;
  failure_route: EvalFailureRoute;
  fail_condition: string;
  evidence: string[];
}

export interface EvalRubricDimension {
  id: string;
  name: string;
  description: string;
  weight: number;
  primary_lanes?: EvalLane[];
  target_modules?: EvalTargetModule[];
  score_anchors: EvalRubricScoreAnchor[];
}

export interface EvalRubricJudgeMapping {
  judge_id: string;
  role: 'deterministic_soft' | 'external_model' | 'human_review';
  dimensions: string[];
  notes?: string;
}

export interface EvalRubricHumanReviewTrigger {
  id: string;
  reason: string;
  priority: 'p0' | 'p1' | 'p2' | 'p3';
  conditions?: string[];
}

export interface EvalBudgets {
  max_turns?: number;
  max_tool_calls?: number;
  max_tokens?: number;
  max_latency_ms?: number;
}

export interface EvalRequiredArtifact {
  path: string;
  type?: string;
  action?: string;
  evidence?: 'manifest' | 'file' | 'manifest_or_file';
  metadata?: Record<string, unknown>;
}

export interface EvalRunOptions {
  suitePath: string;
  outDir?: string;
  now?: Date;
  caseIds?: string[];
}

export interface EvalVerifierResult {
  id: string;
  status: EvalVerifierStatus;
  hard: boolean;
  message: string;
  evidence_refs: string[];
  metrics?: Record<string, number | string | boolean>;
  failure_route?: EvalFailureRoute;
}

export interface EvalJudgeResult {
  id: string;
  status: EvalJudgeStatus;
  hard: false;
  score: number;
  max_score: number;
  min_score: number;
  message: string;
  evidence_refs: string[];
  provider?: string;
  confidence?: number;
  metrics?: Record<string, number | string | boolean>;
}

export interface EvalCaseResult {
  case_id: string;
  name: string;
  lane: EvalLane;
  target_module: EvalTargetModule;
  risk_level: EvalRiskLevel;
  decision: EvalDecision;
  verifier_results: EvalVerifierResult[];
  judge_results: EvalJudgeResult[];
  metrics: EvalCaseMetrics;
  failure_route?: EvalFailureRoute;
  notes?: string;
}

export interface EvalCaseMetrics {
  jsonl_lines: number;
  parsed_entries: number;
  parse_errors: number;
  turns: number;
  tool_calls: number;
  failed_tool_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface EvalScorecard {
  scorecard_version: '0.1';
  run_id: string;
  suite_id: string;
  suite_name: string;
  generated_at: string;
  candidate: {
    git_sha: string;
    branch: string;
    entrypoint: string;
  };
  summary: {
    decision: EvalDecision;
    cases_total: number;
    cases_passed: number;
    cases_failed: number;
    cases_blocked: number;
    cases_quarantined: number;
    hard_failures: number;
    judge_failures: number;
    judge_blocks: number;
    required_artifact_failures: number;
    pass_rate: number;
  };
  scores: {
    quality: number;
    reliability: number;
    safety: number;
    efficiency: number;
  };
  failure_routes: Record<EvalFailureRoute, number>;
  cases: EvalCaseResult[];
  evidence: {
    suite_path: string;
    out_dir: string;
    scorecard_path?: string;
    report_path?: string;
    manifest_path?: string;
  };
}
