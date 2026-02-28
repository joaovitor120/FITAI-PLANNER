const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
const fs = require('fs');
require('dotenv').config();
const { hasGeminiKey, geminiText, geminiJson } = require('./ai-core');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change';
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || '';
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const db = USE_POSTGRES ? null : new sqlite3.Database(path.join(__dirname, 'fitai.db'));
const pgPool = USE_POSTGRES ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const exerciseVideoMapRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'lista_exercicios.json'), 'utf-8'));
const exerciseVideoMap = Object.entries(exerciseVideoMapRaw || {}).flatMap(([group, exercises]) => Object.entries(exercises || {}).map(([name, url]) => ({ group, name, url })));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const metrics = { requests: 0, byRoute: {}, byStatus: {} };
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    metrics.requests += 1;
    const routeKey = `${req.method} ${req.path}`;
    metrics.byRoute[routeKey] = (metrics.byRoute[routeKey] || 0) + 1;
    metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] || 0) + 1;
    console.log(JSON.stringify({ ts: new Date().toISOString(), route: routeKey, status: res.statusCode, ms }));
  });
  next();
});

function sqlForPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

const run = async (sql, params = []) => {
  if (USE_POSTGRES) {
    const q = sqlForPg(sql);
    const result = await pgPool.query(q, params);
    return { lastID: result.rows?.[0]?.id || null, changes: result.rowCount };
  }
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) return reject(err); resolve(this); }));
};

const get = async (sql, params = []) => {
  if (USE_POSTGRES) {
    const q = sqlForPg(sql);
    const r = await pgPool.query(q, params);
    return r.rows[0] || null;
  }
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
};

const all = async (sql, params = []) => {
  if (USE_POSTGRES) {
    const q = sqlForPg(sql);
    const r = await pgPool.query(q, params);
    return r.rows;
  }
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
};

