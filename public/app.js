const state = {
  token: localStorage.getItem('fitai_token') || null,
  mode: 'login',
  theme: localStorage.getItem('fitai_theme') || 'light',
  currentWorkout: null,
  subscriptionActive: false,
  subscription: null,
  demoMode: false,
  aiSuggestedPlan: null
};

const $ = (id) => document.getElementById(id);

function setMsg(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#ff6b6b' : 'var(--accent)';
}

function authHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${state.token}` };
}

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('fitai_theme', theme);
  $('theme-toggle').textContent = theme === 'dark' ? '☀️ Light' : '🌙 Dark';
}

function hideAllPrivate() {
  $('billing-section').classList.add('hidden');
  $('onboarding-section').classList.add('hidden');
  $('dashboard-section').classList.add('hidden');
}

function renderSubscriptionStatus() {
  const el = $('subscription-status');
  if (!el) return;
  if (!state.subscription || state.subscription.status !== 'active') {
    el.textContent = 'Sem assinatura ativa (modo demonstração).';
    return;
  }
  const label = state.subscription.package_code === 'plan_12m' ? '12 meses (R$99/mês)' : '6 meses (R$119/mês)';
  const end = state.subscription.ends_at ? new Date(state.subscription.ends_at).toLocaleDateString('pt-BR') : '—';
  el.textContent = `Plano atual: ${label} • ativo até ${end}`;
}

function openAuth(mode = 'login') {
  state.mode = mode;
  $('landing-section').classList.add('hidden');
  $('auth-section').classList.remove('hidden');
  $('tab-login').classList.toggle('active', mode === 'login');
  $('tab-register').classList.toggle('active', mode === 'register');
  $('name').classList.toggle('hidden', mode !== 'register');
  $('auth-form').querySelector('button').textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
}

function formatPlanAsText(plan) {
  return (plan || []).map(day => {
    const lines = [
      `${day.day} | ${day.focus} | ${day.intensity}`,
      ...(day.exercises || []).map(ex => `- ${ex.name} | ${ex.sets}x${ex.reps} | ${ex.rest}`)
    ];
    return lines.join('\n');
  }).join('\n\n');
}

function parseTextToPlan(text) {
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const [head, ...exerciseLines] = lines;
    const [day = 'Dia', focus = 'Full Body', intensity = 'RIR 2-3'] = head.split('|').map(s => s.trim());

    const exercises = exerciseLines
      .filter(l => l.startsWith('-'))
      .map(l => l.replace(/^-\s*/, ''))
      .map(l => {
        const [name = 'Exercício', sr = '3x10', rest = '60-90s'] = l.split('|').map(s => s.trim());
        const [sets = '3', reps = '10'] = sr.toLowerCase().split('x').map(s => s.trim());
        return { name, sets: Number(sets) || 3, reps, rest };
      });

    return { day, focus, intensity, exercises };
  });
}

function renderWorkout(workout) {
  state.currentWorkout = workout;
  const output = $('workout-output');
  const textView = $('plan-text-view');
  if (!workout?.plan?.length) {
    output.innerHTML = '<p>Sem treino ativo.</p>';
    textView.textContent = '';
    textView.contentEditable = 'false';
    return;
  }

  output.innerHTML = `
    <p><strong>${workout.name}</strong> • v${workout.version} • Split: ${workout.split_name}</p>
    ${workout.plan.map(day => `
      <div class="day">
        <strong>${day.day} — ${day.focus}</strong><br/>
        <small>${day.intensity}</small>
        <ul>${(day.exercises || []).map(ex => `<li>${ex.name}: ${ex.sets}x${ex.reps} (${ex.rest})</li>`).join('')}</ul>
      </div>
    `).join('')}
  `;

  textView.textContent = formatPlanAsText(workout.plan);
  textView.contentEditable = 'false';
  $('ai-chat-log').innerHTML = '';
  state.aiSuggestedPlan = null;
  $('btn-save-text').classList.add('hidden');
  $('btn-cancel-text').classList.add('hidden');
}

async function fetchCurrentWorkout() {
  const res = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (!res.ok) {
    renderWorkout(null);
    return;
  }
  const data = await res.json();
  renderWorkout(data);
}

async function loadWorkoutList() {
  const res = await fetch('/api/workouts', { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  const list = $('workout-list');
  if (!data.workouts.length) {
    list.innerHTML = '<p>Nenhum treino criado ainda.</p>';
    return;
  }

  list.innerHTML = data.workouts.map(w => `
    <div class="day">
      <strong>${w.name}</strong> • v${w.version} • ${w.split_name} ${w.is_active ? '✅ ativo' : ''}
      <div class="actions">
        <button class="btn" onclick="activateWorkout(${w.id})">Ativar</button>
        <button class="btn" onclick="openWorkout(${w.id})">Abrir</button>
      </div>
    </div>
  `).join('');
}

window.activateWorkout = async (id) => {
  await fetch(`/api/workouts/${id}/activate`, { method: 'POST', headers: authHeaders() });
  await loadWorkoutList();
  await fetchCurrentWorkout();
};

window.openWorkout = async (id) => {
  const res = await fetch(`/api/workouts/${id}`, { headers: authHeaders() });
  if (!res.ok) return;
  const data = await res.json();
  renderWorkout(data);
};

async function routeAfterAuth() {
  $('landing-section').classList.add('hidden');
  $('auth-section').classList.add('hidden');
  $('btn-logout').classList.remove('hidden');

  const meRes = await fetch('/api/me', { headers: authHeaders() });
  if (!meRes.ok) {
    localStorage.removeItem('fitai_token');
    state.token = null;
    $('landing-section').classList.remove('hidden');
    $('btn-logout').classList.add('hidden');
    return;
  }

  const me = await meRes.json();
  state.subscription = me.subscription || null;
  state.subscriptionActive = me.subscription?.status === 'active';
  state.demoMode = !state.subscriptionActive;

  hideAllPrivate();

  if (state.demoMode) {
    $('dashboard-section').classList.remove('hidden');
    $('demo-banner').classList.remove('hidden');
    $('billing-section').classList.remove('hidden');
    renderSubscriptionStatus();

    const workoutRes = await fetch('/api/workouts/current', { headers: authHeaders() });
    if (workoutRes.ok) {
      await fetchCurrentWorkout();
      await loadWorkoutList();
    } else {
      renderWorkout({
        id: null,
        name: 'Treino Demonstração',
        version: 1,
        split_name: 'Full Body',
        plan: [
          { day: 'Dia 1', focus: 'Full Body', intensity: 'RIR 2-3', exercises: [
            { name: 'Agachamento', sets: 3, reps: '10-12', rest: '60-90s' },
            { name: 'Supino reto', sets: 3, reps: '8-12', rest: '60-90s' },
            { name: 'Remada baixa', sets: 3, reps: '10-12', rest: '60-90s' }
          ] }
        ]
      });
      $('workout-list').innerHTML = '<p>Demonstração ativa. Assine para criar e salvar seus próprios treinos.</p>';
    }
    return;
  }

  $('demo-banner').classList.add('hidden');
  const workoutRes = await fetch('/api/workouts/current', { headers: authHeaders() });
  if (workoutRes.status === 404) {
    $('onboarding-section').classList.remove('hidden');
  } else {
    $('dashboard-section').classList.remove('hidden');
    renderSubscriptionStatus();
    await fetchCurrentWorkout();
    await loadWorkoutList();
  }
}

$('tab-login').onclick = () => openAuth('login');
$('tab-register').onclick = () => openAuth('register');
$('btn-open-login').onclick = () => openAuth('login');
$('btn-open-auth').onclick = () => openAuth('register');
$('theme-toggle').onclick = () => applyTheme(state.theme === 'dark' ? 'light' : 'dark');

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = { email: $('email').value, password: $('password').value };
  if (state.mode === 'register') payload.name = $('name').value || 'Usuário';

  const endpoint = state.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) return setMsg('auth-msg', data.error || 'Erro de autenticação', true);

  state.token = data.token;
  localStorage.setItem('fitai_token', state.token);
  setMsg('auth-msg', state.mode === 'register' ? 'Conta criada com sucesso!' : 'Autenticado com sucesso!');
  await routeAfterAuth();
});

function addAiLog(author, text) {
  const el = $('ai-chat-log');
  if (!el) return;
  const line = document.createElement('p');
  line.className = 'chat-msg';
  line.innerHTML = `<strong>${author}:</strong> ${text}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function requireSubscription() {
  if (!state.subscriptionActive) {
    setMsg('checkin-msg', 'Você está no modo demonstração. Assine um plano para liberar esta função.', true);
    return false;
  }
  return true;
}

