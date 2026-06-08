// The conduit authorization kernel — public surface.
//
// Usage:
//   import { Conduit } from './kernel/index.ts';
//   const conduit = new Conduit({ rules: [...] });
//   const decision = conduit.authorize({ agentId, action, input });

export {
  Conduit,
  type ConduitConfig,
  type RunResult,
  type SelfServePolicy,
  type CapabilityRequest,
  type CapabilityRequestResult,
} from './conduit.ts';
export {
  AgentRegistry,
  agentRegistrationSchema,
  type AgentRegistration,
  type RegisteredAgent,
  type RegistrationResult,
} from './registry.ts';
export { PermissionEngine, type RuleMatch } from './permissions.ts';
export {
  CapabilityStore,
  capabilitySpecSchema,
  type Capability,
  type CapabilitySpec,
  type CapabilityCheck,
} from './capability.ts';
export {
  AuditLog,
  type AuditEvent,
  type AuditEventType,
  type ChainVerification,
} from './audit.ts';
export { governTool, type GovernOptions } from './wrap.ts';
export {
  ApprovalQueue,
  ConsoleNotifier,
  WebhookNotifier,
  type ApprovalRequest,
  type ApprovalStatus,
  type Notifier,
} from './approval.ts';
export {
  SqlitePersistence,
  type ConduitPersistence,
} from './persistence.ts';
export { PostgresPersistence } from './postgres.ts';
export {
  buildComplianceReport,
  formatComplianceReport,
  type ComplianceReport,
} from './export.ts';
export { matchAction, specificity } from './match.ts';
export type {
  AuthorizationRequest,
  AuthorizationDecision,
  PermissionBehavior,
  PermissionRule,
  Tool,
  ToolContext,
  ToolResult,
} from './types.ts';
