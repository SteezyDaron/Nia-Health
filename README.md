# niA Health — Production Setup Guide

A full-stack women's hormonal wellness platform built with Node.js, PostgreSQL, and the Anthropic AI API.

---

## Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Backend    | Node.js + Express.js              |
| Database   | PostgreSQL 14+                    |
| Auth       | JWT + bcrypt                      |
| AI         | Anthropic Claude (claude-sonnet)  |
| Frontend   | React 18 (served by Express)      |
| Hosting    | Railway / Render / Any VPS        |

---

## Project Structure

```
nia-health/
├── server.js           # Express API — all routes
├── package.json
├── .env.example        # Copy to .env and fill in
├── db/
│   └── schema.sql      # Run once to set up your database
├── public/
│   └── index.html      # Frontend (served by Express)
└── README.md
```

---

## Local Setup

### 1. Prerequisites

- Node.js 18 or higher
- PostgreSQL 14 or higher (local or cloud)
- An Anthropic API key — get one at https://console.anthropic.com

### 2. Clone and install

```bash
git clone <your-repo-url>
cd nia-health
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in every value:

```env
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/nia_health
JWT_SECRET=a-long-random-string-change-this
ANTHROPIC_API_KEY=sk-ant-your-key-here
PORT=3000
NODE_ENV=development
ADMIN_EMAIL=your@email.com
```

> **JWT_SECRET**: Generate a strong secret — run `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` in your terminal.

### 4. Set up the database

Create the database first:

```bash
psql -U postgres -c "CREATE DATABASE nia_health;"
```

Then run the schema:

```bash
psql -U postgres -d nia_health -f db/schema.sql
```

### 5. Start the server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open http://localhost:3000 — you should see the niA Health app.

---

## First Admin Account

1. Register an account using the email you set as `ADMIN_EMAIL` in `.env`
2. That account automatically gets admin privileges
3. On the website, scroll to the footer and click the subtle `admin` link
4. Sign in with your admin account credentials

---

## Deployment

### Option A: Railway (Recommended — easiest)

1. Push your code to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add a PostgreSQL plugin (Railway provides one free)
4. Set environment variables in Railway dashboard:
   - `DATABASE_URL` (Railway auto-fills this from the PostgreSQL plugin)
   - `JWT_SECRET`
   - `ANTHROPIC_API_KEY`
   - `NODE_ENV=production`
   - `ADMIN_EMAIL`
5. Railway detects Node.js automatically and deploys

Your app will be live at `https://your-project.up.railway.app`

### Option B: Render

1. Push to GitHub
2. Go to https://render.com → New Web Service → Connect repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add a PostgreSQL database (Render free tier available)
6. Set environment variables in Render dashboard
7. Run the schema: use Render's shell or connect to the DB externally

### Option C: VPS (DigitalOcean, Hetzner, etc.)

```bash
# On your server
git clone <your-repo> /var/www/nia-health
cd /var/www/nia-health
npm install --production

# Set up environment
cp .env.example .env
nano .env  # fill in all values

# Set up database
sudo -u postgres psql -c "CREATE DATABASE nia_health;"
sudo -u postgres psql -d nia_health -f db/schema.sql

# Run with PM2 (keeps it alive)
npm install -g pm2
pm2 start server.js --name nia-health
pm2 startup
pm2 save

# Set up Nginx reverse proxy
# Point your domain to port 3000
```

### Option D: Safaricom Business Hosting (cPanel)

Safaricom Business hosting supports Node.js apps via cPanel's Node.js Selector:

1. Log in to cPanel
2. Go to **Setup Node.js App**
3. Create a new app:
   - Node.js version: 18 or 20
   - Application mode: Production
   - Application root: `/home/yourusername/nia-health`
   - Application URL: your domain
   - Application startup file: `server.js`
4. Upload your files via File Manager or FTP
5. Set environment variables in the Node.js app settings
6. For PostgreSQL: contact Safaricom support to enable PostgreSQL, or use an external database (Supabase free tier works well)
7. Click **Run NPM Install** then **Start**

---

## Environment Variables Reference

| Variable          | Required | Description                                      |
|-------------------|----------|--------------------------------------------------|
| `DATABASE_URL`    | Yes      | Full PostgreSQL connection string                |
| `JWT_SECRET`      | Yes      | Random secret for signing tokens (min 32 chars)  |
| `ANTHROPIC_API_KEY` | Yes    | Your Anthropic API key                           |
| `PORT`            | No       | Server port (default: 3000)                      |
| `NODE_ENV`        | No       | `development` or `production`                    |
| `ADMIN_EMAIL`     | Yes      | Email that gets admin access on registration     |
| `FRONTEND_URL`    | Prod     | Your domain (used for CORS in production)        |

---

## API Reference

All endpoints are under `/api/`. Protected routes require `Authorization: Bearer <token>`.

