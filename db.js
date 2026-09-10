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
  console.log('✓ PostgreSQL ready');
}

/* ═══════════════════════════════════════════════════════
   JSON FILE MODE (local development)
═══════════════════════════════════════════════════════ */
const DATA_DIR  = path.join(__dirname, 'data');
const DB_FILE   = path.join(DATA_DIR, 'db.json');

function loadJson() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { programs: {}, participants: {}, responses: {} };
  }
}

function saveJson(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function jsonInit() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) saveJson({ programs: {}, participants: {}, responses: {} });
  console.log('✓ JSON file store ready (local mode) →', DB_FILE);
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
      const { rows } = await pgQuery('SELECT * FROM programs ORDER BY created_at DESC');
      return rows;
    }
    const data = loadJson();
    return Object.values(data.programs).sort((a,b) => b.created_at > a.created_at ? 1 : -1);
  },

  async createProgram(id, fields) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        `INSERT INTO programs (id,name,context,status,instruments)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, fields.name, fields.context||null,
         fields.status||'active', JSON.stringify(fields.instruments||[])]
      );
      return rows[0];
    }
    const data = loadJson();
    const row = { id, name: fields.name, context: fields.context||'', status: fields.status||'active', instruments: fields.instruments||[], created_at: new Date().toISOString() };
    data.programs[id] = row;
    saveJson(data);
    return row;
  },

  async updateProgram(id, fields) {
    if (USE_PG) {
      const { rows } = await pgQuery(
        `UPDATE programs SET name=$2, context=$3, instruments=$4 WHERE id=$1 RETURNING *`,
        [id, fields.name, fields.context||null, JSON.stringify(fields.instruments||[])]
      );
      return rows[0];
    }
    const data = loadJson();
    if (!data.programs[id]) throw new Error('Programa no encontrado');
    data.programs[id] = { ...data.programs[id], name: fields.name, context: fields.context||'', instruments: fields.instruments||[] };
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
