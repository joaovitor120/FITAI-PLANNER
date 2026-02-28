require('dotenv').config();
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client } = require('pg');

const sqlite = new sqlite3.Database(path.join(__dirname, 'fitai.db'));
const pg = new Client({ connectionString: process.env.DATABASE_URL });

const allSqlite = (sql, params = []) => new Promise((resolve, reject) => sqlite.all(sql, params, (e, r) => e ? reject(e) : resolve(r)));

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL no .env');
  await pg.connect();

  await pg.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS profiles (id SERIAL PRIMARY KEY, user_id INT UNIQUE NOT NULL, objective TEXT, experience_level TEXT, days_per_week INT, time_per_session INT, equipment TEXT, limitations TEXT, split_preference TEXT, weight NUMERIC, height NUMERIC, age INT, sex_biological TEXT, activity_level TEXT, allergies TEXT, disliked_foods TEXT, routine_notes TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS workouts (id SERIAL PRIMARY KEY, user_id INT NOT NULL, name TEXT NOT NULL, version INT NOT NULL, split_name TEXT NOT NULL, plan_json TEXT NOT NULL, is_active INT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS checkins (id SERIAL PRIMARY KEY, user_id INT NOT NULL, workout_id INT, week_label TEXT NOT NULL, difficulty INT NOT NULL, energy INT NOT NULL, pain INT NOT NULL, completed_percent INT NOT NULL, notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id INT NOT NULL, package_code TEXT NOT NULL, monthly_price INT NOT NULL, months INT NOT NULL, status TEXT NOT NULL, starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ends_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS nutrition_plans (id SERIAL PRIMARY KEY, user_id INT NOT NULL, objective TEXT NOT NULL, weight NUMERIC NOT NULL, height NUMERIC NOT NULL, age INT NOT NULL, sex TEXT NOT NULL, activity_level TEXT NOT NULL, routine_notes TEXT, allergies TEXT, disliked_foods TEXT, calories INT NOT NULL, protein_g INT NOT NULL, carbs_g INT NOT NULL, fat_g INT NOT NULL, meal_plan_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);

  for (const table of ['users','profiles','workouts','checkins','subscriptions','nutrition_plans']) {
    const rows = await allSqlite(`SELECT * FROM ${table}`);
    for (const r of rows) {
      const cols = Object.keys(r);
      const vals = Object.values(r);
      const idx = cols.map((_, i) => `$${i + 1}`).join(',');
      await pg.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${idx}) ON CONFLICT DO NOTHING`, vals);
    }
    console.log(`Migrado ${table}: ${rows.length}`);
  }

  await pg.end();
  sqlite.close();
  console.log('Migração finalizada com sucesso.');
}

run().catch(async (e) => { console.error(e); try { await pg.end(); } catch {} sqlite.close(); process.exit(1); });
