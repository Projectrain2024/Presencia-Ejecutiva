/**
 * db.js — Dual-mode database adapter
 *
 * LOCAL  (no DATABASE_URL): JSON file store in ./data/
 * RAILWAY (DATABASE_URL set): PostgreSQL via pg
 *
 * Exposes the same interface in both modes so server.js never branches.
 */

const fs   = require('fs');
const path = require('path');

/* ═══════════════════════════════════════════════════════
   MODE DETECTION
═══════════════════════════════════════════════════════ */
const USE_PG = !!process.env.DATABASE_URL;

/* ═══════════════════════════════════════════════════════
   POSTGRESQL MODE
═══════════════════════════════════════════════════════ */
let pool;

async function pgQuery(text, params = []) {
  return pool.query(text, params);
}

async function pgInit() {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  // Crear tablas si no existen (nunca las borra)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS programs (
      id          VARCHAR(32)  PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      code        VARCHAR(100),
      context     VARCHAR(200),
      leader_name VARCHAR(200),
      status      VARCHAR(20)  DEFAULT 'active',
      session_date DATE,
      deadline     DATE,
      instruments  JSONB       DEFAULT '[]',
      created_at   TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS participants (
      id         VARCHAR(64)  PRIMARY KEY,
      program_id VARCHAR(32)  NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      name       VARCHAR(200) NOT NULL,
      added_at   TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS responses (
      id               VARCHAR(80)  PRIMARY KEY,
      program_id       VARCHAR(32)  NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      participant_name VARCHAR(200),
      leader_name      VARCHAR(200) DEFAULT '',
      instrument       VARCHAR(50),
      answers          JSONB        DEFAULT '{}',
      submitted_at     TIMESTAMPTZ  DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_participants_program ON participants(program_id);
    CREATE INDEX IF NOT EXISTS idx_responses_program    ON responses(program_id);
  `);

  // Migraciones aditivas: agregar columnas nuevas sin tocar datos existentes
  const migrations = [
    `ALTER TABLE programs ADD COLUMN IF NOT EXISTS sector VARCHAR(200)`,
  ];
  for (const sql of migrations) {
    await pool.query(sql);
  }

  console.log('✓ PostgreSQL ready');
}

/* ═══════════════════════════════════════════════════════
   JSON FILE MODE (local development)
═══════════════════════════════════════════════════════ */
const DATA_DIR   = path.join(__dirname, 'data');
const DB_FILE    = path.join(DATA_DIR, 'db.json');
const DB_TMP     = path.join(DATA_DIR, 'db.json.tmp');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 10;

function loadJson() {
  // Intenta el archivo principal; si falla, intenta el tmp (escritura interrumpida)
  for (const f of [DB_FILE, DB_TMP]) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return { programs: {}, participants: {}, responses: {} };
}

function saveJson(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const json = JSON.stringify(data, null, 2);

  // 1. Escribir en archivo temporal primero (evita corrupción si el proceso muere a mitad)
  fs.writeFileSync(DB_TMP, json);

  // 2. Guardar backup rotativo antes de sobreescribir el principal
  if (fs.existsSync(DB_FILE)) {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `db-${stamp}.json`));

    // Mantener solo los últimos MAX_BACKUPS backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('db-') && f.endsWith('.json'))
      .sort();
    while (backups.length > MAX_BACKUPS) {
      fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));
    }
  }

  // 3. Reemplazar el archivo principal de forma atómica
  fs.renameSync(DB_TMP, DB_FILE);
}

function jsonInit() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    saveJson({ programs: {}, participants: {}, responses: {} });
  }
  console.log('✓ JSON file store ready (local mode) →', DB_FILE);
  const bkCount = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).length : 0;
  if (bkCount > 0) console.log(`   ${bkCount} backup${bkCount!==1?'s':''} en data/backups/`);
}

/* ═══════════════════════════════════════════════════════
   UNIFIED API — used by server.js
═══════════════════════════════════════════════════════ */

const db = {

  /* ── Init ─────────────────────────────────────────── */
  async init() {
    if (USE_PG) return pgInit();
    return jsonInit();
  },

  /* ── Programs ─────────────────────────────────────── */
  async getPrograms() {
    if (USE_PG) {
      const { rows } = await pgQuery(`
        SELECT p.*,
          COUNT(DISTINCT pt.id)::int AS _parts,
          COUNT(DISTINCT r.id)::int  AS _resps
        FROM programs p
        LEFT JOIN participants pt ON pt.program_id = p.id
        LEFT JOIN responses   r  ON r.program_id  = p.id
        GROUP BY p.id
        ORDER BY p.created_at DESC
      `);
      return rows;
    }
    const data = loadJson();
    return Object.values(data.programs)
      .sort((a,b) => b.created_at > a.created_at ? 1 : -1)
      .map(p => ({
        ...p,
        _parts: Object.values(data.participants).filter(pt => pt.program_id === p.id).length,
        _resps: Object.values(data.responses).filter(r => r.program_id === p.id).length,
      }));
  },

  async createProgram(id, fields) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        `INSERT INTO programs (id,name,sector,context,status,instruments)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, fields.name, fields.sector||null, fields.context||null,
         fields.status||'active', JSON.stringify(fields.instruments||[])]
      );
      return rows[0];
    }
    const data = loadJson();
    const row = { id, name: fields.name, sector: fields.sector||'', context: fields.context||'', status: fields.status||'active', instruments: fields.instruments||[], created_at: new Date().toISOString() };
    data.programs[id] = row;
    saveJson(data);
    return row;
  },

  async updateProgram(id, fields) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        `UPDATE programs SET name=$2, sector=$3, context=$4, instruments=$5 WHERE id=$1 RETURNING *`,
        [id, fields.name, fields.sector||null, fields.context||null, JSON.stringify(fields.instruments||[])]
      );
      return rows[0];
    }
    const data = loadJson();
    if (!data.programs[id]) throw new Error('Programa no encontrado');
    data.programs[id] = { ...data.programs[id], name: fields.name, sector: fields.sector||'', context: fields.context||'', instruments: fields.instruments||[] };
    saveJson(data);
    return data.programs[id];
  },

  async getProgram(id) {
    if (USE_PG) {
      const prog = await pgQuery('SELECT * FROM programs WHERE id=$1', [id]);
      if (!prog.rows.length) return null;
      const parts = await pgQuery('SELECT * FROM participants WHERE program_id=$1 ORDER BY added_at', [id]);
      const resps = await pgQuery('SELECT * FROM responses WHERE program_id=$1 ORDER BY submitted_at DESC', [id]);
      return { ...prog.rows[0], participants: parts.rows, responses: resps.rows };
    }
    const data = loadJson();
    const prog = data.programs[id];
    if (!prog) return null;
    const participants = Object.values(data.participants).filter(p => p.program_id === id).sort((a,b) => a.added_at > b.added_at ? 1 : -1);
    const responses    = Object.values(data.responses).filter(r => r.program_id === id).sort((a,b) => b.submitted_at > a.submitted_at ? 1 : -1);
    return { ...prog, participants, responses };
  },

  async getProgramPublic(id) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        'SELECT id,name,context,leader_name,instruments FROM programs WHERE id=$1', [id]
      );
      return rows[0] || null;
    }
    const data = loadJson();
    const p = data.programs[id];
    if (!p) return null;
    return { id:p.id, name:p.name, context:p.context, leader_name:p.leader_name, instruments:p.instruments };
  },

  async deleteProgram(id) {
    if (USE_PG) {
      await pgQuery('DELETE FROM programs WHERE id=$1', [id]);
      return;
    }
    const data = loadJson();
    delete data.programs[id];
    // cascade
    Object.keys(data.participants).filter(k => data.participants[k].program_id === id).forEach(k => delete data.participants[k]);
    Object.keys(data.responses).filter(k => data.responses[k].program_id === id).forEach(k => delete data.responses[k]);
    saveJson(data);
  },

  /* ── Participants ──────────────────────────────────── */
  async addParticipant(id, program_id, name) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        'INSERT INTO participants (id,program_id,name) VALUES ($1,$2,$3) RETURNING *',
        [id, program_id, name]
      );
      return rows[0];
    }
    const data = loadJson();
    const row = { id, program_id, name, added_at: new Date().toISOString() };
    data.participants[id] = row;
    saveJson(data);
    return row;
  },

  async deleteParticipant(id) {
    if (USE_PG) {
      await pgQuery('DELETE FROM participants WHERE id=$1', [id]);
      return;
    }
    const data = loadJson();
    delete data.participants[id];
    saveJson(data);
  },

  /* ── Responses ─────────────────────────────────────── */
  async programExists(id) {
    if (USE_PG) {
      const { rows } = await pgQuery('SELECT id FROM programs WHERE id=$1', [id]);
      return rows.length > 0;
    }
    return !!loadJson().programs[id];
  },

  async addResponse(id, program_id, participant_name, leader_name, instrument, answers) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        `INSERT INTO responses (id,program_id,participant_name,leader_name,instrument,answers)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, program_id, participant_name, leader_name||'', instrument, JSON.stringify(answers||{})]
      );
      return rows[0];
    }
    const data = loadJson();
    const row = { id, program_id, participant_name, leader_name: leader_name||'', instrument, answers: answers||{}, submitted_at: new Date().toISOString() };
    data.responses[id] = row;
    saveJson(data);
    return row;
  },
};

module.exports = db;
