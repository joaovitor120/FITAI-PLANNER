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
  workoutCache: [],
  liveSequence: [],
  liveIndex: 0
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
  const labels = { plan_12m: '12 meses (R$99/mês)', plan_6m: '6 meses (R$119/mês)', plan_super: 'FitAI Super (R$149/mês)' };
  const end = state.subscription.ends_at ? new Date(state.subscription.ends_at).toLocaleDateString('pt-BR') : '—';
  el.textContent = `Plano atual: ${labels[state.subscription.package_code] || state.subscription.package_code} • ativo até ${end}`;
}

function addAiLog(author, text) {
  const el = $('ai-chat-log'); if (!el) return;
  const line = document.createElement('p'); line.className = 'chat-msg'; line.innerHTML = `<strong>${author}:</strong> ${text}`;
  el.appendChild(line); el.scrollTop = el.scrollHeight;
}

function formatPlanAsText(plan) {
  return (plan || []).map(day => [`${day.day} | ${day.focus} | ${day.intensity}`,...(day.exercises || []).map(ex => `- ${ex.name} | ${ex.sets}x${ex.reps} | ${ex.rest}`)].join('\n')).join('\n\n');
}

function normalize(v=''){ return v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
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
    const fallback = `https://www.youtube.com/results?search_query=${encodeURIComponent(name + ' leandro twin')}`;
    $('exercise-modal-title').textContent = `${name} (fallback)`;
    $('exercise-frame').src = fallback;
    $('exercise-open-new').href = fallback;
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
  $('workout-output').innerHTML = `<p><strong>${workout.name}</strong> • v${workout.version} • Split: ${workout.split_name}</p>` + workout.plan.map(day => `
  <div class="day"><strong>${day.day} — ${day.focus}</strong><br/><small>${day.intensity}</small><ul>
  ${(day.exercises || []).map(ex => `<li>${ex.name}: ${ex.sets}x${ex.reps} (${ex.rest}) <button class="btn btn-mini" onclick="openExercise('${String(ex.name).replace(/'/g, "\\'")}')">Ver execução</button></li>`).join('')}
  </ul></div>`).join('');
  $('plan-text-view').textContent = formatPlanAsText(workout.plan);
  $('plan-text-view').contentEditable = 'false';
  $('dashboard-section').classList.remove('hidden');
  $('live-training')?.classList.remove('hidden');
  state.liveSequence = (workout.plan || []).flatMap(d => (d.exercises || []).map(ex => ({ day: d.day, ...ex })));
  state.liveIndex = 0;
}

async function fetchCurrentWorkout() {
  const res = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (!res.ok) return;
  renderWorkout(await res.json());
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
  <div class="actions"><button class="btn" onclick="activateWorkout(${w.id})">Ativar</button><button class="btn" onclick="openWorkout(${w.id})">Abrir treino</button><button class="btn" onclick="renameWorkout(${w.id}, '${String(w.name).replace(/'/g, "\\'")}')">Renomear</button></div></div>`).join('');
}

window.activateWorkout = async (id) => { await fetch(`/api/workouts/${id}/activate`, { method: 'POST', headers: authHeaders() }); await loadWorkoutList(); };
window.openWorkout = async (id) => { const res = await fetch(`/api/workouts/${id}`, { headers: authHeaders() }); if (res.ok) renderWorkout(await res.json()); };
window.renameWorkout = async (id, oldName='Meu treino') => {
  const newName = prompt('Novo nome do treino:', oldName); if (!newName?.trim()) return;
  await fetch(`/api/workouts/${id}/rename`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name: newName.trim() }) });
  await loadWorkoutList(); if (state.currentWorkout?.id === id) await openWorkout(id);
};

function requireSubscription() {
  if (!state.subscriptionActive) { setMsg('checkin-msg', 'Você está no modo demonstração. Assine um plano para liberar essa função.', true); return false; }
  return true;
}
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

