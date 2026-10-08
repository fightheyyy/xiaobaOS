import Ajv from 'ajv';
import { Connector } from './connector';

export type AppId = 'gmail' | 'notion' | 'github';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface AppRequest { operation: string; args: Record<string, unknown> }
export interface AppCallOptions { abortSignal?: AbortSignal; timeoutMs?: number; actionId?: string }
export interface AppResult { data: Json; nextPage?: string }
export interface AppOperation {
  name: string; description: string; effect: 'read' | 'write'; schema: Record<string, unknown>;
}
export interface AppConnector extends Connector<AppRequest, AppResult, AppCallOptions> {
  readonly app: AppId;
  readonly operations: readonly AppOperation[];
  configured(): boolean;
}
export type ConnectorErrorCode = 'CONNECTOR_AUTH_REQUIRED' | 'CONNECTOR_PERMISSION_DENIED' | 'CONNECTOR_RATE_LIMITED'
  | 'CONNECTOR_NOT_FOUND' | 'CONNECTOR_DISABLED' | 'CONNECTOR_VALIDATION_ERROR' | 'CONNECTOR_API_ERROR'
  | 'CONNECTOR_ACTION_CONFLICT' | 'CONNECTOR_ACTION_REVIEW_REQUIRED'
  | 'CONNECTOR_NETWORK_ERROR' | 'CONNECTOR_TIMEOUT' | 'CONNECTOR_ABORTED' | 'CONNECTOR_RESPONSE_TOO_LARGE' | 'CONNECTOR_CONFIG_INVALID';
export class ConnectorError extends Error {
  constructor(readonly code: ConnectorErrorCode, message: string, readonly retryable = false, readonly httpStatus?: number) {
    super(message); this.name = 'ConnectorError';
  }
}
export const APPS: readonly AppId[] = ['gmail','notion','github'];
export function appId(value: unknown): AppId {
  if (!APPS.includes(value as AppId)) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Unsupported app.');
  return value as AppId;
}
const ajv = new Ajv({ allErrors: false, strict: false });
const validators = new WeakMap<AppOperation, ReturnType<Ajv['compile']>>();
export function validateRequest(operations: readonly AppOperation[], request: AppRequest): AppOperation {
  const operation = operations.find(item => item.name === request?.operation);
  if (!operation) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', 'Unsupported operation.');
  let validate = validators.get(operation);
  if (!validate) { validate = ajv.compile(operation.schema); validators.set(operation, validate); }
  if (!validate(request.args)) throw new ConnectorError('CONNECTOR_VALIDATION_ERROR', `Invalid ${operation.name} arguments (${validate.errors?.[0]?.keyword || 'schema'}).`);
  return operation;
}
export const string = (maxLength = 1000): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength });
export const identifier = { ...string(200), pattern: '^[A-Za-z0-9_-]+$' };
export const uuid = { ...string(36), pattern: '^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$' };
export const limit = { type: 'integer', minimum: 1, maximum: 100 };
export const text = (maxLength = 16000): Record<string, unknown> => ({ type: 'string', maxLength });
export function operation(name: string, description: string, effect: 'read' | 'write', properties: Record<string, unknown> = {}, required: string[] = []): AppOperation {
  return { name, description, effect, schema: { type: 'object', properties, required, additionalProperties: false } };
}
export function segment(value: unknown): string { return encodeURIComponent(String(value)); }
