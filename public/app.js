const state = {
  token: localStorage.getItem('fitai_token') || null,
  theme: localStorage.getItem('fitai_theme') || 'light',
  currentWorkout: null,
  subscriptionActive: false,
  subscription: null,
  demoMode: false,
  aiSuggestedPlan: null,
  aiPendingConfirm: false,
  aiTargetWorkoutId: null,
  aiPendingMeta: null,
  workoutCache: [],
  liveSequence: [],
  liveIndex: 0,
  timer: { sec: 0, id: null },
  profileDaysPerWeek: null,
  doneDays: new Set()
};

const $ = (id) => document.getElementById(id);
const page = document.body.dataset.page;

function setMsg(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#ff6b6b' : 'var(--accent)';
}
function authHeaders() { return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` }; }
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('fitai_theme', theme);
  if ($('theme-toggle')) $('theme-toggle').textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
}
function bindShared() {
  $('theme-toggle')?.addEventListener('click', () => applyTheme(state.theme === 'dark' ? 'light' : 'dark'));
  applyTheme(state.theme);
}

function renderSubscriptionStatus() {
  const el = $('subscription-status');
  if (!el) return;
  if (!state.subscription || state.subscription.status !== 'active') return el.textContent = 'Sem assinatura ativa (modo demonstração).';
  const labels = { plan_12m: 'Plano FitAI (R$39,90/mês)', plan_6m: 'Plano FitAI Plus (R$49,90/mês)', plan_pro: 'Plano FitAI Pro (R$59,90/mês)' };
  const end = state.subscription.ends_at ? new Date(state.subscription.ends_at).toLocaleDateString('pt-BR') : '—';
  el.textContent = `Plano atual: ${labels[state.subscription.package_code] || state.subscription.package_code} • ativo até ${end}`;
  ['buy-12m','buy-6m','buy-pro'].forEach((id) => $(id)?.classList.remove('active'));
  const activeBtn = state.subscription.package_code === 'plan_12m' ? 'buy-12m' : state.subscription.package_code === 'plan_6m' ? 'buy-6m' : 'buy-pro';
  $(activeBtn)?.classList.add('active');
}

function addAiLog(author, text, box = 'ai-chat-log') {
  const el = $(box); if (!el) return;
  el.classList.remove('hidden');
  const line = document.createElement('p'); line.className = 'chat-msg'; line.innerHTML = `<strong>${author}:</strong> ${text}`;
  el.appendChild(line); el.scrollTop = el.scrollHeight;
}

function infoTip(label, text) {
  return `<span class="term-help" data-tip="${text}">${label}</span>`;
}

function formatPlanAsText(plan) {
  return (plan || []).map(day => [`${day.day} | ${day.focus} | ${day.intensity}`,...(day.exercises || []).map(ex => `- ${ex.name} | ${ex.sets}x${ex.reps} | ${ex.rest}`)].join('\n')).join('\n\n');
}

function normalize(v=''){ return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
const cap = (s='') => s.replace(/(^|\n)([a-zà-ú])/g, (_, a, b) => `${a}${b.toUpperCase()}`);

let tooltipTimer = null;
function bindTermTooltips() {
  document.querySelectorAll('.term-help').forEach((el) => {
    el.onmouseenter = () => {
      tooltipTimer = setTimeout(() => {
        const tip = document.createElement('div');
        tip.className = 'term-tooltip';
        tip.id = 'term-tooltip';
        tip.textContent = el.dataset.tip || '';
        document.body.appendChild(tip);
        const r = el.getBoundingClientRect();
        tip.style.left = `${r.left + window.scrollX}px`;
        tip.style.top = `${r.bottom + window.scrollY + 8}px`;
      }, 2000);
    };
    el.onmouseleave = () => {
      clearTimeout(tooltipTimer);
      document.getElementById('term-tooltip')?.remove();
    };
  });
}

async function openExerciseModal(name) {
  $('exercise-modal-title').textContent = `${name} (carregando vídeo...)`;
  $('exercise-modal').classList.remove('hidden');
  try {
    const res = await fetch(`/api/exercises/video?q=${encodeURIComponent(name)}`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha');
    $('exercise-modal-title').textContent = name;
    $('exercise-frame').src = data.embedUrl;
    $('exercise-open-new').href = data.watchUrl;
  } catch {
    $('exercise-modal-title').textContent = `${name} (sem vídeo mapeado)`;
    $('exercise-frame').src = 'about:blank';
    $('exercise-open-new').href = `https://www.youtube.com/results?search_query=${encodeURIComponent(name)}`;
  }
}
window.openExercise = openExerciseModal;

