const express   = require('express');
const Database  = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const cors      = require('cors');
const path      = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const HOST   = process.env.HOST || '127.0.0.1'; // only reachable through nginx/Caddy
const IS_DEV = process.env.NODE_ENV !== 'production';

// Trust two proxy hops (Caddy -> Nginx) so req.ip is the real client IP
// (needed by express-rate-limit to rate-limit per client, not per proxy).
app.set('trust proxy', 2);

// ─── Security headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── CORS ────────────────────────────────────────────────────────────────────
// Default: same-origin only (origin: false). Set ALLOWED_ORIGIN env var to
// permit a specific cross-origin host (e.g. a reverse proxy on a different port).
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || false,
  optionsSuccessStatus: 200,
}));

// ─── Rate limiting ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later.' },
});

// Tighter limit for the import endpoint (bulk write)
const importLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many import requests — please try again later.' },
});

app.use('/api', apiLimiter);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' })); // large enough for a full import
app.use(express.static(path.join(__dirname, 'public')));

// Serve Chart.js locally from node_modules (eliminates CDN dependency).
// Use path.join instead of require.resolve — chart.js v4 restricts package
// subpath exports so require.resolve cannot access dist files directly.
app.get('/js/chart.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/chart.js/dist/chart.umd.min.js'));
});

// ─── Status configuration (single source of truth) ───────────────────────────
// Changing a status here automatically propagates to the frontend via /api/statuses.
const STATUS_CONFIG = [
  { key: 'applied',    label: 'Applied',      chartColor: '#3b82f6', css: 'bg-blue-100 text-blue-800' },
  { key: 'assessment', label: 'Assessment',   chartColor: '#f59e0b', css: 'bg-yellow-100 text-yellow-800' },
  { key: 'interview',  label: 'Interview',    chartColor: '#a855f7', css: 'bg-purple-100 text-purple-800' },
  { key: 'offer',      label: 'Offer \u{1F389}',   chartColor: '#22c55e', css: 'bg-green-100 text-green-800' },
  { key: 'refused',    label: 'Refused \u{274C}',  chartColor: '#ef4444', css: 'bg-red-100 text-red-800' },
  { key: 'ghosted',    label: 'Ghosted \u{1F47B}', chartColor: '#9ca3af', css: 'bg-gray-200 text-gray-800' },
];

const VALID_STATUSES = STATUS_CONFIG.map((s) => s.key);

const LEGACY_STATUS_MAP = {
  Applied: 'applied', Assessment: 'assessment', Interview: 'interview',
  Offer: 'offer', Refused: 'refused', Ghosted: 'ghosted',
  ['Offer \u{1F389}']: 'offer', ['Refused \u{274C}']: 'refused', ['Ghosted \u{1F47B}']: 'ghosted',
  // garbled UTF-8 variants from older data
  ['Offer \uFFFD\uFFFD\uFFFD']: 'offer', ['Refused \uFFFD\uFFFD']: 'refused', ['Ghosted \uFFFD\uFFFD\uFFFD']: 'ghosted',
};

const FIELD_LIMITS = { company: 200, title: 200, location: 200, link: 2048, details: 5000 };

// ─── Database ────────────────────────────────────────────────────────────────
let db;
let hasTimestamps = false;

try {
  const dbPath = path.join(__dirname, 'internships.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      title TEXT NOT NULL,
      location TEXT,
      link TEXT,
      date_applied TEXT,
      status TEXT DEFAULT 'applied',
      details TEXT
    )
  `);

  const schema = db.prepare('PRAGMA table_info(applications)').all();
  const cols   = new Set(schema.map((c) => c.name));
  hasTimestamps = cols.has('created_at') && cols.has('updated_at');
  console.log(`Timestamp columns: ${hasTimestamps ? 'enabled' : 'disabled (run: node migrate.js)'}`);
} catch (err) {
  console.error('Failed to initialize database:', err);
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function normalizeStatus(input) {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  if (VALID_STATUSES.includes(value)) return value;
  return LEGACY_STATUS_MAP[value] || null;
}

function errorResponse(res, status, message, err = null) {
  const body = { error: message };
  if (IS_DEV && err) body.details = err.message;
  return res.status(status).json(body);
}

function validateId(req, res, next) {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid ID format' });
  const appId = parseInt(req.params.id, 10);
  if (Number.isNaN(appId)) return res.status(400).json({ error: 'Invalid ID format' });
  req.appId = appId;
  next();
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function validateFieldLengths(body, res) {
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const value = body[field];
    if (value && String(value).length > limit) {
      res.status(400).json({ error: `Field "${field}" exceeds maximum length of ${limit} characters` });
      return false;
    }
  }
  return true;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamps: hasTimestamps });
});

// Single source of truth for status metadata consumed by the frontend
app.get('/api/statuses', (req, res) => {
  res.json(STATUS_CONFIG);
});

app.get('/api/applications', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM applications ORDER BY date_applied DESC, id DESC').all()
      .map((row) => {
        const normalized = normalizeStatus(row.status);
        if (!normalized) console.warn(`Unknown status in DB for id=${row.id}: "${row.status}", defaulting to 'applied'`);
        return { ...row, status: normalized || 'applied' };
      });
    res.json(rows);
  } catch (error) {
    console.error('Fetch applications error:', error);
    errorResponse(res, 500, 'Failed to fetch applications', error);
  }
});

app.post('/api/applications', (req, res) => {
  try {
    const { company, title, location, link, date_applied, status, details } = req.body;

    if (!company?.trim() || !title?.trim()) {
      return res.status(400).json({ error: 'Company and Title are required' });
    }
    if (!validateFieldLengths(req.body, res)) return;
    if (date_applied && !isValidDate(date_applied)) {
      return res.status(400).json({ error: 'date_applied must be a valid YYYY-MM-DD date' });
    }

    const safeStatus = normalizeStatus(status) || 'applied';
    const now        = new Date().toISOString();

    const columns  = ['company', 'title', 'location', 'link', 'date_applied', 'status', 'details'];
    const values   = [company.trim(), title.trim(), location?.trim() || null, link?.trim() || null, date_applied || null, safeStatus, details?.trim() || null];

    if (hasTimestamps) { columns.push('created_at', 'updated_at'); values.push(now, now); }

    const stmt = db.prepare(`INSERT INTO applications (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    const info = stmt.run(...values);
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (error) {
    console.error('Add application error:', error);
    errorResponse(res, 500, 'Failed to add application', error);
  }
});