async function ensureColumn(table, column, definition) {
  if (USE_POSTGRES) {
    const cols = await all(`SELECT column_name FROM information_schema.columns WHERE table_name = ?`, [table]);
    if (!cols.some(c => c.column_name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return;
  }
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function initDb() {
  if (USE_POSTGRES) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS profiles (id SERIAL PRIMARY KEY, user_id INT UNIQUE NOT NULL, objective TEXT, experience_level TEXT, days_per_week INT, time_per_session INT, equipment TEXT, limitations TEXT, split_preference TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS workouts (id SERIAL PRIMARY KEY, user_id INT NOT NULL, name TEXT NOT NULL DEFAULT 'Meu Treino', version INT NOT NULL DEFAULT 1, split_name TEXT NOT NULL, plan_json TEXT NOT NULL, is_active INT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS checkins (id SERIAL PRIMARY KEY, user_id INT NOT NULL, workout_id INT, week_label TEXT NOT NULL, difficulty INT NOT NULL, energy INT NOT NULL, pain INT NOT NULL, completed_percent INT NOT NULL, notes TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS subscriptions (id SERIAL PRIMARY KEY, user_id INT NOT NULL, package_code TEXT NOT NULL, monthly_price INT NOT NULL, months INT NOT NULL, status TEXT NOT NULL, starts_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, ends_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS nutrition_plans (id SERIAL PRIMARY KEY, user_id INT NOT NULL, objective TEXT NOT NULL, weight NUMERIC NOT NULL, height NUMERIC NOT NULL, age INT NOT NULL, sex TEXT NOT NULL, activity_level TEXT NOT NULL, routine_notes TEXT, allergies TEXT, disliked_foods TEXT, calories INT NOT NULL, protein_g INT NOT NULL, carbs_g INT NOT NULL, fat_g INT NOT NULL, meal_plan_json TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    `);
  } else {
    await run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await run(`CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      objective TEXT NOT NULL,
      experience_level TEXT NOT NULL,
      days_per_week INTEGER NOT NULL,
      time_per_session INTEGER NOT NULL,
      equipment TEXT NOT NULL,
      limitations TEXT,
      split_preference TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL DEFAULT 'Meu Treino',
      version INTEGER NOT NULL DEFAULT 1,
      split_name TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      workout_id INTEGER,
      week_label TEXT NOT NULL,
      difficulty INTEGER NOT NULL,
      energy INTEGER NOT NULL,
      pain INTEGER NOT NULL,
      completed_percent INTEGER NOT NULL,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      package_code TEXT NOT NULL,
      monthly_price INTEGER NOT NULL,
      months INTEGER NOT NULL,
      status TEXT NOT NULL,
      starts_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ends_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    await run(`CREATE TABLE IF NOT EXISTS nutrition_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      objective TEXT NOT NULL,
      weight REAL NOT NULL,
      height REAL NOT NULL,
      age INTEGER NOT NULL,
      sex TEXT NOT NULL,
      activity_level TEXT NOT NULL,
      routine_notes TEXT,
      allergies TEXT,
      disliked_foods TEXT,
      calories INTEGER NOT NULL,
      protein_g INTEGER NOT NULL,
      carbs_g INTEGER NOT NULL,
      fat_g INTEGER NOT NULL,
      meal_plan_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
  }

  await ensureColumn('profiles', 'split_preference', 'TEXT');
  await ensureColumn('profiles', 'weight', USE_POSTGRES ? 'NUMERIC' : 'REAL');
  await ensureColumn('profiles', 'height', USE_POSTGRES ? 'NUMERIC' : 'REAL');
  await ensureColumn('profiles', 'age', 'INTEGER');
  await ensureColumn('profiles', 'sex_biological', 'TEXT');
  await ensureColumn('profiles', 'activity_level', 'TEXT');
  await ensureColumn('profiles', 'allergies', 'TEXT');
  await ensureColumn('profiles', 'disliked_foods', 'TEXT');
  await ensureColumn('profiles', 'routine_notes', 'TEXT');
  await ensureColumn('workouts', 'name', "TEXT NOT NULL DEFAULT 'Meu Treino'");
  await ensureColumn('workouts', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('workouts', 'updated_at', USE_POSTGRES ? 'TIMESTAMP' : 'DATETIME');
  await ensureColumn('checkins', 'workout_id', 'INTEGER');
}

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function pickSplit(days, splitPreference) {
  if (splitPreference && splitPreference !== 'auto') return splitPreference;
  return days <= 3 ? 'full_body' : days === 4 ? 'upper_lower' : 'ppl';
}

function normalizeText(v = '') {
  return String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function findExerciseVideoUrl(exerciseName = '') {
  const n = normalizeText(exerciseName);
  const exact = exerciseVideoMap.find(e => normalizeText(e.name) === n);
  if (exact) return exact.url;
  const partial = exerciseVideoMap.find(e => n.includes(normalizeText(e.name)) || normalizeText(e.name).includes(n));
  return partial?.url || null;
}

const FOOD_KCAL_PER_G = [
  { key: 'arroz', kcal: 1.30 },
  { key: 'feijao', kcal: 0.76 },
  { key: 'frango', kcal: 1.65 },
  { key: 'banana', kcal: 0.89 },
  { key: 'aveia', kcal: 3.89 },
  { key: 'iogurte', kcal: 0.61 },
  { key: 'granola', kcal: 4.71 },
  { key: 'pao', kcal: 2.65 },
  { key: 'queijo', kcal: 2.64 },
  { key: 'batata doce', kcal: 0.86 },
  { key: 'macarrao', kcal: 1.58 },
  { key: 'atum', kcal: 1.16 },
  { key: 'castanhas', kcal: 6.00 },
  { key: 'leite', kcal: 0.62 },
  { key: 'mandioca', kcal: 1.25 },
  { key: 'peixe', kcal: 1.28 },
  { key: 'omelete', kcal: 1.80 },
  { key: 'ovos', kcal: 1.55 },
  { key: 'azeite', kcal: 8.84 },
  { key: 'salada', kcal: 0.20 },
  { key: 'legumes', kcal: 0.35 },
  { key: 'sopa', kcal: 0.45 }
];

function estimateItemCalories(itemText = '') {
  const n = normalizeText(itemText);
  const gMatch = n.match(/(\d+)\s*g/);
  const grams = gMatch ? Number(gMatch[1]) : null;
  const food = FOOD_KCAL_PER_G.find(f => n.includes(f.key));
  if (food && grams) return Math.round(food.kcal * grams);

  const mlMatch = n.match(/(\d+)\s*ml/);
  if (food && mlMatch) return Math.round(food.kcal * Number(mlMatch[1]));

  return null;
}

function splitMealItems(text = '') {
  return String(text).split('+').map(s => s.trim()).filter(Boolean).map(item => ({
    label: item,
    calories: estimateItemCalories(item)
  }));
}

function applyLimitationsToExercises(exercises, limitationsText = '') {
  const lim = normalizeText(limitationsText);
  if (!lim) return exercises;

  const blocked = [];
  if (lim.includes('joelho')) blocked.push(/agach|lunge|afundo|leg press|extensora/i);
  if (lim.includes('ombro')) blocked.push(/desenvolvimento|elevacao lateral|paralela|supino inclinado/i);
  if (lim.includes('lombar') || lim.includes('coluna')) blocked.push(/terra|stiff|remada curvada/i);
  if (lim.includes('punho')) blocked.push(/flexao|paralela|rosca direta/i);

  return exercises.filter(name => !blocked.some(rx => rx.test(name)));
}

const EXERCISE_LIBRARY = {
  'agachamento': { id: 'ex_squat', label: 'Agachamento' },
  'supino reto': { id: 'ex_bench_press', label: 'Supino reto' },
  'remada baixa': { id: 'ex_seated_row', label: 'Remada baixa' },
  'desenvolvimento militar': { id: 'ex_ohp', label: 'Desenvolvimento militar' },
  'puxada frente': { id: 'ex_lat_pulldown', label: 'Puxada frente' },
  'stiff': { id: 'ex_rdl', label: 'Stiff' },
  'leg press': { id: 'ex_leg_press', label: 'Leg press' },
  'flexão': { id: 'ex_pushup', label: 'Flexão' },
  'elevação pélvica': { id: 'ex_hip_thrust', label: 'Elevação pélvica' }
};

function getExerciseMeta(name = '') {
  const n = normalizeText(name);
  const k = Object.keys(EXERCISE_LIBRARY).find(x => n.includes(normalizeText(x)));
  return k ? EXERCISE_LIBRARY[k] : { id: `ex_${n.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'generic'}`, label: name };
}

function getNutritionTargets({ weight, height, age, sex, activityLevel, objective }) {
  const s = sex === 'feminino' ? -161 : 5;
  const bmr = 10 * weight + 6.25 * height - 5 * age + s;
  const mult = activityLevel === 'sedentario' ? 1.2 : activityLevel === 'leve' ? 1.375 : activityLevel === 'moderado' ? 1.55 : activityLevel === 'alto' ? 1.725 : 1.9;
  let calories = Math.round(bmr * mult);
  if (objective === 'perder') calories -= 350;
  if (objective === 'ganhar') calories += 250;

  const protein = Math.round((objective === 'ganhar' ? 2.0 : 1.8) * weight);
  const fat = Math.round(0.8 * weight);
  const carbs = Math.max(100, Math.round((calories - (protein * 4 + fat * 9)) / 4));

  return { calories, protein, carbs, fat };
}

function generateWorkout(profile, checkin) {
  const days = Number(profile.days_per_week);
  const goal = profile.objective;
  const level = profile.experience_level;
  const equipment = normalizeText(profile.equipment || '');

  const splitKey = pickSplit(days, profile.split_preference);
  const splitLabelMap = { full_body: 'Full Body', upper_lower: 'Upper/Lower', ppl: 'Push Pull Legs' };
  const split = splitLabelMap[splitKey] || 'Full Body';

  const libGym = {
    push: ['Supino reto', 'Desenvolvimento militar', 'Crucifixo', 'Tríceps corda', 'Elevação lateral', 'Paralela'],
    pull: ['Puxada frente', 'Remada curvada', 'Remada baixa', 'Rosca direta', 'Face pull', 'Rosca martelo'],
    legs: ['Agachamento', 'Leg press', 'Stiff', 'Cadeira extensora', 'Mesa flexora', 'Panturrilha'],
    full: ['Agachamento', 'Supino reto', 'Remada baixa', 'Desenvolvimento militar', 'Prancha', 'Levantamento terra romeno']
  };

  const libHomeDumbbell = {
    push: ['Flexão', 'Desenvolvimento halter', 'Mergulho banco', 'Elevação lateral', 'Tríceps testa', 'Flexão inclinada'],
    pull: ['Remada unilateral halter', 'Pullover', 'Rosca martelo', 'Encolhimento', 'Superman', 'Remada curvada halter'],
    legs: ['Agachamento goblet', 'Avanço', 'Stiff halter', 'Elevação pélvica', 'Panturrilha unilateral', 'Afundo búlgaro'],
    full: ['Agachamento goblet', 'Flexão', 'Remada unilateral halter', 'Elevação pélvica', 'Prancha', 'Avanço']
  };

  const libHomeBodyweight = {
    push: ['Flexão', 'Flexão inclinada', 'Flexão fechada', 'Mergulho banco', 'Prancha com toque no ombro'],
    pull: ['Remada australiana (mesa/barra)', 'Superman', 'Prancha reversa', 'Puxada com toalha isométrica', 'Bird dog'],
    legs: ['Agachamento livre', 'Afundo', 'Elevação pélvica', 'Panturrilha em pé', 'Agachamento isométrico'],
    full: ['Agachamento livre', 'Flexão', 'Superman', 'Elevação pélvica', 'Prancha']
  };

  const hasDumbbell = equipment.includes('halter') || equipment.includes('dumbbell');
  const isHomeOnly = equipment.includes('casa') || equipment.includes('home');
  const lib = isHomeOnly ? (hasDumbbell ? libHomeDumbbell : libHomeBodyweight) : libGym;

  let sets = level === 'iniciante' ? 3 : level === 'intermediario' ? 4 : 5;
  let reps = goal === 'hipertrofia' ? '6-12' : goal === 'emagrecimento' ? '12-15' : '8-14';
  let intensity = level === 'avancado' ? 'RIR 1-2' : 'RIR 2-3';

  if (checkin) {
    if (checkin.difficulty <= 4 && checkin.completed_percent >= 80 && checkin.pain <= 3) {
      sets += 1;
      intensity = 'RIR 1-2 (progressão de carga)';
    } else if (checkin.pain >= 7 || checkin.energy <= 3) {
      sets = Math.max(2, sets - 1);
      intensity = 'RIR 3-4 (deload leve)';
    }
  }

  const plan = [];
  if (splitKey === 'full_body') {
    for (let i = 1; i <= days; i++) {
      const filtered = applyLimitationsToExercises(lib.full, profile.limitations).slice(0, 5);
      plan.push({ day: `Dia ${i}`, focus: 'Full Body', intensity, exercises: filtered.map(name => {
        const meta = getExerciseMeta(name);
        return { exercise_id: meta.id, name: meta.label, sets, reps, rest: '60-90s', tempo: '2-0-2', estimated_seconds: 90 };
      }) });
    }
  } else if (splitKey === 'upper_lower') {
    for (let i = 0; i < days; i++) {
      const upper = i % 2 === 0;
      const base = upper ? [...lib.push.slice(0, 3), ...lib.pull.slice(0, 2)] : lib.legs.slice(0, 5);
      const ex = applyLimitationsToExercises(base, profile.limitations).slice(0, 5);
      plan.push({ day: `Dia ${i + 1}`, focus: upper ? 'Upper' : 'Lower', intensity, exercises: ex.map(name => {
        const meta = getExerciseMeta(name);
        return { exercise_id: meta.id, name: meta.label, sets, reps, rest: '60-120s', tempo: '2-1-2', estimated_seconds: 100 };
      }) });
    }
  } else {
    const order = ['Push', 'Pull', 'Legs'];
    for (let i = 0; i < days; i++) {
      const focus = order[i % 3];
      const exBase = focus === 'Push' ? lib.push : focus === 'Pull' ? lib.pull : lib.legs;
      const ex = applyLimitationsToExercises(exBase, profile.limitations).slice(0, 5);
      plan.push({ day: `Dia ${i + 1}`, focus, intensity, exercises: ex.map(name => {
        const meta = getExerciseMeta(name);
        return { exercise_id: meta.id, name: meta.label, sets, reps, rest: '60-120s', tempo: '2-0-2', estimated_seconds: 95 };
      }) });
    }
  }

  return { split, plan };
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
    const hash = await bcrypt.hash(password, 10);
    const result = await run(USE_POSTGRES ? 'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?) RETURNING id' : 'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email.toLowerCase(), hash]);
    const token = jwt.sign({ id: result.lastID, email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await get('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  const user = await get('SELECT id, name, email, created_at FROM users WHERE id = ?', [req.user.id]);
  const subscription = await get('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
  res.json({ user, subscription });
});

app.get('/api/profile/diet', auth, async (req, res) => {
  const profile = await get('SELECT weight, height, age, sex_biological, activity_level, allergies, disliked_foods, routine_notes FROM profiles WHERE user_id = ?', [req.user.id]);
  if (!profile) return res.status(404).json({ error: 'Perfil não encontrado' });
  res.json({ profile });
});

app.put('/api/profile/diet', auth, async (req, res) => {
  const { weight, height, age, sex_biological, activity_level, allergies, disliked_foods, routine_notes } = req.body;
  await run(`UPDATE profiles SET weight = ?, height = ?, age = ?, sex_biological = ?, activity_level = ?, allergies = ?, disliked_foods = ?, routine_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [weight || null, height || null, age || null, sex_biological || '', activity_level || '', allergies || '', disliked_foods || '', routine_notes || '', req.user.id]);
  res.json({ message: 'Perfil de dieta atualizado' });
});

app.get('/api/billing/packages', (_req, res) => {
  res.json({
    packages: [
      { code: 'plan_12m', label: '12 meses', months: 12, monthlyPrice: 99 },
      { code: 'plan_6m', label: '6 meses', months: 6, monthlyPrice: 119 },
      { code: 'plan_super', label: 'Plano FitAI Super', months: 12, monthlyPrice: 149, includesNutrition: true }
    ]
  });
});

app.post('/api/billing/mock-checkout', auth, async (req, res) => {
  const { packageCode } = req.body;
  const pack = packageCode === 'plan_12m'
    ? { code: 'plan_12m', months: 12, monthlyPrice: 99 }
    : packageCode === 'plan_6m'
      ? { code: 'plan_6m', months: 6, monthlyPrice: 119 }
      : packageCode === 'plan_super'
        ? { code: 'plan_super', months: 12, monthlyPrice: 149 }
        : null;

  if (!pack) return res.status(400).json({ error: 'Pacote inválido' });

  await run("UPDATE subscriptions SET status = 'inactive' WHERE user_id = ?", [req.user.id]);
  if (USE_POSTGRES) {
    await run(`INSERT INTO subscriptions (user_id, package_code, monthly_price, months, status, starts_at, ends_at)
      VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + (? || ' months')::interval)`,
      [req.user.id, pack.code, pack.monthlyPrice, pack.months, String(pack.months)]);
  } else {
    await run(`INSERT INTO subscriptions (user_id, package_code, monthly_price, months, status, starts_at, ends_at)
             VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, datetime('now', ?))`,
    [req.user.id, pack.code, pack.monthlyPrice, pack.months, `+${pack.months} months`]);
  }

  res.json({ message: 'Pagamento validado (simulado) e assinatura ativada', subscription: pack });
});

app.post('/api/onboarding', auth, async (req, res) => {
  try {
    const { objective, experience_level, days_per_week, time_per_session, equipment, limitations, split_preference } = req.body;
    if (!objective || !experience_level || !days_per_week || !time_per_session || !equipment) return res.status(400).json({ error: 'Dados incompletos' });

    await run(`INSERT INTO profiles (user_id, objective, experience_level, days_per_week, time_per_session, equipment, limitations, split_preference, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
      objective=excluded.objective,
      experience_level=excluded.experience_level,
      days_per_week=excluded.days_per_week,
      time_per_session=excluded.time_per_session,
      equipment=excluded.equipment,
      limitations=excluded.limitations,
      split_preference=excluded.split_preference,
      updated_at=CURRENT_TIMESTAMP`,
      [req.user.id, objective, experience_level, days_per_week, time_per_session, equipment, limitations || '', split_preference || 'auto']);

    const profile = await get('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    const generated = generateWorkout(profile, null);
    const latestWorkout = await get('SELECT MAX(version) as maxv FROM workouts WHERE user_id = ?', [req.user.id]);
    const version = (latestWorkout?.maxv || 0) + 1;

    const created = await run(USE_POSTGRES
      ? `INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP) RETURNING id`
      : `INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      [req.user.id, `Treino ${version}`, version, generated.split, JSON.stringify(generated.plan)]);

    await run('UPDATE workouts SET is_active = 0 WHERE user_id = ? AND id <> ?', [req.user.id, created.lastID]);

    res.json({ message: 'Perfil salvo e treino gerado', workoutId: created.lastID, version, split: generated.split, plan: generated.plan });
  } catch {
    res.status(500).json({ error: 'Erro no onboarding' });
  }
});

app.get('/api/workouts', auth, async (req, res) => {
  const workouts = await all('SELECT id, name, version, split_name, is_active, created_at, updated_at FROM workouts WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]);
  res.json({ workouts });
});

app.post('/api/workouts/create', auth, async (req, res) => {
  const { name } = req.body;
  const profile = await get('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
  if (!profile) return res.status(400).json({ error: 'Faça onboarding primeiro' });

  const latest = await get('SELECT MAX(version) as maxv FROM workouts WHERE user_id = ?', [req.user.id]);
  const version = (latest?.maxv || 0) + 1;
  const generated = generateWorkout(profile, null);

  const created = await run(USE_POSTGRES
    ? `INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP) RETURNING id`
    : `INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
    [req.user.id, (name || `Treino ${version}`).trim(), version, generated.split, JSON.stringify(generated.plan)]);

  await run('UPDATE workouts SET is_active = 0 WHERE user_id = ? AND id <> ?', [req.user.id, created.lastID]);
  res.json({ workoutId: created.lastID, version, split: generated.split, plan: generated.plan });
});

app.get('/api/workouts/current', auth, async (req, res) => {
  const workout = await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);
  if (!workout) return res.status(404).json({ error: 'Treino não encontrado' });
  res.json({ ...workout, plan: JSON.parse(workout.plan_json) });
});

app.get('/api/workouts/:id', auth, async (req, res) => {
  const workout = await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!workout) return res.status(404).json({ error: 'Treino não encontrado' });
  res.json({ ...workout, plan: JSON.parse(workout.plan_json) });
});

app.post('/api/workouts/:id/activate', auth, async (req, res) => {
  const own = await get('SELECT id FROM workouts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!own) return res.status(404).json({ error: 'Treino não encontrado' });
  await run('UPDATE workouts SET is_active = 0 WHERE user_id = ?', [req.user.id]);
  await run('UPDATE workouts SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ message: 'Treino ativo atualizado' });
});

app.patch('/api/workouts/:id/rename', auth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome inválido' });
  await run('UPDATE workouts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [name.trim(), req.params.id, req.user.id]);
  res.json({ message: 'Treino renomeado' });
});

app.put('/api/workouts/:id', auth, async (req, res) => {
  const { split_name, plan } = req.body;
  if (!Array.isArray(plan) || !split_name) return res.status(400).json({ error: 'Formato de treino inválido' });
  await run('UPDATE workouts SET split_name = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [split_name, JSON.stringify(plan), req.params.id, req.user.id]);
  res.json({ message: 'Treino ajustado com sucesso' });
});

app.get('/api/exercises/video', auth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'query obrigatória' });

    const videoUrl = findExerciseVideoUrl(q);
    if (!videoUrl) return res.status(404).json({ error: 'Vídeo não encontrado no lista_exercicios.json' });

    const idMatch = videoUrl.match(/(?:youtu\.be\/|v=)([A-Za-z0-9_-]+)/i);
    const videoId = idMatch?.[1];
    if (!videoId) return res.status(422).json({ error: 'URL inválida no lista_exercicios.json' });

    const embedUrl = `https://www.youtube.com/embed/${videoId}?start=7&rel=0`;
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&t=7s`;
    res.json({ videoId, embedUrl, watchUrl, source: 'lista_exercicios.json' });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar vídeo' });
  }
});

app.post('/api/ai/checkin-feedback', auth, async (req, res) => {
  try {
    const { workout_id, workout_name, message } = req.body;
    let target = null;
    if (workout_id) target = await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [workout_id, req.user.id]);
    if (!target && workout_name) target = await get('SELECT * FROM workouts WHERE user_id = ? AND lower(name) LIKE lower(?) ORDER BY updated_at DESC LIMIT 1', [req.user.id, `%${workout_name}%`]);
    if (!target) target = await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);

    if (!target) return res.status(404).json({ error: 'Treino alvo não encontrado' });
    const plan = JSON.parse(target.plan_json);
    const profile = await get('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);

    let analysis;
    try {
      analysis = await geminiJson({
        systemPrompt: 'Você é um coach de treino especializado em hipertrofia, perda de gordura e condicionamento. Analise feedback do usuário e devolva JSON técnico.',
        userPrompt: `Perfil=${JSON.stringify(profile || {})}\nTreino=${JSON.stringify(plan)}\nFeedback=${message}`,
        schemaHint: '{"intent":"question|reduce|increase|rebalance","target":"full|legs|chest|upper|lower","deltaSets":-1,"newRir":"RIR 2-3","rationale":"texto técnico curto","coachReply":"resposta final para o usuário"}'
      });
    } catch {
      const text = String(message || '').toLowerCase();
      analysis = {
        intent: text.includes('?') ? 'question' : (text.includes('dor') || text.includes('pesad') || text.includes('fadiga')) ? 'reduce' : (text.includes('leve') || text.includes('fácil')) ? 'increase' : 'rebalance',
        target: text.includes('perna') ? 'legs' : text.includes('peito') ? 'chest' : 'full',
        deltaSets: (text.includes('dor') || text.includes('pesad') || text.includes('fadiga')) ? -1 : (text.includes('leve') || text.includes('fácil')) ? 1 : 0,
        newRir: (text.includes('dor') || text.includes('pesad') || text.includes('fadiga')) ? 'RIR 3-4' : (text.includes('leve') || text.includes('fácil')) ? 'RIR 1-2' : 'RIR 2-3',
        rationale: 'Ajuste por fallback inteligente com base em dor/fadiga/percepção de esforço.',
        coachReply: 'Analisei seu feedback e montei um ajuste técnico para manter evolução com segurança.'
      };
    }

    let shouldSuggestPlan = analysis.intent !== 'question';
    const delta = Number(analysis.deltaSets || 0);
    if (shouldSuggestPlan) {
      const targetKey = String(analysis.target || 'full').toLowerCase();
      plan.forEach((d) => {
        const dayKey = String(d.focus || '').toLowerCase();
        const applies = targetKey === 'full' || dayKey.includes(targetKey) || (targetKey === 'legs' && (dayKey.includes('leg') || dayKey.includes('lower'))) || (targetKey === 'chest' && dayKey.includes('push'));
        if (!applies) return;
        if (analysis.newRir) d.intensity = analysis.newRir;
        (d.exercises || []).forEach((ex) => {
          if (delta !== 0) ex.sets = Math.min(6, Math.max(2, Number(ex.sets || 3) + delta));
        });
      });
    }

    const aiReply = analysis.coachReply || 'Analisei seu caso e preparei um ajuste personalizado.';
    const rationale = analysis.rationale || 'Baseado em percepção de esforço, recuperação e progressão de sobrecarga.';

    res.json({ aiReply: `${aiReply}\n\nBase técnica: ${rationale}`, suggestedPlan: shouldSuggestPlan ? plan : null, rationale, analysis });
  } catch (err) {
    console.error('AI_TRAINING_ERROR', err?.message || err);
    const msg = String(err?.message || '');
    if (msg.includes('GEMINI_HTTP_400')) return res.status(502).json({ error: 'Falha na IA (requisição inválida). Verifique configuração da API Gemini.' });
    if (msg.includes('GEMINI_HTTP_403')) return res.status(502).json({ error: 'Falha na IA (acesso negado). Verifique chave/permissões da API Gemini.' });
    if (msg.includes('GEMINI_HTTP_429')) return res.status(429).json({ error: 'Cota da API Gemini excedida (429). Ative faturamento/aumente limite no Google AI Studio/Cloud.' });
    if (msg.includes('GEMINI_KEY_MISSING')) return res.status(503).json({ error: 'GOOGLE_API_KEY não configurada no backend.' });
    res.status(500).json({ error: 'Erro ao gerar sugestão da IA' });
  }
});

app.post('/api/workouts/checkin', auth, async (req, res) => {
  try {
    const { workout_id, week_label, difficulty, energy, pain, completed_percent, notes } = req.body;
    await run(`INSERT INTO checkins (user_id, workout_id, week_label, difficulty, energy, pain, completed_percent, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [req.user.id, workout_id || null, week_label || 'Semana atual', difficulty, energy, pain, completed_percent, notes || '']);

    const profile = await get('SELECT * FROM profiles WHERE user_id = ?', [req.user.id]);
    if (!profile) return res.status(400).json({ error: 'Faça onboarding antes do check-in' });

    const checkin = { difficulty, energy, pain, completed_percent };
    const generated = generateWorkout(profile, checkin);
    const clinicalFlag = Number(pain) >= 8 ? 'Dor alta detectada: progressão agressiva bloqueada e aplicado ajuste conservador. Se persistir, procure avaliação profissional.' : null;
    const target = workout_id
      ? await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [workout_id, req.user.id])
      : await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);

    if (!target) return res.status(404).json({ error: 'Treino alvo não encontrado' });

    await run('UPDATE workouts SET split_name = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [generated.split, JSON.stringify(generated.plan), target.id, req.user.id]);

    res.json({ message: 'Check-in aplicado no treino', workoutId: target.id, split: generated.split, plan: generated.plan, clinicalFlag, explanation: clinicalFlag || 'Ajuste feito com base em conclusão semanal, dor, energia e dificuldade percebida.' });
  } catch {
    res.status(500).json({ error: 'Erro ao processar check-in' });
  }
});

app.post('/api/nutrition/plan', auth, async (req, res) => {
  try {
    const { objective, weight, height, age, sex, activity_level, routine_notes, allergies, disliked_foods } = req.body;
    if (!objective || !weight || !height || !age || !sex || !activity_level) {
      return res.status(400).json({ error: 'Preencha todos os campos obrigatórios da dieta' });
    }

    const t = getNutritionTargets({
      objective,
      weight: Number(weight),
      height: Number(height),
      age: Number(age),
      sex,
      activityLevel: activity_level
    });

    await run(`UPDATE profiles SET weight = ?, height = ?, age = ?, sex_biological = ?, activity_level = ?, allergies = ?, disliked_foods = ?, routine_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
      [weight || null, height || null, age || null, sex || '', activity_level || '', allergies || '', disliked_foods || '', routine_notes || '', req.user.id]);

    const blockedTerms = Array.from(new Set(`${allergies || ''},${disliked_foods || ''}`.split(/[,;\n]/).map(t => normalizeText(t).trim()).filter(Boolean)));
    const mealPool = [
      { meal: 'Café da manhã', options: ['2 ovos (100g) + aveia 40g + banana 90g', 'Iogurte natural 170g + granola sem açúcar 30g + fruta 100g', '2 pães de forma integrais (50g) + queijo branco 40g + fruta 100g'] },
      { meal: 'Almoço', options: ['Arroz cozido 140g + feijão 100g + frango grelhado 150g + salada 120g + azeite 8g', 'Batata doce 180g + carne magra 150g + legumes 120g', 'Macarrão integral cozido 160g + atum 120g + legumes 120g'] },
      { meal: 'Lanche', options: ['Sanduíche integral: pão 50g + frango desfiado 100g + salada 40g', 'Iogurte 170g + fruta 100g + castanhas 20g', 'Vitamina: leite 250ml + banana 90g + aveia 30g'] },
      { meal: 'Jantar', options: ['Arroz 120g + omelete (2 ovos, 100g) + salada 120g', 'Mandioca cozida 160g + peixe 150g + legumes 120g', 'Sopa de legumes 350g + proteína magra 130g'] }
    ];

    const mealCaloriesDefault = Math.round(t.calories / 4);
    const filteredMeals = mealPool.map(m => {
      const safe = m.options.find(o => !blockedTerms.some(term => normalizeText(o).includes(term)));
      const fallbackSafe = `${m.meal} segura: proteína magra 120g + carboidrato complexo 120g + legumes 150g`;
      const chosen = safe || fallbackSafe;
      const items = splitMealItems(chosen);
      const sum = items.reduce((acc, it) => acc + (it.calories || 0), 0);
      return { meal: m.meal, suggestion: chosen, items, calories: sum > 0 ? sum : mealCaloriesDefault };
    });

    await run('DELETE FROM nutrition_plans WHERE user_id = ?', [req.user.id]);
    await run(`INSERT INTO nutrition_plans (user_id, objective, weight, height, age, sex, activity_level, routine_notes, allergies, disliked_foods, calories, protein_g, carbs_g, fat_g, meal_plan_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [req.user.id, objective, weight, height, age, sex, activity_level, routine_notes || '', allergies || '', disliked_foods || '', t.calories, t.protein, t.carbs, t.fat, JSON.stringify(filteredMeals)]);

    res.json({
      message: 'Plano alimentar gerado',
      calories: t.calories,
      macros: { protein_g: t.protein, carbs_g: t.carbs, fat_g: t.fat },
      meals: filteredMeals,
      note: 'Estimativa baseada em fórmula de Mifflin-St Jeor + ajuste por objetivo. Para condições clínicas, consulte nutricionista.'
    });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar plano alimentar' });
  }
});

app.get('/api/nutrition/plan', auth, async (req, res) => {
  const row = await get('SELECT * FROM nutrition_plans WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [req.user.id]);
  if (!row) return res.status(404).json({ error: 'Plano alimentar não encontrado' });
  res.json({ ...row, meals: JSON.parse(row.meal_plan_json) });
});

app.post('/api/ai/nutrition-chat', auth, async (req, res) => {
  try {
    const { message } = req.body;
    const plan = await get('SELECT * FROM nutrition_plans WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.status(404).json({ error: 'Crie um plano alimentar antes de conversar com a IA de dieta.' });

    let reply;
    try {
      reply = await geminiText({
        systemPrompt: 'Você é nutricionista esportivo virtual. Responda de forma específica, educada e prática. Sempre cite impacto em kcal/macros e mantenha linguagem clara.',
        userPrompt: `Plano atual: kcal ${plan.calories}, P ${plan.protein_g}g, C ${plan.carbs_g}g, G ${plan.fat_g}g. Refeições: ${plan.meal_plan_json}. Pergunta: ${message}`,
        temperature: 0.3,
        maxOutputTokens: 700
      });
    } catch {
      const q = String(message || '').toLowerCase();
      const goal = q.includes('perder') ? 'reduzir 120-180 kcal' : q.includes('ganhar') ? 'aumentar 120-180 kcal' : 'manter calorias e ajustar qualidade alimentar';
      reply = `Fallback inteligente ativo: para seu contexto atual, recomendo ${goal}.\n\nMeta atual: ${plan.calories} kcal | P ${plan.protein_g}g | C ${plan.carbs_g}g | G ${plan.fat_g}g.\n\nSe quiser, diga a refeição exata (café/almoço/lanche/jantar) e eu te devolvo uma substituição em gramas.`;
    }

    return res.json({ aiReply: reply });
  } catch (err) {
    console.error('AI_NUTRITION_ERROR', err?.message || err);
    const msg = String(err?.message || '');
    if (msg.includes('GEMINI_HTTP_400')) return res.status(502).json({ error: 'Falha na IA de dieta (requisição inválida).' });
    if (msg.includes('GEMINI_HTTP_403')) return res.status(502).json({ error: 'Falha na IA de dieta (acesso negado). Verifique permissões da chave.' });
    if (msg.includes('GEMINI_HTTP_429')) return res.status(429).json({ error: 'Cota da API Gemini excedida (429). Ative faturamento/aumente limite no Google AI Studio/Cloud.' });
    if (msg.includes('GEMINI_KEY_MISSING')) return res.status(503).json({ error: 'GOOGLE_API_KEY não configurada no backend.' });
    res.status(500).json({ error: 'Erro na IA de dieta' });
  }
});

app.get('/api/progress', auth, async (req, res) => {
  const checkins = await all('SELECT * FROM checkins WHERE user_id = ? ORDER BY id DESC LIMIT 12', [req.user.id]);
  const workouts = await all('SELECT id, name, version, split_name, is_active, updated_at FROM workouts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20', [req.user.id]);
  res.json({ checkins, workouts });
});

app.get('/api/metrics', auth, async (req, res) => {
  res.json(metrics);
});

app.get('/api/export/pdf', auth, async (req, res) => {
  const workoutId = req.query.workoutId;
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const workout = workoutId
    ? await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [workoutId, req.user.id])
    : await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);

  if (!workout) return res.status(404).json({ error: 'Sem treino para exportar' });

  const plan = JSON.parse(workout.plan_json);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="treino-${workout.name.replace(/\s+/g, '-')}.pdf"`);

  const doc = new PDFDocument({ margin: 40 });
  doc.pipe(res);
  doc.fontSize(20).text('FitAI Planner', { align: 'center' });
  doc.moveDown(0.2);
  doc.fontSize(12).text(`Usuário: ${user.name} (${user.email})`, { align: 'center' });
  doc.text(`${workout.name} • v${workout.version} • Split: ${workout.split_name}`, { align: 'center' });
  doc.moveDown();

  plan.forEach((day) => {
    doc.fontSize(14).text(`${day.day} - ${day.focus}`);
    doc.fontSize(10).text(`Intensidade: ${day.intensity}`);
    (day.exercises || []).forEach((ex) => doc.text(`• ${ex.name} — ${ex.sets}x${ex.reps} (descanso ${ex.rest})`));
    doc.moveDown(0.6);
  });

  doc.end();
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDb().then(() => app.listen(PORT, () => console.log(`FitAI Planner rodando em http://localhost:${PORT} (${USE_POSTGRES ? 'PostgreSQL' : 'SQLite'})`)));