function renderWorkout(workout) {
  state.currentWorkout = workout;
  if (!$('workout-output') || !$('plan-text-view')) return;
  if (!workout?.plan?.length) {
    $('workout-output').innerHTML = '<p>Sem treino aberto.</p>';
    $('plan-text-view').textContent = '';
    return;
  }

  const equipmentTag = workout.equipment || workout.category || 'Não informado';
  $('workout-output').innerHTML = `<p><strong>${workout.name}</strong> • v${workout.version} • Split: ${workout.split_name} • Categoria: ${equipmentTag}</p>` + workout.plan.map(day => `
  <div class="day"><strong>${day.day} — ${day.focus}</strong><br/><small>${day.intensity}</small><ul>
  ${(day.exercises || []).map((ex, exIndex) => {
    const warm = exIndex === 0 ? 1 : 0;
    const rec = 1;
    const work = Math.max(1, Number(ex.sets || 3) - warm - rec);
    const seriesLines = [
      ...(warm ? [`${infoTip('Séries de aquecimento', 'Carga baixa para preparar o músculo/articulação')}: ${warm}x15-20 • ${infoTip('RIR', 'Repetições em reserva antes da falha')}: 4+`] : []),
      `${infoTip('Séries de reconhecimento', 'Carga para reconhecer o movimento sem falhar')}: ${rec}x<10 • ${infoTip('RIR', 'Repetições em reserva antes da falha')}: 2-3`,
      `${infoTip('Séries de trabalho', 'Séries principais próximas da falha técnica')}: ${work}x${ex.reps} • Intensidade: ${day.intensity}`
    ];
    return `<li><strong>${ex.name}</strong> (${ex.rest}) <button class="btn btn-mini" onclick="openExercise('${String(ex.name).replace(/'/g, "\\'")}')">Ver execução</button><br/>
    <small>${seriesLines.join('<br/>')}</small></li>`;
  }).join('')}
  </ul><small>Descanso recomendado: 60-120s entre séries.</small></div>`).join('');

  $('plan-text-view').textContent = formatPlanAsText(workout.plan);
  $('plan-text-view').contentEditable = 'false';
  $('dashboard-section').classList.remove('hidden');
  state.liveSequence = (workout.plan || []).flatMap(d => (d.exercises || []).map(ex => ({ day: d.day, ...ex })));
  state.liveIndex = 0;
  bindTermTooltips();
  renderSchedule();
}

function featureGate(label = 'essa função') {
  return `Para usar ${label}, você precisa de um plano ativo.`;
}

async function fetchCurrentWorkout() {
  const res = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (!res.ok) return;
  renderWorkout(await res.json());
  setMsg('update-msg', 'Treino atualizado com sucesso.');
}

function renderAiWorkoutTargets() {
  const sel = $('ai-workout-target');
  if (!sel) return;
  sel.innerHTML = '<option value="">Treino selecionado no dashboard</option>' + state.workoutCache.map(w => `<option value="${w.id}">${w.name} (v${w.version})</option>`).join('');
}

async function loadWorkoutList() {
  const res = await fetch('/api/workouts', { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  state.workoutCache = data.workouts || [];
  renderAiWorkoutTargets();
  const list = $('workout-list'); if (!list) return;
  if (!state.workoutCache.length) return list.innerHTML = '<p>Nenhum treino criado ainda.</p>';
  list.innerHTML = state.workoutCache.map(w => `<div class="day"><strong>${w.name}</strong> • v${w.version} • ${w.split_name} ${w.is_active ? '✅ ativo' : ''}
  <div class="actions"><button class="btn" data-act="activate" data-id="${w.id}">Ativar</button><button class="btn" data-act="open" data-id="${w.id}">Abrir treino</button><button class="btn" data-act="rename" data-id="${w.id}" data-name="${String(w.name).replace(/"/g, '&quot;')}">Renomear</button></div></div>`).join('');
  list.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.dataset.id);
      if (b.dataset.act === 'activate') return window.activateWorkout(id);
      if (b.dataset.act === 'open') return window.openWorkout(id);
      if (b.dataset.act === 'rename') return window.renameWorkout(id, b.dataset.name || 'Meu treino');
    };
  });
}

window.activateWorkout = async (id) => { await fetch(`/api/workouts/${id}/activate`, { method: 'POST', headers: authHeaders() }); await loadWorkoutList(); await openWorkout(id); };
window.openWorkout = async (id) => { const res = await fetch(`/api/workouts/${id}`, { headers: authHeaders() }); if (res.ok) renderWorkout(await res.json()); };
window.renameWorkout = async (id, oldName='Meu treino') => {
  if (!state.subscriptionActive) return setMsg('checkin-msg', featureGate('renomear treino'), true);
  const newName = prompt('Novo nome do treino:', oldName); if (!newName?.trim()) return;
  await fetch(`/api/workouts/${id}/rename`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name: newName.trim() }) });
  await loadWorkoutList(); if (state.currentWorkout?.id === id) await openWorkout(id);
};

async function doMockCheckout(packageCode) {
  const res = await fetch('/api/billing/mock-checkout', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ packageCode }) });
  const data = await res.json(); if (!res.ok) return setMsg('billing-msg', data.error || 'Falha no pagamento simulado', true);
  setMsg('billing-msg', 'Pagamento simulado aprovado!'); await routeApp();
}

