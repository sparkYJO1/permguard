import type { Pool } from 'pg';
import type { IdentityRepository, Membership, Team, User } from '../domain/model';

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}

  async addUser(user: User): Promise<void> {
    await this.pool.query(
      'INSERT INTO users (id, display_name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [user.id, user.displayName],
    );
  }

  async addTeam(team: Team): Promise<void> {
    await this.pool.query(
      'INSERT INTO teams (id, display_name, parent_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [team.id, team.displayName, team.parentId],
    );
  }

  async addMembership(m: Membership): Promise<void> {
    await this.pool.query(
      'INSERT INTO memberships (user_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [m.userId, m.teamId],
    );
  }

  async users(): Promise<readonly User[]> {
    const { rows } = await this.pool.query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM users ORDER BY id',
    );
    return rows.map((r) => ({ id: r.id, displayName: r.display_name }));
  }

  async teams(): Promise<readonly Team[]> {
    const { rows } = await this.pool.query<{
      id: string;
      display_name: string;
      parent_id: string | null;
    }>('SELECT id, display_name, parent_id FROM teams ORDER BY id');
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, parentId: r.parent_id }));
  }

  async memberships(): Promise<readonly Membership[]> {
    const { rows } = await this.pool.query<{ user_id: string; team_id: string }>(
      'SELECT user_id, team_id FROM memberships ORDER BY user_id, team_id',
    );
    return rows.map((r) => ({ userId: r.user_id, teamId: r.team_id }));
  }
}
