# Internship Tracker

A self-hosted, single-user web app to track job/internship applications.  
Stack: **Node.js + Express + SQLite** (backend) · **HTML + Tailwind + Chart.js** (frontend, no build step).

<img width="2432" height="1385" alt="image" src="https://github.com/user-attachments/assets/3cdc8817-9a2d-4ca7-835c-c5856e28d517" />

---

## Features

- Add, edit, delete applications (company, title, location, date, link, notes)
- Status pipeline: `applied → assessment → interview → offer / refused / ghosted`
- Dashboard with donut chart + stats cards (response rate, offer rate, pipeline, last 30 days…)
- Filter by status, full-text search on company/title, sort options
- Export to **CSV** or **JSON**
- Import from **CSV** or **JSON** (validates each row, reports errors per line)
- Rate limiting, CORS, and basic security headers
- Optional timestamp columns (`created_at`, `updated_at`) via migration

---

## Project structure

```
.
├── server.js          # Express app (API + static serving)
├── migrate.js         # Safe, idempotent DB migration script
├── package.json
├── internships.db     # SQLite database (created on first start)
├── backups/           # Created by migrate.js — timestamped DB snapshots
└── public/
    └── index.html     # Single-page frontend
```

---

## Requirements

| | Debian / Ubuntu | Alpine Linux |
|---|---|---|
| Runtime | Node.js ≥ 18 | Node.js ≥ 18 |
| Build tools (for `better-sqlite3`) | `build-essential`, `python3` | `alpine-sdk`, `python3` |

---

## Installation

### Debian / Ubuntu

```bash
# 1. Install Node.js (skip if already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install native build tools (required by better-sqlite3)
sudo apt-get install -y build-essential python3

# 3. Clone / copy the project and install dependencies
cd /opt/internship-tracker
npm install

# 4. Start
node server.js
```

### Alpine Linux

```bash
# 1. Install Node.js and build tools
apk add --no-cache nodejs npm alpine-sdk python3

# 2. Install dependencies
cd /opt/internship-tracker
npm install

# 3. Start
node server.js
```

The server listens on port **3000** by default.  
Open `http://localhost:3000` in your browser.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listening port |
| `NODE_ENV` | _(unset)_ | Set to `production` to hide internal error details from API responses |
| `ALLOWED_ORIGIN` | _(unset)_ | If set, enables CORS for that specific origin (e.g. `https://myapp.example.com`). Leave unset for same-origin only. |

Example:

```bash
PORT=8080 NODE_ENV=production node server.js
```

---

## Database migration

The migration script adds optional columns and indexes to an existing database.  
It is **idempotent** — safe to run multiple times.

### What it does

1. Creates a timestamped backup in `./backups/` before touching anything
2. Adds `created_at` and `updated_at` columns (back-fills existing rows with the current timestamp)
3. Creates indexes on `status` and `date_applied` for faster queries
4. Rolls back to the backup automatically if any step fails

### Dry run first (recommended)

```bash
node migrate.js --dry-run
```

Sample output:

```
=== Internship Tracker — Migration ===
  [DRY RUN — no changes will be written]

  Current table has 42 row(s), 8 column(s)

  [dry-run] Would create backup → backups/internships_2026-04-04T10-00-00.db
  [dry-run] Would run: Add created_at column
  [dry-run] Would run: Add updated_at column
  – Add index on status (already done)
  – Add index on date_applied (already done)

  Applied: 2  |  Skipped: 2

  Dry run complete. Re-run without --dry-run to apply.
```

### Apply

```bash
node migrate.js
```

Then **restart the server** — it auto-detects the new columns on startup.

---

## Running with PM2 (recommended for production)

[PM2](https://pm2.keymetrics.io/) keeps the process alive and restarts it on crashes.

### Install PM2

```bash
npm install -g pm2
```

### Start

```bash
cd /opt/internship-tracker
NODE_ENV=production pm2 start server.js --name internship-tracker
pm2 save                        # persist across reboots
pm2 startup                     # follow the printed instruction to enable autostart
```

### Common commands

```bash
pm2 status                      # list running processes
pm2 logs internship-tracker     # live logs
pm2 restart internship-tracker  # restart
pm2 stop internship-tracker     # stop
```

### Alpine + OpenRC (no systemd)

On Alpine, if you prefer OpenRC over PM2:

```bash
# /etc/init.d/internship-tracker
#!/sbin/openrc-run

name="internship-tracker"
command="/usr/bin/node"
command_args="/opt/internship-tracker/server.js"
command_background=true
pidfile="/run/${RC_SVCNAME}.pid"
directory="/opt/internship-tracker"
environment="NODE_ENV=production PORT=3000"

depend() {
    need net
}
```

```bash
chmod +x /etc/init.d/internship-tracker
rc-update add internship-tracker default
rc-service internship-tracker start
```

---

## Import / Export

### Export

Use the **↓ JSON** or **↓ CSV** buttons in the toolbar to download all applications.

### Import

Click **↑ Import** and select a `.json` or `.csv` file.

**JSON format** — array of objects (the same structure as the export):

```json
[
  {
    "company": "Acme Corp",
    "title": "Software Engineer Intern",
    "location": "Paris",
    "link": "https://example.com/job/123",
    "date_applied": "2026-03-15",
    "status": "interview",
    "details": "Contacted by Alice"
  }
]
```

**CSV format** — first row must be a header. Only `company` and `title` are required.

```csv
company,title,location,link,date_applied,status,details
Acme Corp,Software Engineer Intern,Paris,https://example.com,2026-03-15,interview,Contacted by Alice
```

Accepted status values: `applied`, `assessment`, `interview`, `offer`, `refused`, `ghosted`.  
The `id` column is ignored on import — the database assigns new IDs.  
Maximum **1000 rows** per import. Rows with validation errors are skipped; the rest are inserted.

---

## Backup strategy

`migrate.js` creates automatic backups before each migration run.  
For ongoing backups, a simple cron job is sufficient (SQLite is a single file):

```bash
# /etc/cron.d/internship-tracker-backup  (Debian/Ubuntu)
# or add to /var/spool/cron/crontabs/root on Alpine

# Daily backup at 3 AM, keep last 30 days
0 3 * * * cp /opt/internship-tracker/internships.db /opt/internship-tracker/backups/internships_$(date +\%Y-\%m-\%d).db
30 3 * * * find /opt/internship-tracker/backups -name "*.db" -mtime +30 -delete
```

---

## Nginx reverse proxy (optional)

If you want to expose the app on port 80/443:

```nginx
server {
    listen 80;
    server_name tracker.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

For HTTPS, use [Certbot](https://certbot.eff.org/) (`certbot --nginx`).

---

## Updating

```bash
cd /opt/internship-tracker
git pull                        # or copy new files
npm install                     # in case dependencies changed
node migrate.js --dry-run       # check what would change
node migrate.js                 # apply if needed
pm2 restart internship-tracker
```