function parseTextToPlan(text) {
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const [head, ...exerciseLines] = lines;
    const [day = 'Dia', focus = 'Full Body', intensity = 'RIR 2-3'] = head.split('|').map(s => s.trim());
    const exercises = exerciseLines.filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '')).map(l => {
      const [name = 'Exercício', sr = '3x10', rest = '60-90s'] = l.split('|').map(s => s.trim());
      const [sets = '3', reps = '10'] = sr.toLowerCase().split('x').map(s => s.trim());
      return { name, sets: Number(sets) || 3, reps, rest };
    });
    return { day, focus, intensity, exercises };
  });
}

function setTab(tab) {
  const ids = ['training', 'nutrition', 'schedule'];
  ids.forEach((k) => {
    $(`tab-${k}`)?.classList.toggle('active', k === tab);
    $(`panel-${k}`)?.classList.toggle('hidden', k !== tab);
  });
}

function getWeeklyTrainPattern(split, freq) {
  const s = normalize(split || '');
  if (s.includes('full body') || s.includes('full')) return freq === 4 ? [1,2,4,5] : [1,3,5];
  if (s.includes('upper') || s.includes('lower')) return freq >= 5 ? [1,2,4,5,6] : [1,2,4,5];
  if (s.includes('push') || s.includes('pull') || s.includes('legs')) return freq >= 6 ? [1,2,3,5,6] : [1,2,3,5,6].slice(0, Math.max(4, freq));
  return [1,3,5];
}

function getStreak() {
  return Number(localStorage.getItem('fitai_streak_days') || 0);
}

function getIsoDate(d = new Date()) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

