-- Applied by the version 3 migrator. Legacy unowned rows remain quarantined.
ALTER TABLE workspaces ADD COLUMN owner_user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL;
ALTER TABLE workspaces ADD COLUMN name VARCHAR(80) NOT NULL DEFAULT '历史工作空间';
ALTER TABLE workspaces ADD COLUMN description VARCHAR(500) NOT NULL DEFAULT '';
ALTER TABLE workspaces ADD INDEX idx_workspaces_owner (owner_user_id, created_at);
ALTER TABLE workspaces ADD CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE;
