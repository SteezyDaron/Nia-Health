// scripts/initDb.js
// Run with: node scripts/initDb.js
// Sets up the database schema automatically

'use strict';
require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function init() {
  console.log('\n🌿 niA Health — Database Setup\n');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    await pool.query('SELECT 1');
    console.log('✅ Database connection successful');
  } catch (e) {
    console.error('❌ Cannot connect to database:', e.message);
    console.error('\nCheck DATABASE_URL in your .env file');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');

  try {
    await pool.query(schema);
    console.log('✅ Schema applied successfully');
  } catch (e) {
    if (e.message.includes('already exists')) {
      console.log('ℹ️  Tables already exist — skipping');
    } else {
      console.error('❌ Schema error:', e.message);
      process.exit(1);
    }
  }

  // Verify tables
  const { rows } = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  console.log('\n📋 Tables in database:');
  rows.forEach(r => console.log('   •', r.table_name));

  console.log('\n✅ Database ready! Run `npm start` to launch niA Health.\n');
  await pool.end();
}

init();
