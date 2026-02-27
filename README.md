# FitAI Planner (MVP SaaS)

Sistema web full-stack para geração de treinos personalizados com controle de assinatura (mock), onboarding inteligente, múltiplos treinos por usuário e exportação em PDF.

---

## 📌 Visão geral

O FitAI Planner resolve um problema simples: transformar dados do usuário (objetivo, nível, frequência, tempo e equipamentos) em um treino estruturado e ajustável.

Além disso, o sistema já inclui:
- fluxo de assinatura (simulado)
- bloqueio de uso sem plano ativo
- landing page de conversão
- modo claro/escuro
- experiência mobile-friendly

---

## ✅ Funcionalidades implementadas

### 1) Acesso e autenticação
- Login com JWT
- Sessão persistida no navegador via `localStorage`

### 2) Onboarding
- Objetivo: hipertrofia / emagrecimento / condicionamento
- Nível: iniciante / intermediário / avançado
- Dias por semana
- Tempo por sessão
- Equipamentos disponíveis
- Limitações físicas
- Preferência opcional de divisão:
  - automática
  - full body
  - upper/lower
  - push/pull/legs

### 3) Geração e gestão de treinos
- Geração automática baseada em regras
- Vários treinos por usuário
- Definição de treino ativo
- Renomear treino
- Ajuste manual via editor JSON
- Check-in semanal para recalibrar treino
- Exportação para PDF

### 4) Assinatura / pagamento (mock)
- Página separada de check-in de pagamento: `/checkin.html`
- Planos:
  - **12 meses por R$99/mês**
  - **6 meses por R$119/mês**
- API valida o pacote e ativa assinatura no banco (simulação de pagamento aprovado)

### 5) Landing e UX
- Landing com proposta de valor, planos e depoimentos
- Dark/Light theme
- UI responsiva para desktop e mobile

---

## 🧱 Stack técnica

### Backend
- Node.js
- Express
- SQLite3
- JWT (`jsonwebtoken`)
- Hash de senha com `bcryptjs`
- Geração de PDF com `pdfkit`

### Frontend
- HTML
- CSS
- JavaScript vanilla

### Banco de dados
Arquivo local: `fitai.db` (SQLite)

---

## 📁 Estrutura de pastas

```text
fitai-planner/
├─ public/
│  ├─ index.html        # Landing + login + app principal
│  ├─ checkin.html      # Página separada de check-in de pagamento
│  ├─ styles.css        # Estilos globais (light/dark + responsivo)
│  └─ app.js            # Lógica do frontend principal
├─ server.js            # API + regras de negócio + rotas
├─ package.json
├─ .env.example
└─ README.md
```

---

## 🔌 Endpoints principais

### Auth
- `POST /api/auth/register` *(a API suporta; fluxo público atual usa login)*
- `POST /api/auth/login`
- `GET /api/me`

### Billing (mock)
- `GET /api/billing/packages`
- `POST /api/billing/mock-checkout`

### Onboarding
- `POST /api/onboarding`

### Workouts
- `GET /api/workouts`
- `GET /api/workouts/current`
- `GET /api/workouts/:id`
- `POST /api/workouts/create`
- `POST /api/workouts/:id/activate`
- `PATCH /api/workouts/:id/rename`
- `PUT /api/workouts/:id` (ajuste manual)
- `POST /api/workouts/checkin`

### Outros
- `GET /api/progress`
- `GET /api/export/pdf?workoutId=<id>`

---

## 🧪 Como rodar no seu PC (passo a passo completo)

## Requisitos
1. **Node.js** instalado (recomendado 18+)
2. **npm** instalado
3. Terminal (PowerShell, CMD ou Bash)

Verifique:

```bash
node -v
npm -v
```

## 1) Clonar o repositório

```bash
git clone <URL_DO_REPOSITORIO>
cd fitai-planner
```

> Se você já estiver com os arquivos locais, só entre na pasta do projeto.

## 2) Instalar dependências

```bash
npm install
```

## 3) Configurar variáveis de ambiente

Crie o `.env` com base no exemplo:

### Windows (PowerShell)
```powershell
copy .env.example .env
```

### Linux/macOS
```bash
cp .env.example .env
```

Edite o arquivo `.env` e defina pelo menos:

```env
PORT=3000
JWT_SECRET=troque-por-uma-chave-forte
```

## 4) Rodar o projeto

```bash
npm start
```

Saída esperada:

```text
FitAI Planner rodando em http://localhost:3000
```

## 5) Acessar no navegador
- App principal: `http://localhost:3000`
- Página de pagamento (check-in): `http://localhost:3000/checkin.html`

---

## ☁️ Deploy grátis (Render)

Este projeto já está preparado com `render.yaml`.

### Passo a passo
1. Crie conta em https://render.com (pode usar seu e-mail).
2. Suba este projeto para um repositório GitHub.
3. No Render, clique em **New +** → **Blueprint**.
4. Conecte o repositório e confirme o deploy.
5. O Render vai ler `render.yaml` e publicar automaticamente.

### Observações
- Plano free pode “hibernar” por inatividade.
- Na primeira abertura após hibernação pode demorar alguns segundos.

---

## 🧭 Fluxo recomendado de teste

1. Entrar com usuário existente (ou criar pela API/register se necessário)
2. Ir em `/checkin.html` e simular pagamento de plano
3. Voltar para `/` e completar onboarding
4. Gerar treino
5. Criar múltiplos treinos
6. Renomear e ativar treinos
7. Ajustar manualmente no editor JSON
8. Exportar PDF

---

## 🛠️ Comandos úteis

```bash
# rodar servidor
npm start

# desenvolvimento simples
npm run dev
```

---

## 🔐 Observações de segurança (MVP)

- Senha com hash (`bcryptjs`)
- Rotas protegidas por JWT
- Isolamento por usuário em queries (`user_id`)

> Para produção real, recomenda-se: refresh tokens, rate limiting robusto, validação mais rígida e integração Stripe real com webhooks.

---

## 🚀 Próximos passos sugeridos

1. Integrar Stripe real (`checkout + webhook`)  
2. Criar fluxo de cadastro público com confirmação por e-mail  
3. Melhorar editor de treino com UI visual (sem JSON manual)  
4. Adicionar logs/auditoria e painel admin  
5. Deploy (Vercel + Railway/Render)

---

## 📄 Licença

Defina a licença conforme sua estratégia (MIT, proprietária, etc.).
