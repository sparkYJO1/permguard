/**
 * Identity owns who exists and who belongs to what. It does not know what a
 * permission is, and nothing here imports from `@permguard/authorization` —
 * the dependency runs the other way, and only through events.
 */
export interface User {
  readonly id: string;
  readonly displayName: string;
}

export interface Team {
  readonly id: string;
  readonly displayName: string;
  /** The team this one sits inside. Members are inherited upward. */
  readonly parentId: string | null;
}

export interface Membership {
  readonly userId: string;
  readonly teamId: string;
}

export interface IdentityRepository {
  addUser(user: User): Promise<void>;
  addTeam(team: Team): Promise<void>;
  addMembership(m: Membership): Promise<void>;
  users(): Promise<readonly User[]>;
  teams(): Promise<readonly Team[]>;
  memberships(): Promise<readonly Membership[]>;
}