async function doMockCheckout(packageCode, msgTarget = 'billing-msg') {
  const res = await fetch('/api/billing/mock-checkout', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ packageCode }) });
  const data = await res.json();
  if (!res.ok) return setMsg(msgTarget, data.error || 'Falha no pagamento simulado', true);
  setMsg(msgTarget, 'Pagamento simulado aprovado! Assinatura ativa.');
  await routeAfterAuth();
}

$('buy-12m').onclick = async () => doMockCheckout('plan_12m', 'billing-msg');
$('buy-6m').onclick = async () => doMockCheckout('plan_6m', 'billing-msg');
$('btn-change-to-12m').onclick = async () => doMockCheckout('plan_12m', 'billing-msg-dashboard');

$('onboarding-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireSubscription()) return;
  const payload = {
    objective: $('objective').value,
    experience_level: $('experience_level').value,
    days_per_week: Number($('days_per_week').value),
    time_per_session: Number($('time_per_session').value),
    equipment: $('equipment').value,
    limitations: $('limitations').value,
    split_preference: $('split_preference').value
  };

  const res = await fetch('/api/onboarding', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) return setMsg('onboarding-msg', data.error || 'Erro no onboarding', true);

  setMsg('onboarding-msg', 'Perfil salvo e treino criado!');
  $('onboarding-section').classList.add('hidden');
  $('dashboard-section').classList.remove('hidden');
  await loadWorkoutList();
  await fetchCurrentWorkout();
});