### Auth
| Method | Endpoint             | Auth | Description              |
|--------|----------------------|------|--------------------------|
| POST   | `/auth/register`     | No   | Create account           |
| POST   | `/auth/login`        | No   | Sign in, get token       |
| GET    | `/auth/me`           | Yes  | Get current user         |
| PUT    | `/auth/me`           | Yes  | Update profile           |
| PUT    | `/auth/change-password` | Yes | Change password        |

### Cycle
| Method | Endpoint             | Auth | Description              |
|--------|----------------------|------|--------------------------|
| GET    | `/cycle/current`     | Yes  | Phase, score, predictions|
| POST   | `/cycle/log`         | Yes  | Log period start date    |
| GET    | `/cycle/history`     | Yes  | Past cycles              |

### Daily Logs
| Method | Endpoint             | Auth | Description              |
|--------|----------------------|------|--------------------------|
| POST   | `/logs`              | Yes  | Create a log entry       |
| GET    | `/logs`              | Yes  | Fetch logs (with filters)|
| GET    | `/logs/stats`        | Yes  | Aggregated stats         |

### Supplements
| Method | Endpoint                | Auth | Description           |
|--------|-------------------------|------|-----------------------|
| POST   | `/supplements/log`      | Yes  | Log supplement taken  |
| GET    | `/supplements/today`    | Yes  | Today's logged supps  |

### Community
| Method | Endpoint                          | Auth | Description          |
|--------|-----------------------------------|------|----------------------|
| GET    | `/community/posts`                | Yes  | Get approved posts   |
| POST   | `/community/posts`                | Yes  | Submit a post        |
| POST   | `/community/posts/:id/like`       | Yes  | Toggle like          |
| POST   | `/community/posts/:id/report`     | Yes  | Report a post        |
| GET    | `/community/posts/:id/comments`   | Yes  | Get comments         |
| POST   | `/community/posts/:id/comments`   | Yes  | Add a comment        |

### AI Chat
| Method | Endpoint                          | Auth | Description          |
|--------|-----------------------------------|------|----------------------|
| GET    | `/ai/sessions`                    | Yes  | List chat sessions   |
| POST   | `/ai/sessions`                    | Yes  | Create new session   |
| GET    | `/ai/sessions/:id/messages`       | Yes  | Load session history |
| POST   | `/ai/chat`                        | Yes  | Send message to Nia  |

### Admin (requires admin account)
| Method | Endpoint                              | Auth  | Description            |
|--------|---------------------------------------|-------|------------------------|
| GET    | `/admin/stats`                        | Admin | Dashboard stats        |
| GET    | `/admin/users`                        | Admin | List all users         |
| PUT    | `/admin/users/:id`                    | Admin | Update user (plan etc) |
| GET    | `/admin/posts`                        | Admin | All posts              |
| PUT    | `/admin/posts/:id/moderate`           | Admin | Approve or reject      |
| POST   | `/admin/notifications/broadcast`      | Admin | Send notification      |
| GET    | `/admin/broadcasts`                   | Admin | Broadcast history      |

---

## Database Management

### Backup
```bash
pg_dump -U postgres nia_health > backup_$(date +%Y%m%d).sql
```

### Restore
```bash
psql -U postgres -d nia_health < backup_20250512.sql
```

### Connect via psql
```bash
psql -U postgres -d nia_health
```

---

## Security Checklist for Production

- [ ] Change `JWT_SECRET` to a long random string
- [ ] Set `NODE_ENV=production`
- [ ] Use HTTPS (SSL) — most hosts provide this free
- [ ] Set `FRONTEND_URL` to your actual domain for CORS
- [ ] Keep `ANTHROPIC_API_KEY` private — never commit to git
- [ ] Add `.env` to `.gitignore`
- [ ] Set up regular database backups
- [ ] Consider rate limiting at the DNS/CDN level (Cloudflare)
- [ ] Enable PostgreSQL SSL in production

---

## Troubleshooting

**Database connection failed**
- Check `DATABASE_URL` format: `postgresql://user:pass@host:5432/dbname`
- Make sure PostgreSQL is running: `sudo service postgresql status`
- Check firewall allows port 5432

**AI not responding**
- Verify `ANTHROPIC_API_KEY` is correct and has credits
- Check Anthropic console for rate limit status

**Cannot access admin**
- Make sure you registered with exactly the email in `ADMIN_EMAIL`
- Check the `is_admin` column in the users table: `SELECT email, is_admin FROM users;`
- Manually set admin: `UPDATE users SET is_admin=true WHERE email='your@email.com';`

**Port already in use**
```bash
lsof -i :3000       # find what's using port 3000
kill -9 <PID>       # kill it
```

---

## Support

For technical issues, contact the development team.
niA Health — Built for women. Powered by science.
