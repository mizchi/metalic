import type { TokenKind, NodeKind, ErrorCode, TypeKind } from './schema.ts';
export { TokenKind, NodeKind, ErrorCode, TypeKind } from './schema.ts';

/** All offsets are UTF-8 byte offsets; node spans identify the defining token. */
export interface Token { kind: TokenKind; begin: number; end: number }
export interface AstNode {
  kind: NodeKind; begin: number; end: number; value: number;
  left: number | null; right: number | null;
}
export interface ModuleNode extends AstNode { functionId: number; binding: number | null; type: TypeKind }
export interface Diagnostic { code: ErrorCode; offset: number }
export type DiagnosticStrategy = 'tree' | 'hierarchical' | 'packed';
export type BufferStrategy = 'fresh' | 'reuse' | 'selective';
export interface GpuOptions {
  diagnostics?: DiagnosticStrategy; buffers?: BufferStrategy; poisonBuffers?: boolean;
  /** Independent inputs in flight, including CPU consumption. Default 1; range 1..8. */
  maxInFlight?: number;
}
export interface FlightTrace {
  sequence: number; slot: number;
  /** GPU host-clock timestamps, null when unavailable. Completion is the notification time. */
  gpuStartedUs: number | null; gpuEndedUs: number | null;
  prepareBeginUs: number; submittedUs: number; gpuCompletedUs: number;
  consumeBeginUs: number; consumeEndUs: number; completionWaitUs: number;
}
export interface BatchMetrics {
  maxInFlight: number; peakLeasedSlots: number; jobs: number;
  /** Native scheduling through CPU consumption; excludes setup and JSON/IPC. */
  wallUs: number;
  /** All retained source/arena buffers, including inactive pool slots; not RSS. */
  peakBufferBytes: number;
}
export interface TimingBreakdown {
  prepareUs: number; acquireUs: number; initializeUs: number;
  encodeUs: number; submitWaitUs: number; materializeUs: number;
}
export const passes = ['Lex', 'Tokenize', 'Structure', 'NormalizeOperators', 'BuildAst', 'ValidateAst'] as const;
export const modulePasses = [...passes, 'ResolveNames', 'CheckTypes'] as const;
export interface Parameter { binding: number; begin: number; end: number; type: TypeKind }
export interface FunctionDecl {
  begin: number; end: number; parameters: Parameter[]; returnType: TypeKind; body: number;
}
export interface ParseResult {
  tokens: Token[]; nodes: AstNode[]; root: number | null;
  diagnostic: Diagnostic | null;
}
export interface GpuMetrics {
  backend: 'metal'; device: string; passes: readonly string[];
  dispatches: number; hostWaits: number; elapsedUs: number; gpuUs: number;
  chunkSize: number; setupUs: number; arenaBytes: number;
  samplesUs: number[]; gpuSamplesUs: number[];
  diagnostics: DiagnosticStrategy; diagnosticDispatches: number; mslVersion: string;
  buffers: BufferStrategy; bufferAllocations: number; initializedBytes: number; poisonedBytes: number;
  sourceCapacityBytes: number; arenaCapacityBytes: number;
  timingsUs: TimingBreakdown; timingSamplesUs: TimingBreakdown[]; allocationSamples: number[];
  flightSamples: FlightTrace[]; batch: BatchMetrics;
}
export interface GpuResult extends ParseResult, GpuMetrics {}
/** Counts of accepted IR only; failed inputs publish zero nodes/functions. */
export interface GpuSummary extends GpuMetrics {
  output: 'summary'; valid: boolean; diagnostic: Diagnostic | null;
  tokenCount: number; nodeCount: number; functionCount: number;
}
export interface ModuleResult extends ParseResult { nodes: ModuleNode[]; functions: FunctionDecl[] }
export interface GpuModuleResult extends GpuResult { nodes: ModuleNode[]; functions: FunctionDecl[] }