function getCurrentWeekLabel() {
  const d = new Date();
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function markWorkoutDone(isoDate = getIsoDate()) {
  state.doneDays.add(isoDate);
  localStorage.setItem('fitai_done_days', JSON.stringify(Array.from(state.doneDays)));
  const today = getIsoDate();
  const last = localStorage.getItem('fitai_streak_last_day');
  let streak = getStreak();
  if (last !== today) {
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    streak = last === y ? streak + 1 : 1;
    localStorage.setItem('fitai_streak_days', String(streak));
    localStorage.setItem('fitai_streak_last_day', today);
  }
  if ($('streak-box')) $('streak-box').textContent = `🔥 Sequência: ${streak} dias`;
  if ($('day-done-toast')) $('day-done-toast').textContent = '🎉 Treino concluído! Mandou bem!';
}

function renderSchedule() {
  if (!$('schedule-grid')) return;
  if ($('streak-box')) $('streak-box').textContent = `🔥 Sequência: ${getStreak()} dias`;
  if (!state.currentWorkout?.plan?.length) { $('schedule-grid').innerHTML = '<div class="day">Nenhum treino ativo encontrado.</div>'; return; }
  const now = new Date();
  const todayIso = getIsoDate(now);
  const y = now.getFullYear();
  const m = now.getMonth();
  const total = new Date(y, m + 1, 0).getDate();
  const freq = Math.max(3, Math.min(6, state.profileDaysPerWeek || state.currentWorkout.plan.length || 3));
  const pattern = getWeeklyTrainPattern(state.currentWorkout.split_name, freq);
  $('schedule-month').textContent = `${now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })} • Semana atual: ${getCurrentWeekLabel()}`;

  const days = [];
  let idx = 0;
  const dayToPlan = {};
  for (let d = 1; d <= total; d++) {
    const dt = new Date(y, m, d);
    const iso = getIsoDate(dt);
    const weekDay = dt.getDay();
    const isTrainDay = pattern.includes(weekDay);
    const planDay = isTrainDay ? state.currentWorkout.plan[idx % state.currentWorkout.plan.length] : null;
    const isToday = iso === todayIso;
    const done = state.doneDays.has(iso);
    if (isTrainDay) { dayToPlan[d] = { ...planDay, iso }; idx++; }
    days.push(`<button class="day cal-day ${isTrainDay ? 'train clickable' : 'rest'} ${isToday ? 'today' : ''}" data-day="${d}" data-iso="${iso}">${d}<br/><small>${isTrainDay ? planDay.focus : 'Descanso'}</small>${isTrainDay ? `<br/><span class="cal-check ${done ? 'done' : ''}">${done ? '✔ Feito' : 'Marcar treino'}</span>` : ''}</button>`);
  }
  $('schedule-grid').innerHTML = days.join('');

  [...document.querySelectorAll('.cal-day')].forEach((btn) => btn.onclick = () => {
    const day = Number(btn.dataset.day);
    const iso = btn.dataset.iso;
    const selected = dayToPlan[day];
    if (!selected) return;
    $('schedule-modal-title').textContent = `Dia ${day} • ${selected.focus}`;
    $('schedule-modal-body').innerHTML = `<div class="modal-train-list">${selected.exercises.map((ex, i) => `<div class="series-item"><div><strong>${ex.name}</strong><br/><small>${i === 0 ? 'Aquecimento + ' : ''}${ex.sets}x${ex.reps} • descanso ${ex.rest}</small></div><button class="series-check" data-series="${i}" aria-label="Marcar série"></button></div>`).join('')}</div><div class="actions"><button id="schedule-mark-done" class="btn neon">Concluir treino</button></div>`;
    $('schedule-modal').classList.remove('hidden');
    document.querySelectorAll('.series-check').forEach((s) => {
      s.onclick = () => s.classList.toggle('done');
    });
    $('schedule-mark-done').onclick = () => {
      if (iso !== getIsoDate()) {
        const msg = iso < getIsoDate() ? 'Esse treino já passou.' : 'Esse treino ainda vai acontecer.';
        setMsg('day-done-toast', msg, true);
        setMsg('schedule-alert', `⚠️ ${msg}`, true);
        alert(msg);
        return;
      }
      markWorkoutDone(iso);
      setMsg('day-done-toast', '✅ Treino concluído com sucesso! Excelente trabalho.');
      setMsg('schedule-alert', '✅ Parabéns! Seu treino de hoje foi registrado.');
      $('schedule-modal').classList.add('hidden');
      renderSchedule();
    };
  });
}

async function routeApp() {
  if (!state.token) return window.location.href = '/login.html';
  const meRes = await fetch('/api/me', { headers: authHeaders() });
  if (!meRes.ok) { localStorage.removeItem('fitai_token'); return window.location.href = '/login.html'; }
  const me = await meRes.json();
  state.subscription = me.subscription || null;
  state.subscriptionActive = me.subscription?.status === 'active';
  state.doneDays = new Set(JSON.parse(localStorage.getItem('fitai_done_days') || '[]'));
  state.demoMode = !state.subscriptionActive;
  renderSubscriptionStatus();
  $('demo-banner')?.classList.toggle('hidden', !state.demoMode);

  const workoutRes = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (workoutRes.status === 404) {
    $('onboarding-section')?.classList.remove('hidden');
  } else {
    $('onboarding-section')?.classList.add('hidden');
    if (workoutRes.ok) renderWorkout(await workoutRes.json());
  }
  $('dashboard-section')?.classList.add('hidden');
  await loadWorkoutList();
  if (!state.currentWorkout && state.workoutCache.length) {
    const active = state.workoutCache.find(w => w.is_active) || state.workoutCache[0];
    if (active?.id) await openWorkout(active.id);
  }

  const profileRes = await fetch('/api/profile', { headers: authHeaders() });
  if (profileRes.ok) {
    const p = await profileRes.json();
    state.profileDaysPerWeek = p.profile?.days_per_week || null;
  }

  $('onboarding-tip').textContent = state.demoMode ? 'No modo demonstração, use pelo menos Dias por semana e Minutos por treino. Os demais campos são opcionais.' : '';

  const prof = await fetch('/api/profile/diet', { headers: authHeaders() });
  if (prof.ok) {
    const p = (await prof.json()).profile || {};
    if ($('nut-weight')) $('nut-weight').value = p.weight || '';
    if ($('nut-height')) $('nut-height').value = p.height || '';
    if ($('nut-age')) $('nut-age').value = p.age || '';
    if ($('nut-sex')) $('nut-sex').value = p.sex_biological || '';
    if ($('nut-activity')) $('nut-activity').value = p.activity_level || '';
    if ($('nut-allergies')) $('nut-allergies').value = p.allergies || '';
    if ($('nut-dislikes')) $('nut-dislikes').value = p.disliked_foods || '';
    if ($('nut-routine')) $('nut-routine').value = p.routine_notes || '';
  }

  const nut = await fetch('/api/nutrition/plan', { headers: authHeaders() });
  if (nut.ok) renderNutrition(await nut.json());
  await loadNutritionPlans();
  await loadCheckinHistory();
}

async function loadNutritionPlans() {
  const res = await fetch('/api/nutrition/plans', { headers: authHeaders() });
  if (!res.ok || !$('nutrition-plan-list')) return;
  const data = await res.json();
  $('nutrition-plan-list').innerHTML = (data.plans || []).map(p => `<div class="actions"><span>${p.name} ${p.is_active ? '✅ ativo' : '⚪ inativo'}</span><button class="btn btn-mini" data-nut-act="activate" data-id="${p.id}">Ativar</button><button class="btn btn-mini" data-nut-act="deactivate" data-id="${p.id}">Inativar</button><button class="btn btn-mini" data-nut-act="rename" data-id="${p.id}" data-name="${String(p.name).replace(/"/g, '&quot;')}">Renomear</button></div>`).join('') || '<p>Nenhum plano alimentar criado.</p>';
  $('nutrition-plan-list').querySelectorAll('button[data-nut-act]').forEach((b) => {
    b.onclick = async () => {
      const id = Number(b.dataset.id);
      if (b.dataset.nutAct === 'activate') {
        await fetch(`/api/nutrition/plans/${id}/activate`, { method: 'POST', headers: authHeaders() });
      }
      if (b.dataset.nutAct === 'deactivate') {
        await fetch(`/api/nutrition/plans/${id}/deactivate`, { method: 'POST', headers: authHeaders() });
      }
      if (b.dataset.nutAct === 'rename') {
        const name = prompt('Novo nome do plano alimentar:', b.dataset.name || 'Plano alimentar');
        if (name?.trim()) await fetch(`/api/nutrition/plans/${id}/rename`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name: name.trim() }) });
      }
      const current = await fetch('/api/nutrition/plan', { headers: authHeaders() });
      if (current.ok) renderNutrition(await current.json());
      await loadNutritionPlans();
    };
  });
}

