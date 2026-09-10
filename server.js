const express = require('express');
const session = require('express-session');
const path    = require('path');
const db      = require('./db');
const { nanoid } = require('nanoid');

const app  = express();
const PORT = process.env.PORT || 3000;
const HUB_PASSWORD = process.env.HUB_PASSWORD || 'lhh2026';

/* ── Middleware ─────────────────────────────────────── */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'pe-hub-secret-dev',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ── Auth ───────────────────────────────────────────── */
function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  res.redirect('/login');
}

/* ── Pages ──────────────────────────────────────────── */
app.get('/', requireAuth, (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'hub.html')));

app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (req.body.password === HUB_PASSWORD) {
    req.session.authenticated = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/p/:programId', (_, res) =>
  res.sendFile(path.join(__dirname, 'public', 'participant.html')));

/* ── API: Programs ──────────────────────────────────── */
app.get('/api/programs', requireAuth, async (req, res) => {
  try { res.json(await db.getPrograms()); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/programs', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name requerido' });
  try { res.json(await db.createProgram(nanoid(12), req.body)); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/programs/:id', requireAuth, async (req, res) => {
  try {
    const prog = await db.getProgram(req.params.id);
    if (!prog) return res.status(404).json({ error: 'not found' });
    res.json(prog);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/programs/:id', requireAuth, async (req, res) => {
  try { await db.deleteProgram(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: Participants ──────────────────────────────── */
app.post('/api/programs/:id/participants', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name requerido' });
  try { res.json(await db.addParticipant(nanoid(16), req.params.id, name.trim())); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/participants/:id', requireAuth, async (req, res) => {
  try { await db.deleteParticipant(req.params.id); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── API: Public ────────────────────────────────────── */
app.get('/api/public/programs/:id', async (req, res) => {
  try {
    const prog = await db.getProgramPublic(req.params.id);
    if (!prog) return res.status(404).json({ error: 'Programa no encontrado' });
    res.json(prog);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/responses', async (req, res) => {
  const { program_id, participant_name, leader_name, instrument, answers } = req.body;
  if (!program_id || !participant_name?.trim() || !instrument)
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  try {
    if (!(await db.programExists(program_id)))
      return res.status(404).json({ error: 'Programa no encontrado' });
    const row = await db.addResponse(nanoid(24), program_id, participant_name.trim(), leader_name?.trim()||'', instrument, answers);
    res.json(row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ── Start ──────────────────────────────────────────── */
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🟣 Hub corriendo en http://localhost:${PORT}`);
    console.log(`   Contraseña: ${HUB_PASSWORD}`);
    console.log(`   Modo: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'JSON local (data/db.json)'}\n`);
  });
}).catch(err => {
  console.error('Error al iniciar:', err.message);
  process.exit(1);
});
