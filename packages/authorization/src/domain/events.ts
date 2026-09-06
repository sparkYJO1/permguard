import type { DomainEvent } from '@permguard/shared-kernel';
import type { Role } from './roles';

export interface GrantAddedPayload {
  readonly grantId: string;
  readonly subjectKind: 'user' | 'team';
  readonly subjectId: string;
  readonly role: Role;
  readonly resourceId: string;
}

export interface GrantRevokedPayload {
  readonly grantId: string;
  readonly subjectKind: 'user' | 'team';
  readonly subjectId: string;
  readonly role: Role;
  readonly resourceId: string;
}

export type GrantAdded = DomainEvent<'GrantAdded', GrantAddedPayload>;
export type GrantRevoked = DomainEvent<'GrantRevoked', GrantRevokedPayload>;
export type AuthorizationEvent = GrantAdded | GrantRevoked;
