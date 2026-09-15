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

app.get('/p/:programId/:instrument', (_, res) =>
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

app.put('/api/programs/:id', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name requerido' });
  try {
    const prog = await db.updateProgram(req.params.id, req.body);
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

/* ── API: Invitations ───────────────────────────────────── */
app.post('/api/invite', requireAuth, async (req, res) => {
  const { emails, instrument, program_name, link } = req.body;
  if (!emails?.length || !link) return res.status(400).json({ error: 'Faltan campos' });

  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASS = process.env.SMTP_PASS;
  const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return res.json({ ok: false, mailto: true });
  }

  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const instrLabel = instrument === 'fr-equipo' ? 'French & Raven · Equipo' : 'Reflected Best Self';
    const subject = `Invitación a evaluación: ${program_name}`;
    const html = `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1C0D36">
        <div style="background:linear-gradient(135deg,#3A1259,#5A2090);padding:28px 32px;border-radius:12px 12px 0 0">
          <div style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:rgba(255,255,255,.6);margin-bottom:6px">LHH · Presencia Ejecutiva</div>
          <div style="font-family:Georgia,serif;font-size:22px;color:#fff">${program_name}</div>
        </div>
        <div style="background:#fff;border:1px solid #D4C0E8;border-top:none;border-radius:0 0 12px 12px;padding:28px 32px">
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px">Hola,</p>
          <p style="font-size:14px;line-height:1.65;color:#4A3560;margin:0 0 20px">
            Te invitamos a completar la evaluación <strong>${instrLabel}</strong> del programa <strong>${program_name}</strong>.
            ${instrument === 'fr-equipo' ? 'Tu respuesta es completamente anónima.' : ''}
          </p>
          <div style="text-align:center;margin:24px 0">
            <a href="${link}" style="background:#E9A020;color:#1C0D36;text-decoration:none;font-weight:700;font-size:14px;padding:13px 28px;border-radius:9px;display:inline-block">
              Comenzar evaluación →
            </a>
          </div>
          <p style="font-size:12px;color:#8B6FAA;margin:0">Si el botón no funciona, copia este enlace:<br>
            <a href="${link}" style="color:#7B3FA8">${link}</a>
          </p>
        </div>
      </div>`;

    const results = await Promise.allSettled(
      emails.map(to => transport.sendMail({ from: SMTP_FROM, to, subject, html }))
    );
    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ ok: true, sent, failed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