$('btn-create-workout').onclick = async () => {
  if (!requireSubscription()) return;
  const name = $('new-workout-name').value.trim();
  const res = await fetch('/api/workouts/create', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ name }) });
  const data = await res.json();
  if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro ao criar treino', true);
  $('new-workout-name').value = '';
  await loadWorkoutList();
  await fetchCurrentWorkout();
};

$('btn-refresh-list').onclick = loadWorkoutList;
$('btn-refresh').onclick = fetchCurrentWorkout;

$('btn-rename').onclick = async () => {
  if (!requireSubscription()) return;
  if (!state.currentWorkout) return;
  const newName = prompt('Novo nome do treino:', state.currentWorkout.name || 'Meu treino');
  if (!newName) return;
  const res = await fetch(`/api/workouts/${state.currentWorkout.id}/rename`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ name: newName }) });
  const data = await res.json();
  if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro ao renomear', true);
  await loadWorkoutList();
  await fetchCurrentWorkout();
};

$('btn-edit-text').onclick = () => {
  if (!state.currentWorkout) return;
  const textView = $('plan-text-view');
  textView.contentEditable = 'true';
  textView.focus();
  textView.style.outline = '2px solid var(--primary)';
  $('btn-save-text').classList.remove('hidden');
  $('btn-cancel-text').classList.remove('hidden');
};

$('btn-cancel-text').onclick = () => {
  if (!state.currentWorkout) return;
  const textView = $('plan-text-view');
  textView.textContent = formatPlanAsText(state.currentWorkout.plan);
  textView.contentEditable = 'false';
  textView.style.outline = 'none';
  $('btn-save-text').classList.add('hidden');
  $('btn-cancel-text').classList.add('hidden');
};