export type WorkloadAlgorithm = 'merkle-sha256' | 'histogram256' | 'compact-u32' | 'tea32' | 'pointer-chase';
export type WorkloadMode = 'cpu-serial' | 'cpu-parallel' | 'gpu-resident' | 'gpu-upload';
export interface WorkloadSpec {
  algorithm: WorkloadAlgorithm; count: number; seed?: number;
  distribution?: 'uniform' | 'hot'; mask?: number;
}
export interface WorkloadOptions {
  warmups?: number; samples?: number; modes?: WorkloadMode[];
  poisonBuffers?: boolean; includeOutput?: boolean;
}
export interface WorkloadSample {
  elapsedUs: number; prepareUs: number; encodeUs: number; waitUs: number;
  computeUs: number; gpuUs: number; consumeUs: number;
}
export interface WorkloadRecord extends WorkloadSpec {
  mode: WorkloadMode; inputBytes: number; inputHash: string;
  resultCount: number; checksum: number; digestHex?: string; output?: number[];
  /** cpuTasks counts GCD chunks, not physical cores or simultaneous threads. */
  verified: boolean; hostWaits: number; dispatches: number; cpuTasks: number;
  arenaBytes: number; bufferBytes: number; acquireUs: number;
  samples: WorkloadSample[];
}
export interface WorkloadExperiment {
  device: string; mslVersion: string; cpuThreads: number; setupUs: number;
  records: WorkloadRecord[];
}

export interface AdaptivePolicyConfig {
  minSamples: number; window: number; recheckEvery: number; switchMargin: number;
}
export interface AdaptiveObservation { us: number; contended: boolean; at: number }
export interface AdaptiveModeProfile { samples: AdaptiveObservation[]; lastUsed: number }
export interface AdaptiveEntry {
  modes: Partial<Record<WorkloadMode,AdaptiveModeProfile>>;
  incumbent: WorkloadMode; decisions: number;
}
export type AdaptiveProfiles = Record<string,AdaptiveEntry>;
export type AdaptiveReason = 'calibrating' | 'explore' | 'fastest' | 'hysteresis' | 'queue' | 'forced';
export interface AdaptiveDecision {
  mode: WorkloadMode; preferred: WorkloadMode; reason: AdaptiveReason;
  estimatedServiceUs: number; estimatedFinishUs: number;
}
export interface AdaptiveOptions extends Partial<AdaptivePolicyConfig> {
  profilePath?: string; profileTtlMs?: number;
  maxPending?: number; maxPrepared?: number; maxPreparedBytes?: number;
  poisonBuffers?: boolean;
}
export interface WorkloadHandle {
  readonly id: string; readonly spec: Readonly<WorkloadSpec>;
  readonly profileKey: string; readonly inputHash: string;
  readonly inputPlacement: 'cpu' | 'resident';
  readonly reservedBytes: number; readonly prepareUs: number;
}
export interface AdaptiveResult {
  mode: WorkloadMode; decision: AdaptiveDecision;
  verified: boolean; checksum: number; resultCount: number; digestHex?: string;
  serviceUs: number; queueUs: number; totalUs: number; nativeServiceUs: number;
  contended: boolean; workerPid: number; timings: WorkloadSample;
}

export interface FitSample { mode: WorkloadMode; serviceUs: number; apiUs: number; reason?: AdaptiveReason }
export interface FitOptions { relativeTolerance: number; absoluteToleranceUs: number; minControlSamples: number }
export interface FitAssessment {
  family: 'cpu' | 'gpu' | 'ambiguous'; referenceMode: WorkloadMode;
  competitive: WorkloadMode[];
  controls: Partial<Record<WorkloadMode,{count:number;p25Us:number;p50Us:number;p75Us:number;apiP50Us:number}>>;
  count: number; steadyCount: number; fitRate: number; steadyFitRate: number;
  estimatedRegret: number; apiSlowdown: number; autoApiP50Us: number;
}
