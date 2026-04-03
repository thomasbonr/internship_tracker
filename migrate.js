/**
 * migrate.js — safe, idempotent migration for internships.db
 *
 * What it does:
 *   1. Creates a timestamped backup of internships.db before touching anything
 *   2. Adds `created_at` and `updated_at` columns if they don't exist
 *      (existing rows get the current timestamp as a sensible default)
 *   3. Creates indexes on `status` and `date_applied` if they don't exist
 *
 * Safe to re-run: every step checks before acting — nothing is dropped or truncated.
 *
 * Usage:
 *   node migrate.js
 *   node migrate.js --dry-run    (show what would happen, touch nothing)
 */

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DRY_RUN  = process.argv.includes('--dry-run');
const DB_PATH  = path.join(__dirname, 'internships.db');
const BK_DIR   = path.join(__dirname, 'backups');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`  ${msg}`); }
function ok(msg)   { console.log(`  ✓ ${msg}`); }
function skip(msg) { console.log(`  – ${msg} (already done)`); }
function warn(msg) { console.warn(`  ! ${msg}`); }

function abort(msg, err) {
  console.error(`\n  ERROR: ${msg}`);
  if (err) console.error(`  ${err.message}`);
  process.exit(1);
}

// ─── Pre-flight ───────────────────────────────────────────────────────────────

if (!fs.existsSync(DB_PATH)) {
  abort(`Database not found at ${DB_PATH}`);
}

console.log('\n=== Internship Tracker — Migration ===');
if (DRY_RUN) console.log('  [DRY RUN — no changes will be written]\n');

// ─── Backup ───────────────────────────────────────────────────────────────────

const now      = new Date();
const stamp    = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bkPath   = path.join(BK_DIR, `internships_${stamp}.db`);

if (!DRY_RUN) {
  if (!fs.existsSync(BK_DIR)) fs.mkdirSync(BK_DIR, { recursive: true });
  try {
    fs.copyFileSync(DB_PATH, bkPath);
    ok(`Backup created → backups/internships_${stamp}.db`);
  } catch (err) {
    abort('Could not create backup — migration aborted for safety', err);
  }
} else {
  log(`[dry-run] Would create backup → backups/internships_${stamp}.db`);
}

// ─── Open DB ──────────────────────────────────────────────────────────────────

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
} catch (err) {
  abort('Could not open database', err);
}

// ─── Inspect current schema ───────────────────────────────────────────────────

const schemaRows  = db.prepare('PRAGMA table_info(applications)').all();
const columnNames = new Set(schemaRows.map((c) => c.name));

const indexRows  = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='applications'").all();
const indexNames = new Set(indexRows.map((i) => i.name));

const rowCount = db.prepare('SELECT COUNT(*) as n FROM applications').get().n;
log(`Current table has ${rowCount} row(s), ${columnNames.size} column(s)\n`);

// ─── Migrations ───────────────────────────────────────────────────────────────

const defaultTimestamp = now.toISOString();

const migrations = [
  {
    name: 'Add created_at column',
    needed: !columnNames.has('created_at'),
    run() {
      db.exec(`ALTER TABLE applications ADD COLUMN created_at TEXT`);
      // Back-fill existing rows with current timestamp
      const updated = db.prepare(`UPDATE applications SET created_at = ? WHERE created_at IS NULL`).run(defaultTimestamp);
      return `column added, ${updated.changes} existing row(s) back-filled with ${defaultTimestamp}`;
    },
  },
  {
    name: 'Add updated_at column',
    needed: !columnNames.has('updated_at'),
    run() {
      db.exec(`ALTER TABLE applications ADD COLUMN updated_at TEXT`);
      const updated = db.prepare(`UPDATE applications SET updated_at = ? WHERE updated_at IS NULL`).run(defaultTimestamp);
      return `column added, ${updated.changes} existing row(s) back-filled with ${defaultTimestamp}`;
    },
  },
  {
    name: 'Add index on status',
    needed: !indexNames.has('idx_applications_status'),
    run() {
      db.exec(`CREATE INDEX idx_applications_status ON applications (status)`);
      return 'index created';
    },
  },
  {
    name: 'Add index on date_applied',
    needed: !indexNames.has('idx_applications_date'),
    run() {
      db.exec(`CREATE INDEX idx_applications_date ON applications (date_applied)`);
      return 'index created';
    },
  },
];

// ─── Run inside a single transaction ─────────────────────────────────────────

let applied = 0;
let skipped = 0;

// SQLite doesn't allow DDL inside transactions for some operations, so we run
// each migration individually after checking its pre-condition.
for (const m of migrations) {
  if (!m.needed) {
    skip(m.name);
    skipped++;
    continue;
  }

  if (DRY_RUN) {
    log(`[dry-run] Would run: ${m.name}`);
    applied++;
    continue;
  }

  try {
    const detail = m.run();
    ok(`${m.name} — ${detail}`);
    applied++;
  } catch (err) {
    // Restore from backup on failure
    warn(`Migration failed: ${m.name}`);
    warn(`Error: ${err.message}`);
    db.close();
    try {
      fs.copyFileSync(bkPath, DB_PATH);
      warn('Database restored from backup.');
    } catch (restoreErr) {
      warn(`Could not restore backup! Manual restore from: ${bkPath}`);
    }
    process.exit(1);
  }
}

// ─── Verify ───────────────────────────────────────────────────────────────────

if (!DRY_RUN) {
  const finalSchema = db.prepare('PRAGMA table_info(applications)').all();
  const finalCols   = finalSchema.map((c) => c.name).join(', ');
  const finalIndexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='applications'").all();
  const finalIdxNames = finalIndexes.map((i) => i.name).join(', ');

  console.log(`\n  Final columns : ${finalCols}`);
  console.log(`  Final indexes : ${finalIdxNames || '(none)'}`);
}

db.close();

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n  Applied: ${applied}  |  Skipped: ${skipped}`);
if (DRY_RUN) {
  console.log('\n  Dry run complete. Re-run without --dry-run to apply.\n');
} else if (applied > 0) {
  console.log('\n  Migration complete. Restart your server.\n');
} else {
  console.log('\n  Nothing to do — database is already up to date.\n');
}
