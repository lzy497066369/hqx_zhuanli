import { readFile } from 'node:fs/promises';
import { createPool } from 'mysql2/promise';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../passwords.ts';

export type StorageConfig = {
  driver: 'mysql' | 'indexeddb';
  host: string; port: number; user: string; password: string; database: string; workspace: string;
};

export function readStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const driver = env.STORAGE_DRIVER || 'mysql';
  if (driver !== 'mysql' && driver !== 'indexeddb') throw new Error('STORAGE_DRIVER must be mysql or indexeddb');
  const config: StorageConfig = {
    driver, host: env.MYSQL_HOST || '127.0.0.1', port: Number(env.MYSQL_PORT || 3307),
    user: env.MYSQL_USER || 'zhichuang', password: env.MYSQL_PASSWORD || '',
    database: env.MYSQL_DATABASE || 'zhichuang', workspace: env.MYSQL_WORKSPACE_ID || 'default',
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.workspace)) {
    throw new Error('Invalid MySQL port or workspace ID');
  }
  return config;
}

export class MysqlDatabase {
  readonly pool: Pool;
  readonly workspace: string;
  private initialization?: Promise<void>;

  constructor(config: StorageConfig) {
    this.workspace = config.workspace;
    this.pool = createPool({
      host: config.host, port: config.port, user: config.user, password: config.password, database: config.database,
      charset: 'utf8mb4', timezone: 'Z', connectionLimit: 5, connectTimeout: 5000,
      // Let bursts wait for a connection instead of rejecting users before they reach the generation queue.
      waitForConnections: true, queueLimit: 0, enableKeepAlive: true,
    });
  }

  async ready(): Promise<void> {
    this.initialization ??= this.migrate().catch(error => { this.initialization = undefined; throw error; });
    return this.initialization;
  }

  private async migrate(): Promise<void> {
    const connection = await this.pool.getConnection();
    let locked = false;
    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 15) AS acquired', ['zhichuang-schema-v1']);
      if (Number(rows[0].acquired) !== 1) throw new Error('Schema migration lock unavailable');
      locked = true;
      const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
      // No multi-statements on application connections. Schema contains only fixed DDL.
      for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT IGNORE INTO schema_migrations (version, name) VALUES (1, ?)', ['initial-mysql-storage']);
      const authSql = await readFile(new URL('./auth.sql', import.meta.url), 'utf8');
      for (const statement of authSql.split(';').map(part => part.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT IGNORE INTO schema_migrations (version, name) VALUES (2, ?)', ['users-and-sessions']);
      const [migrations] = await connection.execute<RowDataPacket[]>('SELECT version FROM schema_migrations WHERE version = 3');
      if (!migrations.length) {
        const workspaceSql = await readFile(new URL('./workspaces.sql', import.meta.url), 'utf8');
        const [columns] = await connection.query<RowDataPacket[]>('SHOW COLUMNS FROM workspaces');
        const [indexes] = await connection.query<RowDataPacket[]>('SHOW INDEX FROM workspaces');
        const [foreignKeys] = await connection.query<RowDataPacket[]>("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workspaces' AND CONSTRAINT_TYPE = 'FOREIGN KEY'");
        for (const statement of workspaceSql.split(';').map(part => part.trim()).filter(Boolean)) {
          const column = statement.match(/ADD COLUMN (\w+)/)?.[1];
          const index = statement.match(/ADD INDEX (\w+)/)?.[1];
          const constraint = statement.match(/ADD CONSTRAINT (\w+)/)?.[1];
          if (column && columns.some(row => row.Field === column)) continue;
          if (index && indexes.some(row => row.Key_name === index)) continue;
          if (constraint && foreignKeys.some(row => row.CONSTRAINT_NAME === constraint)) continue;
          await connection.query(statement);
        }
        await connection.execute('INSERT INTO schema_migrations (version, name) VALUES (3, ?)', ['private-user-workspaces']);
      }
      await connection.execute('INSERT IGNORE INTO workspaces (id) VALUES (?)', [this.workspace]);
      const adminSql = await readFile(new URL('./admin.sql', import.meta.url), 'utf8');
      for (const statement of adminSql.split(';').map(part => part.trim()).filter(Boolean)) await connection.query(statement);
      const [adminMigrations] = await connection.execute<RowDataPacket[]>('SELECT version FROM schema_migrations WHERE version = 4');
      if (!adminMigrations.length) {
        const [userColumns] = await connection.query<RowDataPacket[]>('SHOW COLUMNS FROM users');
        if (!userColumns.some(row => row.Field === 'disabled_at')) await connection.query('ALTER TABLE users ADD COLUMN disabled_at TIMESTAMP(3) NULL');
        await connection.beginTransaction();
        try {
          // Seed once under the migration lock; later starts never reset a changed password.
          const hash = await hashPassword('admin123');
          await connection.execute("INSERT INTO users (id,username,display_name,password_hash,role) VALUES (?,'admin','管理员',?,'admin') ON DUPLICATE KEY UPDATE role = 'admin', password_hash = ?, disabled_at = NULL", [randomUUID(), hash, hash]);
          await connection.execute("DELETE s FROM user_sessions s JOIN users u ON u.id = s.user_id WHERE u.username = 'admin'");
          await connection.execute('INSERT INTO schema_migrations (version, name) VALUES (4, ?)', ['administrator-and-ai-request-audit']);
          await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
      }
    } finally {
      if (locked) await connection.query('SELECT RELEASE_LOCK(?)', ['zhichuang-schema-v1']).catch(() => undefined);
      connection.release();
    }
  }

  async transaction<T>(task: (connection: PoolConnection) => Promise<T>): Promise<T> {
    await this.ready();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await task(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally { connection.release(); }
  }

  close(): Promise<void> { return this.pool.end(); }
}
