const query = require('./db');

const DEFAULT_PRESERVED_TABLES = ['app_config', 'user_account'];
const CONFIG_ONLY_PRESERVED_TABLES = ['app_config'];

async function main() {
  const force = process.argv.includes('--force');
  const deleteUsers = process.argv.includes('--delete-users');
  const preservedTables = deleteUsers
    ? CONFIG_ONLY_PRESERVED_TABLES
    : DEFAULT_PRESERVED_TABLES;

  if (!force) {
    console.error('Refusing to clear transactional data without --force.');
    console.error('Run: node db/clear-transactional-data.js --force');
    process.exit(1);
  }

  console.info(
    `Clearing database tables while preserving ${preservedTables.join(', ')}`
  );

  const transactionalTables = await getTransactionalTables(preservedTables);
  if (transactionalTables.length === 0) {
    console.info('No transactional tables found to clear.');
    return;
  }

  await truncateTables(transactionalTables);

  console.info('Transactional data cleared successfully.');
  console.info(`Preserved tables: ${preservedTables.join(', ')}`);
  console.info(`Cleared tables: ${transactionalTables.join(', ')}`);
}

async function getTransactionalTables(preservedTables) {
  const result = await query(
    `SELECT tablename
     FROM pg_tables
     WHERE schemaname = 'public'
       AND NOT (tablename = ANY($1::text[]))
     ORDER BY tablename ASC`,
    [preservedTables]
  );

  return result.rows.map((row) => row.tablename);
}

async function truncateTables(tableNames) {
  const truncateStatement = `
    TRUNCATE TABLE ${tableNames.map(quoteIdentifier).join(', ')}
    RESTART IDENTITY CASCADE
  `;

  await query(truncateStatement);
}

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

main().catch((error) => {
  console.error('Failed to clear transactional data.', error);
  process.exit(1);
});
