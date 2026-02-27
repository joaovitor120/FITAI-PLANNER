const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const PDFDocument = require('pdfkit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change';
const db = new sqlite3.Database(path.join(__dirname, 'fitai.db'));

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { if (err) return reject(err); resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function ensureColumn(table, column, definition) {
  const cols = await all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === column)) await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function initDb() {
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

  await ensureColumn('profiles', 'split_preference', 'TEXT');
  await ensureColumn('workouts', 'name', "TEXT NOT NULL DEFAULT 'Meu Treino'");
  await ensureColumn('workouts', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  await ensureColumn('workouts', 'updated_at', 'DATETIME');
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

function generateWorkout(profile, checkin) {
  const days = Number(profile.days_per_week);
  const goal = profile.objective;
  const level = profile.experience_level;
  const equipment = (profile.equipment || '').toLowerCase();

  const splitKey = pickSplit(days, profile.split_preference);
  const splitLabelMap = { full_body: 'Full Body', upper_lower: 'Upper/Lower', ppl: 'Push Pull Legs' };
  const split = splitLabelMap[splitKey] || 'Full Body';

  const libGym = {
    push: ['Supino reto', 'Desenvolvimento militar', 'Crucifixo', 'Tríceps corda', 'Elevação lateral', 'Paralela'],
    pull: ['Puxada frente', 'Remada curvada', 'Remada baixa', 'Rosca direta', 'Face pull', 'Rosca martelo'],
    legs: ['Agachamento', 'Leg press', 'Stiff', 'Cadeira extensora', 'Mesa flexora', 'Panturrilha'],
    full: ['Agachamento', 'Supino reto', 'Remada baixa', 'Desenvolvimento militar', 'Prancha', 'Levantamento terra romeno']
  };

  const libHome = {
    push: ['Flexão', 'Desenvolvimento halter', 'Mergulho banco', 'Elevação lateral', 'Tríceps testa', 'Flexão inclinada'],
    pull: ['Remada unilateral halter', 'Pullover', 'Rosca martelo', 'Encolhimento', 'Superman', 'Remada curvada halter'],
    legs: ['Agachamento goblet', 'Avanço', 'Stiff halter', 'Elevação pélvica', 'Panturrilha unilateral', 'Afundo búlgaro'],
    full: ['Agachamento goblet', 'Flexão', 'Remada unilateral', 'Elevação pélvica', 'Prancha', 'Avanço']
  };

  const lib = (equipment.includes('casa') || equipment.includes('halter')) ? libHome : libGym;

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
      plan.push({ day: `Dia ${i}`, focus: 'Full Body', intensity, exercises: lib.full.slice(0, 5).map(name => ({ name, sets, reps, rest: '60-90s' })) });
    }
  } else if (splitKey === 'upper_lower') {
    for (let i = 0; i < days; i++) {
      const upper = i % 2 === 0;
      const ex = upper ? [...lib.push.slice(0, 3), ...lib.pull.slice(0, 2)] : lib.legs.slice(0, 5);
      plan.push({ day: `Dia ${i + 1}`, focus: upper ? 'Upper' : 'Lower', intensity, exercises: ex.map(name => ({ name, sets, reps, rest: '60-120s' })) });
    }
  } else {
    const order = ['Push', 'Pull', 'Legs'];
    for (let i = 0; i < days; i++) {
      const focus = order[i % 3];
      const ex = focus === 'Push' ? lib.push : focus === 'Pull' ? lib.pull : lib.legs;
      plan.push({ day: `Dia ${i + 1}`, focus, intensity, exercises: ex.slice(0, 5).map(name => ({ name, sets, reps, rest: '60-120s' })) });
    }
  }

  return { split, plan };
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Campos obrigatórios' });
    const hash = await bcrypt.hash(password, 10);
    const result = await run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', [name, email.toLowerCase(), hash]);
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

app.get('/api/billing/packages', (_req, res) => {
  res.json({
    packages: [
      { code: 'plan_12m', label: '12 meses', months: 12, monthlyPrice: 99 },
      { code: 'plan_6m', label: '6 meses', months: 6, monthlyPrice: 119 }
    ]
  });
});

app.post('/api/billing/mock-checkout', auth, async (req, res) => {
  const { packageCode } = req.body;
  const pack = packageCode === 'plan_12m'
    ? { code: 'plan_12m', months: 12, monthlyPrice: 99 }
    : packageCode === 'plan_6m'
      ? { code: 'plan_6m', months: 6, monthlyPrice: 119 }
      : null;

  if (!pack) return res.status(400).json({ error: 'Pacote inválido' });

  await run("UPDATE subscriptions SET status = 'inactive' WHERE user_id = ?", [req.user.id]);
  await run(`INSERT INTO subscriptions (user_id, package_code, monthly_price, months, status, starts_at, ends_at)
             VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, datetime('now', ?))`,
  [req.user.id, pack.code, pack.monthlyPrice, pack.months, `+${pack.months} months`]);

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

    const created = await run(`INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
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

  const created = await run(`INSERT INTO workouts (user_id, name, version, split_name, plan_json, is_active, updated_at)
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

app.post('/api/ai/checkin-feedback', auth, async (req, res) => {
  try {
    const { workout_id, message } = req.body;
    const target = workout_id
      ? await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [workout_id, req.user.id])
      : await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);

    if (!target) return res.status(404).json({ error: 'Treino alvo não encontrado' });
    const text = String(message || '').toLowerCase();
    const plan = JSON.parse(target.plan_json);

    let aiReply = 'Analisando seu feedback, recomendo ajustes leves de volume e intensidade para manter evolução estável.';

    // Tentativa de usar IA gratuita (Hugging Face Inference). Se falhar, cai no modo local.
    try {
      const hf = await fetch('https://api-inference.huggingface.co/models/google/flan-t5-small', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: `Você é um coach fitness. Responda curto em português para este feedback: ${message}`,
          options: { wait_for_model: false }
        })
      });
      if (hf.ok) {
        const hfData = await hf.json();
        const txt = Array.isArray(hfData) ? hfData?.[0]?.generated_text : hfData?.generated_text;
        if (txt && typeof txt === 'string' && txt.trim().length > 0) {
          aiReply = txt.trim();
        }
      }
    } catch {
      // segue com fallback local abaixo
    }

    if (text.includes('pesado') || text.includes('dor') || text.includes('cans') || text.includes('fadiga')) {
      aiReply = 'Entendi. Vou reduzir um pouco o volume e aumentar a margem de recuperação.';
      plan.forEach(d => {
        d.intensity = 'RIR 3-4 (ajuste por fadiga)';
        (d.exercises || []).forEach(ex => ex.sets = Math.max(2, Number(ex.sets || 3) - 1));
      });
    } else if (text.includes('leve') || text.includes('fácil') || text.includes('tranquilo')) {
      aiReply = 'Perfeito. Vou aumentar levemente o estímulo para acelerar progresso.';
      plan.forEach(d => {
        d.intensity = 'RIR 1-2 (progressão)';
        (d.exercises || []).forEach(ex => ex.sets = Math.min(6, Number(ex.sets || 3) + 1));
      });
    } else if (text.includes('perna')) {
      aiReply = 'Vou aliviar pernas e redistribuir volume para melhorar recuperação.';
      plan.forEach(d => {
        if ((d.focus || '').toLowerCase().includes('leg') || (d.focus || '').toLowerCase().includes('lower')) {
          (d.exercises || []).forEach(ex => ex.sets = Math.max(2, Number(ex.sets || 3) - 1));
        }
      });
    } else if (text.includes('peito')) {
      aiReply = 'Boa. Vou reforçar estímulo de peitoral com progressão controlada.';
      plan.forEach(d => {
        (d.exercises || []).forEach(ex => {
          if ((ex.name || '').toLowerCase().includes('supino') || (ex.name || '').toLowerCase().includes('crucifixo')) {
            ex.sets = Math.min(6, Number(ex.sets || 3) + 1);
          }
        });
      });
    }

    res.json({ aiReply, suggestedPlan: plan });
  } catch {
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
    const target = workout_id
      ? await get('SELECT * FROM workouts WHERE id = ? AND user_id = ?', [workout_id, req.user.id])
      : await get('SELECT * FROM workouts WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [req.user.id]);

    if (!target) return res.status(404).json({ error: 'Treino alvo não encontrado' });

    await run('UPDATE workouts SET split_name = ?, plan_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [generated.split, JSON.stringify(generated.plan), target.id, req.user.id]);

    res.json({ message: 'Check-in aplicado no treino', workoutId: target.id, split: generated.split, plan: generated.plan });
  } catch {
    res.status(500).json({ error: 'Erro ao processar check-in' });
  }
});

app.get('/api/progress', auth, async (req, res) => {
  const checkins = await all('SELECT * FROM checkins WHERE user_id = ? ORDER BY id DESC LIMIT 12', [req.user.id]);
  const workouts = await all('SELECT id, name, version, split_name, is_active, updated_at FROM workouts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20', [req.user.id]);
  res.json({ checkins, workouts });
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

initDb().then(() => app.listen(PORT, () => console.log(`FitAI Planner rodando em http://localhost:${PORT}`)));
