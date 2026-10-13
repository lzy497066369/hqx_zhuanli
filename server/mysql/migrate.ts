import { MysqlDatabase, readStorageConfig } from './database.ts';

const config = readStorageConfig(process.env);
const database = new MysqlDatabase(config);
try {
  await database.ready();
  console.log('MySQL 连接成功，数据库表已初始化。');
} catch {
  console.error('MySQL 初始化失败，请检查 MYSQL_* 配置和数据库服务。');
  process.exitCode = 1;
} finally { await database.close(); }