async function routeApp() {
  if (!state.token) return window.location.href = '/login.html';
  const meRes = await fetch('/api/me', { headers: authHeaders() });
  if (!meRes.ok) { localStorage.removeItem('fitai_token'); return window.location.href = '/login.html'; }
  const me = await meRes.json();
  state.subscription = me.subscription || null;
  state.subscriptionActive = me.subscription?.status === 'active';
  state.demoMode = !state.subscriptionActive;
  renderSubscriptionStatus();
  $('demo-banner')?.classList.toggle('hidden', !state.demoMode);

  const workoutRes = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (workoutRes.status === 404) $('onboarding-section')?.classList.remove('hidden'); else $('onboarding-section')?.classList.add('hidden');
  $('dashboard-section')?.classList.add('hidden');
  await loadWorkoutList();

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
}

function renderNutrition(data) {
  const out = $('nutrition-output'); if (!out) return;
  const emojiByMeal = { 'Café da manhã': '☀️', 'Almoço': '🍛', 'Lanche': '🥪', 'Jantar': '🌙' };

  const meals = (data.meals || []).map(m => {
    const items = Array.isArray(m.items)
      ? m.items
      : String(m.suggestion || '').split('+').map(i => ({ label: i.trim(), calories: null })).filter(i => i.label);

    const mealCalories = m.calories || Math.round((data.calories || 0) / 4);
    return `<div class="day"><div class="meal-head"><strong>${emojiByMeal[m.meal] || '🍽️'} ${m.meal}</strong><span>${mealCalories} kcal</span></div><ul class="meal-list">${items.map(i => `<li>${i.label}${i.calories ? ` <small>(${i.calories} kcal)</small>` : ''}</li>`).join('')}</ul></div>`;
  }).join('');

  out.innerHTML = `<div class="day"><strong>Meta diária:</strong> ${data.calories || data.calories} kcal • P ${data.protein_g || data.macros?.protein_g}g • C ${data.carbs_g || data.macros?.carbs_g}g • G ${data.fat_g || data.macros?.fat_g}g</div>${meals}`;
}

