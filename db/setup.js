const query = require('./db');
const fs = require('fs');
const util = require('util');
const keys = require('../config/keys');

const connectionString = keys.postgres.connectionString;

const readFileAsync = util.promisify(fs.readFile);

async function main() {
  console.info(`Setting up database on ${connectionString}`);

    // Drop all existing tables in the database
    const dropTablesSQL = `
       DO $$ 
        DECLARE
            r RECORD;
        BEGIN
            FOR r IN (SELECT tablename 
                      FROM pg_tables 
                      WHERE schemaname = 'public')
            LOOP
                EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE;';
            END LOOP;
        END $$;
   `;
   
   // Execute the drop tables SQL
   await query(dropTablesSQL);
   console.info('All existing tables deleted');

  // Create tables
  try {
    const createTable = await readFileAsync('./db/schema.sql');
    await query(createTable.toString('utf8'));
    console.info('SQL tables created');
  } catch (e) {
    console.error('Error creating SQL tables:', e.message);
    return;
  }
  
  // Add default data
  try {
    const insert = await readFileAsync('./db/insert.sql');
    await query(insert.toString('utf8'));
    console.info('Data successfully added');
  } catch (e) {
    console.error('Error adding data to SQL tables:', e.message);
  }
}

main().catch((err) => {
    console.error(err);
  });