function renderNutrition(data) {
  const out = $('nutrition-output'); if (!out) return;
  const emojiByMeal = { 'Café Da Manhã': '☀️', 'Almoço': '🍛', 'Lanche': '🥪', 'Jantar': '🌙' };

  const meals = (data.meals || []).map(m => {
    const mealName = cap(String(m.meal || 'Refeição'));
    const items = Array.isArray(m.items) ? m.items : [];
    const mealCalories = m.calories || Math.round((data.calories || 0) / Math.max(1, (data.meals || []).length || 4));
    return `<div class="day"><div class="meal-head"><strong>${emojiByMeal[mealName] || '🍽️'} ${mealName}</strong><span>${mealCalories} kcal • P ${m.protein_g || 0}g • C ${m.carbs_g || 0}g • G ${m.fat_g || 0}g</span></div><ul class="meal-list">${items.map(i => `<li>${cap(i.label)} <small>(${i.calories || 0} kcal • P ${i.protein_g || 0}g • C ${i.carbs_g || 0}g • G ${i.fat_g || 0}g)</small></li>`).join('')}</ul></div>`;
  }).join('');

  out.innerHTML = `<div class="day"><strong>${data.name || 'Plano alimentar'}</strong><br/><strong>Meta diária:</strong> ${data.calories || data.calories} kcal • P ${data.protein_g || data.macros?.protein_g}g • C ${data.carbs_g || data.macros?.carbs_g}g • G ${data.fat_g || data.macros?.fat_g}g</div>${meals}`;
}

async function initLogin() {
  if (state.token) {
    const meRes = await fetch('/api/me', { headers: authHeaders() }).catch(() => null);
    if (meRes?.ok) return window.location.href = '/app.html';
    localStorage.removeItem('fitai_token');
    state.token = null;
  }
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
    const data = await res.json(); if (!res.ok) return setMsg('auth-msg', data.error || 'Erro de autenticação', true);
    localStorage.setItem('fitai_token', data.token); window.location.href = '/app.html';
  });
}
async function initRegister() {
  $('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('name').value, email: $('email').value, password: $('password').value }) });
    const data = await res.json(); if (!res.ok) return setMsg('auth-msg', data.error || 'Erro no cadastro', true);
    localStorage.setItem('fitai_token', data.token); window.location.href = '/app.html';
  });
}