$('btn-save-text').onclick = async () => {
  try {
    if (!requireSubscription()) return;
    if (!state.currentWorkout) return;
    const parsed = parseTextToPlan($('plan-text-view').innerText || '');
    if (!parsed.length) return setMsg('checkin-msg', 'Texto vazio ou inválido', true);

    const res = await fetch(`/api/workouts/${state.currentWorkout.id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ split_name: state.currentWorkout.split_name, plan: parsed })
    });
    const data = await res.json();
    if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro ao salvar ajustes', true);

    const textView = $('plan-text-view');
    textView.contentEditable = 'false';
    textView.style.outline = 'none';
    $('btn-save-text').classList.add('hidden');
    $('btn-cancel-text').classList.add('hidden');

    setMsg('checkin-msg', 'Ajustes em texto salvos com sucesso!');
    await fetchCurrentWorkout();
  } catch {
    setMsg('checkin-msg', 'Formato inválido. Use o padrão das linhas existentes.', true);
  }
};

$('checkin-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireSubscription()) return;
  const payload = {
    workout_id: state.currentWorkout?.id,
    week_label: $('week_label').value,
    completed_percent: Number($('completed_percent').value),
    difficulty: Number($('difficulty').value),
    energy: Number($('energy').value),
    pain: Number($('pain').value),
    notes: $('notes').value
  };

  const res = await fetch('/api/workouts/checkin', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro no check-in', true);

  setMsg('checkin-msg', 'Check-in aplicado e treino recalibrado!');
  await fetchCurrentWorkout();
  await loadWorkoutList();
});

$('btn-ai-send').onclick = async () => {
  if (!requireSubscription()) return;
  if (!state.currentWorkout?.id) return setMsg('checkin-msg', 'Abra um treino ativo para conversar com a IA.', true);
  const input = $('ai-chat-input');
  const message = (input.value || '').trim();
  if (!message) return;

  addAiLog('Você', message);
  input.value = '';
  addAiLog('IA', 'Analisando seu feedback...');

  try {
    const res = await fetch('/api/ai/checkin-feedback', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ workout_id: state.currentWorkout.id, message })
    });
    const data = await res.json();

    const log = $('ai-chat-log');
    if (log.lastChild) log.removeChild(log.lastChild);

    if (!res.ok) {
      state.aiSuggestedPlan = null;
      return addAiLog('IA', data.error || 'Não consegui processar seu feedback agora.');
    }

    state.aiSuggestedPlan = data.suggestedPlan || null;
    addAiLog('IA', data.aiReply || 'Sugestão pronta para aplicar.');
  } catch {
    const log = $('ai-chat-log');
    if (log.lastChild) log.removeChild(log.lastChild);
    state.aiSuggestedPlan = null;
    addAiLog('IA', 'Falha de conexão no momento. Tente novamente em instantes.');
  }
};

$('btn-ai-apply').onclick = async () => {
  if (!requireSubscription()) return;
  if (!state.currentWorkout?.id || !state.aiSuggestedPlan) {
    return setMsg('checkin-msg', 'Envie feedback para a IA antes de aplicar.', true);
  }

  const res = await fetch(`/api/workouts/${state.currentWorkout.id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ split_name: state.currentWorkout.split_name, plan: state.aiSuggestedPlan })
  });
  const data = await res.json();
  if (!res.ok) return setMsg('checkin-msg', data.error || 'Erro ao aplicar sugestão da IA', true);

  setMsg('checkin-msg', 'Sugestão da IA aplicada ao treino!');
  state.aiSuggestedPlan = null;
  await fetchCurrentWorkout();
};

$('btn-pdf').onclick = async () => {
  try {
    if (!requireSubscription()) return;
    const urlBase = '/api/export/pdf';
    const url = state.currentWorkout?.id ? `${urlBase}?workoutId=${state.currentWorkout.id}` : urlBase;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return setMsg('checkin-msg', err.error || 'Não foi possível exportar PDF', true);
    }
    const blob = await res.blob();
    const urlBlob = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = urlBlob;
    a.download = `treino-fitai-${new Date().toISOString().slice(0,10)}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(urlBlob);
    setMsg('checkin-msg', 'PDF exportado com sucesso!');
  } catch {
    setMsg('checkin-msg', 'Erro ao exportar PDF', true);
  }
};

$('btn-logout').onclick = () => {
  localStorage.removeItem('fitai_token');
  state.token = null;
  state.currentWorkout = null;
  $('workout-output').innerHTML = '';
  $('plan-text-view').textContent = '';
  $('landing-section').classList.remove('hidden');
  $('auth-section').classList.add('hidden');
  hideAllPrivate();
  $('btn-logout').classList.add('hidden');
};

(async function bootstrap() {
  applyTheme(state.theme);
  $('name').classList.add('hidden');

  if (!state.token) {
    $('landing-section').classList.remove('hidden');
    $('auth-section').classList.add('hidden');
    hideAllPrivate();
    return;
  }

  await routeAfterAuth();
})();