async function initLogin() {
  if (state.token) return window.location.href = '/app.html';
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

async function initApp() {
  await routeApp();
  $('btn-logout').onclick = () => { localStorage.removeItem('fitai_token'); window.location.href = '/'; };
  $('buy-12m').onclick = async () => doMockCheckout('plan_12m');
  $('buy-6m').onclick = async () => doMockCheckout('plan_6m');
  $('buy-super').onclick = async () => doMockCheckout('plan_super');
  $('btn-refresh-list').onclick = loadWorkoutList;
  $('btn-close-dashboard').onclick = () => $('dashboard-section').classList.add('hidden');
  $('btn-refresh').onclick = fetchCurrentWorkout;
  $('btn-rename').onclick = () => state.currentWorkout?.id && window.renameWorkout(state.currentWorkout.id, state.currentWorkout.name);

  $('tab-training').onclick = () => { $('tab-training').classList.add('active'); $('tab-nutrition').classList.remove('active'); $('panel-training').classList.remove('hidden'); $('panel-nutrition').classList.add('hidden'); };
  $('tab-nutrition').onclick = () => { $('tab-nutrition').classList.add('active'); $('tab-training').classList.remove('active'); $('panel-nutrition').classList.remove('hidden'); $('panel-training').classList.add('hidden'); };

  $('btn-create-workout').onclick = async () => {
    if (!requireSubscription()) return;
    const res = await fetch('/api/workouts/create', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name: $('new-workout-name').value.trim() }) });
    if (res.ok) { $('new-workout-name').value = ''; await loadWorkoutList(); }
  };

  $('onboarding-form')?.addEventListener('submit', async (e) => {
    e.preventDefault(); if (!requireSubscription()) return;
    const payload = { objective: $('objective').value, experience_level: $('experience_level').value, days_per_week: Number($('days_per_week').value), time_per_session: Number($('time_per_session').value), equipment: $('equipment').value, limitations: $('limitations').value, split_preference: $('split_preference').value };
    const res = await fetch('/api/onboarding', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) return setMsg('onboarding-msg', 'Erro no onboarding', true);
    setMsg('onboarding-msg', 'Perfil salvo e treino criado!'); $('onboarding-section').classList.add('hidden'); await loadWorkoutList();
  });

  $('btn-edit-text').onclick = () => { if (!state.currentWorkout) return; $('plan-text-view').contentEditable = 'true'; $('btn-save-text').classList.remove('hidden'); $('btn-cancel-text').classList.remove('hidden'); };
  $('btn-cancel-text').onclick = () => { if (!state.currentWorkout) return; $('plan-text-view').textContent = formatPlanAsText(state.currentWorkout.plan); $('plan-text-view').contentEditable = 'false'; $('btn-save-text').classList.add('hidden'); $('btn-cancel-text').classList.add('hidden'); };
  $('btn-save-text').onclick = async () => {
    if (!requireSubscription() || !state.currentWorkout) return;
    const parsed = parseTextToPlan($('plan-text-view').innerText || '');
    const res = await fetch(`/api/workouts/${state.currentWorkout.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ split_name: state.currentWorkout.split_name, plan: parsed }) });
    if (!res.ok) return setMsg('checkin-msg', 'Erro ao salvar ajustes', true);
    setMsg('checkin-msg', 'Ajustes salvos com sucesso.'); await openWorkout(state.currentWorkout.id);
  };

  $('checkin-form').addEventListener('submit', async (e) => {
    e.preventDefault(); if (!requireSubscription() || !state.currentWorkout?.id) return setMsg('checkin-msg', 'Abra um treino antes do check-in.', true);
    const payload = { workout_id: state.currentWorkout.id, week_label: $('week_label').value, completed_percent: Number($('completed_percent').value), difficulty: Number($('difficulty').value), energy: Number($('energy').value), pain: Number($('pain').value), notes: $('notes').value };
    const res = await fetch('/api/workouts/checkin', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    if (!res.ok) return setMsg('checkin-msg', 'Erro no check-in', true);
    setMsg('checkin-msg', 'Check-in aplicado e treino recalibrado!');
    addAiLog('IA', 'Recebi seu check-in e usei isso para recalibrar o plano. Pode mandar ajustes finos por mensagem.');
    await openWorkout(state.currentWorkout.id); await loadWorkoutList();
  });

  $('ai-workout-target').onchange = () => { state.aiTargetWorkoutId = $('ai-workout-target').value ? Number($('ai-workout-target').value) : null; };
  $('btn-ai-send').onclick = async () => {
    if (!requireSubscription()) return;
    const msg = $('ai-chat-input').value.trim(); if (!msg) return;
    addAiLog('Você', msg); $('ai-chat-input').value = '';

    if (state.aiPendingConfirm && /(confirmo|sim|pode aplicar)/i.test(msg) && state.aiSuggestedPlan) {
      const targetId = state.aiTargetWorkoutId || state.currentWorkout?.id;
      if (!targetId) return addAiLog('IA', 'Escolha um treino no seletor para eu aplicar o ajuste.');
      const current = state.workoutCache.find(w => w.id === targetId);
      const split = current?.split_name || state.currentWorkout?.split_name || 'Full Body';
      const resApply = await fetch(`/api/workouts/${targetId}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ split_name: split, plan: state.aiSuggestedPlan }) });
      if (resApply.ok) {
        await fetch(`/api/workouts/${targetId}/activate`, { method: 'POST', headers: authHeaders() });
        addAiLog('IA', 'Treino atualizado e definido como ativo. Clique em "Atualizar treino aberto" para carregar os ajustes.');
        state.aiPendingConfirm = false; state.aiSuggestedPlan = null;
        await loadWorkoutList();
        return;
      }
    }

    const payload = { message: msg };
    if (state.aiTargetWorkoutId) payload.workout_id = state.aiTargetWorkoutId;
    const byName = $('ai-workout-name').value.trim();
    if (byName) payload.workout_name = byName;
    if (!payload.workout_id && !payload.workout_name && state.currentWorkout?.id) payload.workout_id = state.currentWorkout.id;

    const res = await fetch('/api/ai/checkin-feedback', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return addAiLog('IA', data.error || 'Não consegui processar agora.');

    state.aiSuggestedPlan = data.suggestedPlan || null;
    if (state.aiSuggestedPlan) {
      state.aiPendingConfirm = true;
      addAiLog('IA', `${data.aiReply} Qual treino quer atualizar? Use o seletor ou nome. Quando estiver certo, responda "confirmo".`);
    } else {
      addAiLog('IA', data.aiReply || 'Posso tirar dúvidas de execução, progressão e recuperação.');
    }
  };

  $('nutrition-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.subscriptionActive || state.subscription?.package_code !== 'plan_super') {
      return setMsg('nutrition-msg', 'Plano de dieta é exclusivo do FitAI Super.', true);
    }
    const payload = {
      objective: $('nut-objective').value,
      weight: Number($('nut-weight').value),
      height: Number($('nut-height').value),
      age: Number($('nut-age').value),
      sex: $('nut-sex').value,
      activity_level: $('nut-activity').value,
      routine_notes: $('nut-routine').value,
      allergies: $('nut-allergies').value,
      disliked_foods: $('nut-dislikes').value
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
  });

  $('btn-pdf').onclick = async () => {
    if (!requireSubscription()) return;
    const url = state.currentWorkout?.id ? `/api/export/pdf?workoutId=${state.currentWorkout.id}` : '/api/export/pdf';
    const res = await fetch(url, { headers: authHeaders() }); if (!res.ok) return setMsg('checkin-msg', 'Erro ao exportar PDF', true);
    const blob = await res.blob(); const ub = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = ub; a.download = `treino-fitai-${new Date().toISOString().slice(0,10)}.pdf`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(ub);
  };

  $('btn-nutrition-chat').onclick = async () => {
    const q = $('nutrition-chat-input').value.trim();
    if (!q) return;
    const log = $('nutrition-chat-log');
    log.innerHTML += `<p class='chat-msg'><strong>Você:</strong> ${q}</p>`;
    $('nutrition-chat-input').value = '';
    const res = await fetch('/api/ai/nutrition-chat', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ message: q }) });
    const data = await res.json();
    log.innerHTML += `<p class='chat-msg'><strong>IA:</strong> ${res.ok ? data.aiReply : (data.error || 'Falha')}</p>`;
    log.scrollTop = log.scrollHeight;
  };

  function renderLive() {
    const out = $('live-output');
    if (!out) return;
    if (!state.liveSequence.length) return out.innerHTML = 'Abra um treino para iniciar o modo treino.';
    const cur = state.liveSequence[state.liveIndex];
    out.innerHTML = `<strong>${cur.day} • ${cur.name}</strong><p>Séries: ${cur.sets} | Reps: ${cur.reps} | Descanso: ${cur.rest} | Tempo sugerido: ${cur.estimated_seconds || 90}s</p>`;
  }
  $('btn-start-live').onclick = () => { state.liveIndex = 0; $('live-training')?.classList.remove('hidden'); renderLive(); };
  $('btn-prev-live').onclick = () => { if (!state.liveSequence.length) return; state.liveIndex = (state.liveIndex - 1 + state.liveSequence.length) % state.liveSequence.length; renderLive(); };
  $('btn-next-live').onclick = () => { if (!state.liveSequence.length) return; state.liveIndex = (state.liveIndex + 1) % state.liveSequence.length; renderLive(); };
  $('btn-exit-live').onclick = () => { $('live-training')?.classList.add('hidden'); };

  $('btn-close-modal').onclick = () => { $('exercise-modal').classList.add('hidden'); $('exercise-frame').src = ''; };
}

bindShared();
if (page === 'login') initLogin();
if (page === 'register') initRegister();
if (page === 'app') initApp();