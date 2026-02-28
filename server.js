const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB safely
let db;
try {
  const dbPath = path.join(__dirname, 'internships.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // Better performance for concurrent reads/writes

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
} catch (err) {
  console.error('Failed to initialize database:', err);
  process.exit(1);
}

const VALID_STATUSES = ['applied', 'assessment', 'interview', 'offer', 'refused', 'ghosted'];
const LEGACY_STATUS_MAP = {
  Applied: 'applied',
  Assessment: 'assessment',
  Interview: 'interview',
  Offer: 'offer',
  Refused: 'refused',
  Ghosted: 'ghosted',
  'Offer 🎉': 'offer',
  'Refused ❌': 'refused',
  'Ghosted 👻': 'ghosted',
  'Offer ðŸŽ‰': 'offer',
  'Refused âŒ': 'refused',
  'Ghosted ðŸ‘»': 'ghosted',
};

function normalizeStatus(input) {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  if (VALID_STATUSES.includes(value)) return value;
  return LEGACY_STATUS_MAP[value] || null;
}

// API Endpoints
app.get('/api/applications', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM applications ORDER BY date_applied DESC, id DESC');
    const rows = stmt.all().map((row) => ({
      ...row,
      status: normalizeStatus(row.status) || 'applied',
    }));
    res.json(rows);
  } catch (error) {
    console.error('Fetch applications error:', error);
    res.status(500).json({ error: 'Failed to fetch applications', details: error.message });
  }
});

app.post('/api/applications', (req, res) => {
  try {
    const { company, title, location, link, date_applied, status, details } = req.body;

    if (!company?.trim() || !title?.trim()) {
      return res.status(400).json({ error: 'Company and Title are required' });
    }

    const safeStatus = normalizeStatus(status) || 'applied';

    const stmt = db.prepare(`
      INSERT INTO applications (company, title, location, link, date_applied, status, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      company.trim(),
      title.trim(),
      location?.trim() || null,
      link?.trim() || null,
      date_applied,
      safeStatus,
      details?.trim() || null
    );
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (error) {
    console.error('Add application error:', error);
    res.status(500).json({ error: 'Failed to add application', details: error.message });
  }
});

app.patch('/api/applications/:id', (req, res) => {
  try {
    const appId = parseInt(req.params.id, 10);
    if (Number.isNaN(appId)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const { status, details } = req.body;
    const updates = [];
    const params = [];

    if (status !== undefined) {
      const normalized = normalizeStatus(status);
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid status type provided' });
      }
      updates.push('status = ?');
      params.push(normalized);
    }
    if (details !== undefined) {
      updates.push('details = ?');
      params.push(details === null ? null : String(details).trim());
    }

    if (updates.length === 0) return res.json({ success: true, message: 'No changes provided' });

    params.push(appId);
    const stmt = db.prepare(`UPDATE applications SET ${updates.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Update application error:', error);
    res.status(500).json({ error: 'Failed to update application', details: error.message });
  }
});

app.delete('/api/applications/:id', (req, res) => {
  try {
    const appId = parseInt(req.params.id, 10);
    if (Number.isNaN(appId)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const stmt = db.prepare('DELETE FROM applications WHERE id = ?');
    const result = stmt.run(appId);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete application error:', error);
    res.status(500).json({ error: 'Failed to delete application', details: error.message });
  }
});

// PM2 Graceful Shutdown
const shutdown = () => {
  console.log('Closing database connection...');
  if (db) db.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start Server
app.listen(PORT, () => {
  console.log('Server running on http://localhost:' + PORT);
});