async function sendTrainingAi() {
  if (!state.subscriptionActive) return setMsg('checkin-msg', featureGate('a IA de treino'), true);
  const msg = $('ai-chat-input').value.trim(); if (!msg) return;
  addAiLog('Você', msg); $('ai-chat-input').value = '';

  const normalizedMsg = normalize(msg);
  if ((normalizedMsg.includes('no lugar da flexao') || normalizedMsg.includes('substituir flexao') || normalizedMsg.includes('trocar flexao')) && !normalizedMsg.includes('confirme')) {
    return addAiLog('IA', 'Sim, faz total sentido substituir. Opções equivalentes: 1) Supino com halteres (3-4x8-12), 2) Flexão inclinada (3x10-15), 3) Crucifixo no chão (3x12-15). Escolha conforme equipamento e dor articular.');
  }

  if (state.aiPendingConfirm && /^confirme$/i.test(msg) && state.aiSuggestedPlan) {
    const targetId = state.aiTargetWorkoutId || state.currentWorkout?.id;
    if (!targetId) return addAiLog('IA', 'Escolha um treino no seletor para eu aplicar o ajuste.');
    const current = state.workoutCache.find(w => w.id === targetId);
    const split = current?.split_name || state.currentWorkout?.split_name || 'Full Body';
    const resApply = await fetch(`/api/workouts/${targetId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ split_name: split, plan: state.aiSuggestedPlan }) });
    if (resApply.ok) {
      await fetch(`/api/workouts/${targetId}/activate`, { method: 'POST', headers: authHeaders() });
      addAiLog('IA', 'Treino atualizado com sucesso.');
      setMsg('update-msg', 'Treino atualizado com sucesso.');
      state.aiPendingConfirm = false; state.aiSuggestedPlan = null;
      await loadWorkoutList();
      return;
    }
  }

  const payload = { message: msg };
  if (state.aiTargetWorkoutId) payload.workout_id = state.aiTargetWorkoutId;
  if (!payload.workout_id && state.currentWorkout?.id) payload.workout_id = state.currentWorkout.id;

  const res = await fetch('/api/ai/checkin-feedback', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) return addAiLog('IA', data.error || 'Não consegui processar agora.');

  state.aiSuggestedPlan = data.suggestedPlan || null;
  if (state.aiSuggestedPlan) {
    state.aiPendingConfirm = true;
    state.aiPendingMeta = data.summary || 'o treino';
    addAiLog('IA', `Irei atualizar então ${state.aiPendingMeta}. Digite confirme para confirmar.`);
  } else {
    addAiLog('IA', data.aiReply || 'Posso tirar dúvidas de execução, progressão e recuperação.');
  }
}

async function sendNutritionAi() {
  if (!state.subscriptionActive || state.subscription?.package_code !== 'plan_pro') return setMsg('nutrition-msg', featureGate('a IA de dieta'), true);
  const q = $('nutrition-chat-input').value.trim();
  if (!q) return;
  addAiLog('Você', q, 'nutrition-chat-log');
  $('nutrition-chat-input').value = '';
  const res = await fetch('/api/ai/nutrition-chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: q }) });
  const data = await res.json();
  addAiLog('IA', res.ok ? data.aiReply : (data.error || 'Falha'), 'nutrition-chat-log');
}

function renderLive() {
  const out = $('live-output');
  if (!out) return;
  if (!state.liveSequence.length) return out.innerHTML = 'Abra um treino para iniciar o modo treino.';
  const cur = state.liveSequence[state.liveIndex];
  const warm = state.liveIndex === 0 ? 1 : 0;
  const rec = 1;
  const work = Math.max(1, Number(cur.sets || 3) - warm - rec);
  const restMatch = String(cur.rest || '').match(/(\d+)/);
  state.timer.sec = restMatch ? Number(restMatch[1]) : 60;
  $('rest-time').textContent = `00:${String(state.timer.sec).padStart(2, '0')}`;
  const checks = [];
  for (let i = 1; i <= warm; i++) checks.push(`<label><input type="checkbox"/> Aquecimento ${i}: 15-20 reps, carga leve, RIR 4+</label>`);
  for (let i = 1; i <= rec; i++) checks.push(`<label><input type="checkbox"/> Reconhecimento ${i}: <10 reps, sem falhar, RIR 2-3</label>`);
  for (let i = 1; i <= work; i++) checks.push(`<label class="check-row"><input type="checkbox"/> Trabalho ${i}: ${cur.reps} reps, próximo da falha</label>`);

  out.innerHTML = `<strong>${cur.day} • ${cur.name}</strong><p>Descanso recomendado: ${cur.rest} • Tempo sugerido: ${cur.estimated_seconds || 90}s</p><div class="checklist">${checks.join('<br/>')}</div>`;
}

function renderLiveFromDay(dayPlan) {
  state.liveSequence = (dayPlan.exercises || []).map(ex => ({ day: dayPlan.day, intensity: dayPlan.intensity, ...ex }));
  state.liveIndex = 0;
  renderLive();
}

function bindEnterBehavior(el, sendFn) {
  el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.ctrlKey) {
      e.preventDefault();
      sendFn();
    }
  });
}

async function loadCheckinHistory() {
  const box = $('checkin-history');
  if (!box) return;
  const res = await fetch('/api/progress', { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  const recent = (data.checkins || []).slice(0, 5);
  box.innerHTML = `<strong>Últimos check-ins</strong>${recent.length ? recent.map(c => `<p>${c.week_label} • ${c.completed_percent}% • ${c.notes || 'sem observações'}</p>`).join('') : '<p>Nenhum check-in salvo ainda.</p>'}`;
}

async function initApp() {
  await routeApp();
  $('btn-logout').onclick = () => { localStorage.removeItem('fitai_token'); window.location.href = '/'; };
  $('btn-user').onclick = async () => {
    const me = await fetch('/api/me', { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
    const profile = await fetch('/api/profile', { headers: authHeaders() }).then(r => r.ok ? r.json() : { profile: null }).catch(() => ({ profile: null }));
    const activeDay = state.currentWorkout?.plan?.[0];
    const objective = activeDay?.focus || profile.profile?.objective;
    const days = state.currentWorkout?.plan?.length || profile.profile?.days_per_week;
    const weight = profile.profile?.weight;
    $('user-modal-content').innerHTML = `<form id="user-basic-form" class="grid"><label>Nome<input id="edit-name" value="${me.user?.name || ''}" required /></label><label>Email<input id="edit-email" type="email" value="${me.user?.email || ''}" required /></label><label>Peso (kg)<input id="edit-weight" type="number" min="1" step="1" value="${weight || ''}" /></label><p><strong>Objetivo atual:</strong> ${objective || '-'}</p><p><strong>Dias/semana:</strong> ${days || '-'}</p><button class="btn neon" type="submit">Salvar dados</button></form><p id="user-edit-msg" class="msg"></p>`;
    $('user-modal').classList.remove('hidden');
    $('user-basic-form').onsubmit = async (e) => {
      e.preventDefault();
      const res = await fetch('/api/user/basic', { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ name: $('edit-name').value, email: $('edit-email').value, weight: Number($('edit-weight').value) || null }) });
      $('user-edit-msg').textContent = res.ok ? 'Dados atualizados.' : 'Falha ao salvar dados.';
    };
  };
  $('btn-close-user-modal').onclick = () => $('user-modal').classList.add('hidden');
  $('buy-12m').onclick = async () => doMockCheckout('plan_12m');
  $('buy-6m').onclick = async () => doMockCheckout('plan_6m');
  $('buy-pro').onclick = async () => doMockCheckout('plan_pro');
  $('btn-refresh-list').onclick = loadWorkoutList;
  $('btn-close-dashboard').onclick = () => $('dashboard-section').classList.add('hidden');
  $('btn-refresh').onclick = fetchCurrentWorkout;
  $('btn-rename').onclick = () => state.currentWorkout?.id && window.renameWorkout(state.currentWorkout.id, state.currentWorkout.name);

  $('tab-training').onclick = () => setTab('training');
  $('tab-nutrition').onclick = () => setTab('nutrition');
  $('tab-schedule').onclick = () => { setTab('schedule'); renderSchedule(); };

  $('btn-create-workout').onclick = async () => {
    const res = await fetch('/api/workouts/create', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: $('new-workout-name').value.trim() }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg('checkin-msg', data.error || featureGate('criar mais treinos'), true);
    $('new-workout-name').value = '';
    $('onboarding-form')?.reset();
    $('onboarding-section')?.classList.remove('hidden');
    await loadWorkoutList();
  };

  $('onboarding-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = { objective: $('objective').value || 'hipertrofia', experience_level: $('experience_level').value || 'iniciante', days_per_week: Number($('days_per_week').value), time_per_session: Number($('time_per_session').value), equipment: $('equipment').value || 'casa', limitations: $('limitations').value, split_preference: $('split_preference').value };
    const res = await fetch('/api/onboarding', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) return setMsg('onboarding-msg', 'Erro no onboarding', true);
    setMsg('onboarding-msg', 'Perfil salvo e treino criado!'); $('onboarding-section').classList.add('hidden'); await loadWorkoutList();
  });

  $('btn-edit-text').onclick = () => {
    if (!state.subscriptionActive) return setMsg('checkin-msg', featureGate('edição manual'), true);
    if (!state.currentWorkout) return;
    $('plan-text-view').contentEditable = 'true'; $('btn-save-text').classList.remove('hidden'); $('btn-cancel-text').classList.remove('hidden');
  };
  $('btn-cancel-text').onclick = () => { if (!state.currentWorkout) return; $('plan-text-view').textContent = formatPlanAsText(state.currentWorkout.plan); $('plan-text-view').contentEditable = 'false'; $('btn-save-text').classList.add('hidden'); $('btn-cancel-text').classList.add('hidden'); };
  $('btn-save-text').onclick = async () => {
    if (!state.subscriptionActive || !state.currentWorkout) return setMsg('checkin-msg', featureGate('salvar ajustes'), true);
    const parsed = parseTextToPlan($('plan-text-view').innerText || '');
    const res = await fetch(`/api/workouts/${state.currentWorkout.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ split_name: state.currentWorkout.split_name, plan: parsed }) });
    if (!res.ok) return setMsg('checkin-msg', 'Erro ao salvar ajustes', true);
    setMsg('checkin-msg', 'Ajustes salvos com sucesso.'); await openWorkout(state.currentWorkout.id);
  };

  $('checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!state.subscriptionActive || !state.currentWorkout?.id) return setMsg('checkin-msg', featureGate('check-in e ajuste automático'), true);
    const weekLabel = getCurrentWeekLabel();
    const timesTrained = Number($('times_trained').value);
    const expected = Math.max(1, state.profileDaysPerWeek || state.currentWorkout.plan.length || 3);
    const completedPercent = Math.min(100, Math.round((timesTrained / expected) * 100));
    const payload = { workout_id: state.currentWorkout.id, week_label: weekLabel, times_trained: timesTrained, completed_percent: completedPercent, difficulty: Number($('difficulty').value), energy: Number($('energy').value), pain: Number($('pain').value), notes: $('notes').value };
    const res = await fetch('/api/workouts/checkin', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro no check-in', true);
    setMsg('checkin-msg', `Check-in salvo (${weekLabel}) e treino recalibrado!`);
    if (data.feedback) addAiLog('IA', data.feedback);
    await openWorkout(state.currentWorkout.id); await loadWorkoutList();
    await loadCheckinHistory();
  });

  $('ai-workout-target').onchange = () => { state.aiTargetWorkoutId = $('ai-workout-target').value ? Number($('ai-workout-target').value) : null; };
  $('btn-ai-send').onclick = sendTrainingAi;

  $('nut-has-routine').onchange = () => $('nut-routine').classList.toggle('hidden', $('nut-has-routine').value !== 'sim');
  $('nut-use-whey').onchange = () => $('nut-whey-meal').classList.toggle('hidden', $('nut-use-whey').value !== 'sim');

  $('nutrition-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.subscriptionActive || state.subscription?.package_code !== 'plan_pro') {
      return setMsg('nutrition-msg', 'Plano de dieta é exclusivo do FitAI Pro.', true);
    }
    const weight = parseInt(String($('nut-weight').value || '').replace(',', '.'), 10);
    const height = parseInt(String($('nut-height').value || '').replace(',', '.'), 10);
    const age = parseInt(String($('nut-age').value || '').replace(',', '.'), 10);
    if (weight <= 0 || height < 100 || age <= 0) return setMsg('nutrition-msg', 'Preencha peso/altura/idade com valores válidos.', true);
    const payload = {
      name: $('nut-name').value.trim() || 'Plano alimentar',
      objective: $('nut-objective').value,
      weight,
      height,
      age,
      sex: $('nut-sex').value,
      activity_level: $('nut-activity').value,
      routine_notes: $('nut-has-routine').value === 'sim' ? $('nut-routine').value : '',
      allergies: $('nut-allergies').value,
      disliked_foods: $('nut-dislikes').value,
      meals_count: Number($('nut-meals-count').value),
      use_whey: $('nut-use-whey').value === 'sim',
      whey_meal: $('nut-whey-meal').value
    };

    await fetch('/api/profile/diet', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        weight: payload.weight,
        height: payload.height,
        age: payload.age,
        sex_biological: payload.sex,
        activity_level: payload.activity_level,
        allergies: payload.allergies,
        disliked_foods: payload.disliked_foods,
        routine_notes: payload.routine_notes
      })
    });

    const res = await fetch('/api/nutrition/plan', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return setMsg('nutrition-msg', data.error || 'Erro ao gerar dieta', true);
    setMsg('nutrition-msg', 'Plano alimentar gerado com sucesso!');
    renderNutrition(data);
    await loadNutritionPlans();
  });

  $('btn-pdf').onclick = async () => {
    if (!state.subscriptionActive) return setMsg('checkin-msg', featureGate('exportação em PDF'), true);
    const url = state.currentWorkout?.id ? `/api/export/pdf?workoutId=${state.currentWorkout.id}` : '/api/export/pdf';
    const res = await fetch(url, { headers: authHeaders() }); if (!res.ok) return setMsg('checkin-msg', 'Erro ao exportar PDF', true);
    const blob = await res.blob(); const ub = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = ub; a.download = `treino-fitai-${new Date().toISOString().slice(0,10)}.pdf`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(ub);
  };

  $('btn-nutrition-chat').onclick = sendNutritionAi;
  bindEnterBehavior($('ai-chat-input'), sendTrainingAi);
  bindEnterBehavior($('nutrition-chat-input'), sendNutritionAi);

  $('btn-exit-live').onclick = () => { $('live-training').classList.add('hidden'); $('live-output').innerHTML = 'Modo treino pausado. Seu treino permanece salvo.'; };
  $('btn-next-ex').onclick = () => { if (!state.liveSequence.length) return; state.liveIndex = Math.min(state.liveSequence.length - 1, state.liveIndex + 1); renderLive(); };
  $('btn-prev-ex').onclick = () => { if (!state.liveSequence.length) return; state.liveIndex = Math.max(0, state.liveIndex - 1); renderLive(); };

  $('btn-toggle-timer').onclick = () => $('rest-timer').classList.toggle('hidden');
  $('btn-start-timer').onclick = () => {
    if (state.timer.id) { clearInterval(state.timer.id); state.timer.id = null; return; }
    state.timer.id = setInterval(() => {
      state.timer.sec = Math.max(0, state.timer.sec - 1);
      const mm = String(Math.floor(state.timer.sec / 60)).padStart(2, '0');
      const ss = String(state.timer.sec % 60).padStart(2, '0');
      $('rest-time').textContent = `${mm}:${ss}`;
      if (state.timer.sec === 0) {
        clearInterval(state.timer.id);
        state.timer.id = null;
      }
    }, 1000);
  };
  $('btn-reset-timer').onclick = () => { $('rest-time').textContent = '01:00'; state.timer.sec = 60; if (state.timer.id) { clearInterval(state.timer.id); state.timer.id = null; } };

  $('btn-close-modal').onclick = () => { $('exercise-modal').classList.add('hidden'); $('exercise-frame').src = ''; };
  $('btn-close-schedule-modal').onclick = () => $('schedule-modal').classList.add('hidden');
  $('exercise-modal').onclick = (e) => { if (e.target.id === 'exercise-modal') { $('exercise-modal').classList.add('hidden'); $('exercise-frame').src = ''; } };
  $('schedule-modal').onclick = (e) => { if (e.target.id === 'schedule-modal') $('schedule-modal').classList.add('hidden'); };
}

bindShared();
if (page === 'login') initLogin();
if (page === 'register') initRegister();
if (page === 'app') initApp();