app.patch('/api/applications/:id', validateId, (req, res) => {
  try {
    const { status, details } = req.body;
    const updates = [], params = [];

    for (const field of ['company', 'title']) {
      if (req.body[field] === undefined) continue;
      const v = String(req.body[field] ?? '').trim();
      if (!v) return res.status(400).json({ error: `${field} cannot be empty` });
      if (v.length > FIELD_LIMITS[field]) return res.status(400).json({ error: `Field "${field}" exceeds maximum length of ${FIELD_LIMITS[field]} characters` });
      updates.push(`${field} = ?`); params.push(v);
    }
    for (const field of ['location', 'link']) {
      if (req.body[field] === undefined) continue;
      const v = String(req.body[field] ?? '').trim();
      if (v.length > FIELD_LIMITS[field]) return res.status(400).json({ error: `Field "${field}" exceeds maximum length of ${FIELD_LIMITS[field]} characters` });
      updates.push(`${field} = ?`); params.push(v || null);
    }
    if (req.body.date_applied !== undefined) {
      const v = req.body.date_applied;
      if (v !== null && v !== '' && !isValidDate(v)) return res.status(400).json({ error: 'date_applied must be a valid YYYY-MM-DD date' });
      updates.push('date_applied = ?'); params.push(v || null);
    }

    if (status !== undefined) {
      const normalized = normalizeStatus(status);
      if (!normalized) return res.status(400).json({ error: 'Invalid status type provided' });
      updates.push('status = ?'); params.push(normalized);
    }
    if (details !== undefined) {
      if (details !== null && String(details).length > FIELD_LIMITS.details) {
        return res.status(400).json({ error: `Field "details" exceeds maximum length of ${FIELD_LIMITS.details} characters` });
      }
      updates.push('details = ?'); params.push(details === null ? null : String(details).trim());
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields provided for update' });

    if (hasTimestamps) { updates.push('updated_at = ?'); params.push(new Date().toISOString()); }

    params.push(req.appId);
    const result = db.prepare(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Application not found' });

    res.json({ success: true });
  } catch (error) {
    console.error('Update application error:', error);
    errorResponse(res, 500, 'Failed to update application', error);
  }
});

app.delete('/api/applications/:id', validateId, (req, res) => {
  try {
    const result = db.prepare('DELETE FROM applications WHERE id = ?').run(req.appId);
    if (result.changes === 0) return res.status(404).json({ error: 'Application not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Delete application error:', error);
    errorResponse(res, 500, 'Failed to delete application', error);
  }
});

// ─── Import endpoint ──────────────────────────────────────────────────────────
// Accepts an array of application objects (parsed CSV or JSON, ID field ignored).
// Returns { imported, skipped, errors[] }.
app.post('/api/import', importLimiter, (req, res) => {
  const rows = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'Expected a non-empty array of application objects' });
  }
  if (rows.length > 1000) {
    return res.status(400).json({ error: 'Maximum 1000 rows per import' });
  }

  const now      = new Date().toISOString();
  const imported = [];
  const errors   = [];

  const columns  = ['company', 'title', 'location', 'link', 'date_applied', 'status', 'details'];
  if (hasTimestamps) columns.push('created_at', 'updated_at');
  const stmt = db.prepare(`INSERT INTO applications (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);

  const importAll = db.transaction((items) => {
    for (const [i, row] of items.entries()) {
      const company = String(row.company || '').trim();
      const title   = String(row.title   || '').trim();

      if (!company || !title) {
        errors.push({ row: i + 1, reason: 'Missing company or title' });
        continue;
      }

      // Field length check
      let tooLong = false;
      for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
        if (row[field] && String(row[field]).length > limit) {
          errors.push({ row: i + 1, reason: `Field "${field}" exceeds ${limit} characters` });
          tooLong = true;
          break;
        }
      }
      if (tooLong) continue;

      if (row.date_applied && !isValidDate(row.date_applied)) {
        errors.push({ row: i + 1, reason: 'date_applied must be YYYY-MM-DD' });
        continue;
      }

      const safeStatus = normalizeStatus(row.status) || 'applied';
      const values = [
        company,
        title,
        String(row.location || '').trim() || null,
        String(row.link     || '').trim() || null,
        row.date_applied || null,
        safeStatus,
        String(row.details  || '').trim() || null,
      ];
      if (hasTimestamps) values.push(row.created_at || now, now);

      stmt.run(...values);
      imported.push(i + 1);
    }
  });

  try {
    importAll(rows);
  } catch (error) {
    console.error('Import error:', error);
    return errorResponse(res, 500, 'Import failed — no rows were written', error);
  }

  res.json({
    imported: imported.length,
    skipped:  errors.length,
    errors,
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = () => {
  console.log('Closing database connection…');
  if (db) db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT} [${IS_DEV ? 'development' : 'production'}]`);
});
