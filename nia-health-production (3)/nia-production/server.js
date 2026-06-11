'use strict';
require('dotenv').config();

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, param, query, validationResult } = require('express-validator');
const Anthropic  = require('@anthropic-ai/sdk');
const path       = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── DATABASE ────────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

db.on('error', (err) => console.error('Unexpected DB error', err));

// ─── AI CLIENT ───────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.FRONTEND_URL : '*',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Please try again in 15 minutes.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'AI rate limit reached. Please wait a moment.' } });
app.use('/api/', limiter);
app.use('/api/auth/', authLimiter);
app.use('/api/ai/', aiLimiter);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
  next();
};

const signToken = (user) => jwt.sign(
  { id: user.id, email: user.email, is_admin: user.is_admin },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

const safeUser = (u) => ({
  id: u.id, email: u.email, name: u.name, age: u.age,
  goals: u.goals, symptoms: u.symptoms, cycle_length: u.cycle_length,
  period_length: u.period_length, last_period_date: u.last_period_date,
  plan: u.plan, is_admin: u.is_admin, country: u.country,
  avatar_url: u.avatar_url, created_at: u.created_at,
});

const getPhase = (dayOfCycle) => {
  if (dayOfCycle <= 5)  return { phase: 'Menstrual',   emoji: '🩸', color: '#E05A3A' };
  if (dayOfCycle <= 13) return { phase: 'Follicular',  emoji: '🌱', color: '#4A8A2E' };
  if (dayOfCycle <= 16) return { phase: 'Ovulation',   emoji: '✨', color: '#7DBE57' };
  return                       { phase: 'Luteal',      emoji: '🌙', color: '#7C5CBF' };
};

const getDayOfCycle = (lastPeriodDate, cycleLength = 28) => {
  if (!lastPeriodDate) return null;
  const last = new Date(lastPeriodDate);
  const now  = new Date();
  const diff = Math.floor((now - last) / (1000 * 60 * 60 * 24));
  return (diff % cycleLength) + 1;
};

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorised' });
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1 AND is_active = true', [decoded.id]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
  next();
};

// ─── WELLNESS SCORE ───────────────────────────────────────────────────────────
const computeWellnessScore = async (userId) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { rows: logs } = await db.query(
    'SELECT log_type, COUNT(*) as count FROM daily_logs WHERE user_id=$1 AND logged_at > $2 GROUP BY log_type',
    [userId, sevenDaysAgo]
  );
  const { rows: streakRows } = await db.query(
    `SELECT COUNT(DISTINCT DATE(logged_at)) as days FROM daily_logs WHERE user_id=$1 AND logged_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const logsThisWeek = logs.reduce((a, r) => a + parseInt(r.count), 0);
  const streakDays   = parseInt(streakRows[0]?.days || 0);
  const score = Math.min(100, 40 + Math.min(logsThisWeek * 3, 30) + Math.min(streakDays * 2, 20) + 10);
  return { score, logsThisWeek, streakDays };
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register',
  body('email').isEmail().normalizeEmail(),
  body('name').trim().isLength({ min: 2, max: 100 }),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  validate,
  async (req, res) => {
    try {
      const { email, name, password } = req.body;
      const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
      if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists' });
      const password_hash = await bcrypt.hash(password, 12);
      const is_admin = email === process.env.ADMIN_EMAIL;
      const { rows } = await db.query(
        `INSERT INTO users (email, name, password_hash, is_admin)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [email, name, password_hash, is_admin]
      );
      const user = rows[0];
      // Welcome notification
      await db.query(
        `INSERT INTO notifications (user_id, title, body, type) VALUES ($1, $2, $3, $4)`,
        [user.id, '🌿 Welcome to niA Health!', `Hi ${name}, your wellness journey starts today. Let's build your health profile.`, 'welcome']
      );
      res.status(201).json({ token: signToken(user), user: safeUser(user) });
    } catch (e) {
      console.error('Register error:', e);
      res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
  }
);

app.post('/api/auth/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const { rows } = await db.query('SELECT * FROM users WHERE email=$1 AND is_active=true', [email]);
      const user = rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ error: 'Invalid email or password' });
      res.json({ token: signToken(user), user: safeUser(user) });
    } catch (e) {
      console.error('Login error:', e);
      res.status(500).json({ error: 'Login failed. Please try again.' });
    }
  }
);

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

app.put('/api/auth/me',
  requireAuth,
  body('name').optional().trim().isLength({ min: 2, max: 100 }),
  body('age').optional().isInt({ min: 13, max: 100 }),
  body('cycle_length').optional().isInt({ min: 20, max: 45 }),
  body('period_length').optional().isInt({ min: 1, max: 10 }),
  validate,
  async (req, res) => {
    try {
      const { name, age, goals, symptoms, cycle_length, period_length, last_period_date, country } = req.body;
      const { rows } = await db.query(
        `UPDATE users SET
          name = COALESCE($1, name),
          age = COALESCE($2, age),
          goals = COALESCE($3, goals),
          symptoms = COALESCE($4, symptoms),
          cycle_length = COALESCE($5, cycle_length),
          period_length = COALESCE($6, period_length),
          last_period_date = COALESCE($7, last_period_date),
          country = COALESCE($8, country),
          updated_at = NOW()
         WHERE id=$9 RETURNING *`,
        [name, age, goals, symptoms, cycle_length, period_length, last_period_date, country, req.user.id]
      );
      res.json({ user: safeUser(rows[0]) });
    } catch (e) {
      console.error('Update profile error:', e);
      res.status(500).json({ error: 'Profile update failed' });
    }
  }
);

app.put('/api/auth/change-password',
  requireAuth,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }),
  validate,
  async (req, res) => {
    try {
      const { current_password, new_password } = req.body;
      if (!(await bcrypt.compare(current_password, req.user.password_hash)))
        return res.status(400).json({ error: 'Current password is incorrect' });
      const password_hash = await bcrypt.hash(new_password, 12);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [password_hash, req.user.id]);
      res.json({ message: 'Password updated successfully' });
    } catch (e) {
      res.status(500).json({ error: 'Password change failed' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/cycle/current', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const dayOfCycle = getDayOfCycle(user.last_period_date, user.cycle_length);
    const phaseInfo = dayOfCycle ? getPhase(dayOfCycle) : null;
    const nextPeriod = user.last_period_date
      ? new Date(new Date(user.last_period_date).getTime() + user.cycle_length * 86400000)
      : null;
    const daysUntilNext = nextPeriod
      ? Math.max(0, Math.floor((nextPeriod - new Date()) / 86400000))
      : null;
    const { score, logsThisWeek, streakDays } = await computeWellnessScore(user.id);
    // Upsert today's score
    await db.query(
      `INSERT INTO wellness_scores (user_id, score, scored_on, breakdown)
       VALUES ($1,$2,CURRENT_DATE,$3)
       ON CONFLICT (user_id, scored_on) DO UPDATE SET score=EXCLUDED.score, breakdown=EXCLUDED.breakdown`,
      [user.id, score, JSON.stringify({ logsThisWeek, streakDays })]
    );
    res.json({ dayOfCycle, phase: phaseInfo, nextPeriod, daysUntilNext, cycleLength: user.cycle_length, score, streakDays });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to get cycle data' });
  }
});

app.post('/api/cycle/log', requireAuth,
  body('start_date').isISO8601(),
  validate,
  async (req, res) => {
    try {
      const { start_date, notes } = req.body;
      const { rows } = await db.query(
        `INSERT INTO cycle_logs (user_id, start_date, notes) VALUES ($1,$2,$3) RETURNING *`,
        [req.user.id, start_date, notes]
      );
      await db.query(
        `UPDATE users SET last_period_date=$1 WHERE id=$2`,
        [start_date, req.user.id]
      );
      res.status(201).json({ cycle: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to log period' });
    }
  }
);

app.get('/api/cycle/history', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM cycle_logs WHERE user_id=$1 ORDER BY start_date DESC LIMIT 12`,
      [req.user.id]
    );
    res.json({ history: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch cycle history' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY LOGS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/logs', requireAuth,
  body('log_type').trim().notEmpty(),
  body('value').optional().trim(),
  body('numeric_value').optional().isFloat(),
  validate,
  async (req, res) => {
    try {
      const { log_type, value, numeric_value, notes } = req.body;
      const { rows } = await db.query(
        `INSERT INTO daily_logs (user_id, log_type, value, numeric_value, notes)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user.id, log_type, value, numeric_value, notes]
      );
      res.status(201).json({ log: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to save log' });
    }
  }
);

app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const { type, days = 30, limit = 100 } = req.query;
    const since = new Date(Date.now() - parseInt(days) * 86400000);
    let q = `SELECT * FROM daily_logs WHERE user_id=$1 AND logged_at > $2`;
    const params = [req.user.id, since];
    if (type) { q += ` AND log_type=$3`; params.push(type); }
    q += ` ORDER BY logged_at DESC LIMIT $${params.length + 1}`;
    params.push(Math.min(parseInt(limit), 500));
    const { rows } = await db.query(q, params);
    res.json({ logs: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

app.get('/api/logs/stats', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const [moodRes, waterRes, sleepRes, streakRes, scoreRes] = await Promise.all([
      db.query(`SELECT value, COUNT(*) as count FROM daily_logs WHERE user_id=$1 AND log_type='mood' AND logged_at > NOW()-INTERVAL '30 days' GROUP BY value ORDER BY COUNT(*) DESC`, [uid]),
      db.query(`SELECT AVG(numeric_value) as avg_glasses FROM daily_logs WHERE user_id=$1 AND log_type='water' AND logged_at > NOW()-INTERVAL '7 days'`, [uid]),
      db.query(`SELECT AVG(numeric_value) as avg_hours FROM daily_logs WHERE user_id=$1 AND log_type='sleep_hours' AND logged_at > NOW()-INTERVAL '7 days'`, [uid]),
      db.query(`SELECT COUNT(DISTINCT DATE(logged_at)) as streak FROM daily_logs WHERE user_id=$1 AND logged_at > NOW()-INTERVAL '30 days'`, [uid]),
      db.query(`SELECT score, scored_on FROM wellness_scores WHERE user_id=$1 ORDER BY scored_on DESC LIMIT 12`, [uid]),
    ]);
    res.json({
      mood:    moodRes.rows,
      water:   waterRes.rows[0],
      sleep:   sleepRes.rows[0],
      streak:  streakRes.rows[0],
      scores:  scoreRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENT LOGS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/supplements/log', requireAuth,
  body('supplement_name').trim().notEmpty(),
  validate,
  async (req, res) => {
    try {
      const { supplement_name, dose } = req.body;
      const { rows } = await db.query(
        `INSERT INTO supplement_logs (user_id, supplement_name, dose)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING RETURNING *`,
        [req.user.id, supplement_name, dose]
      );
      res.status(201).json({ log: rows[0] || { message: 'Already logged today' } });
    } catch (e) {
      res.status(500).json({ error: 'Failed to log supplement' });
    }
  }
);

app.get('/api/supplements/today', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT supplement_name, dose, taken_at FROM supplement_logs
       WHERE user_id=$1 AND logged_on=CURRENT_DATE ORDER BY taken_at DESC`,
      [req.user.id]
    );
    res.json({ supplements: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch supplements' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUNITY ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/community/posts', requireAuth, async (req, res) => {
  try {
    const { tag, limit = 20, offset = 0 } = req.query;
    let q = `
      SELECT p.*, 
        CASE WHEN p.is_anonymous THEN 'Anonymous' ELSE u.name END as author_name,
        CASE WHEN p.is_anonymous THEN NULL ELSE u.avatar_url END as author_avatar,
        EXISTS(SELECT 1 FROM post_likes pl WHERE pl.post_id=p.id AND pl.user_id=$1) as user_liked
      FROM posts p
      JOIN users u ON u.id = p.user_id
      WHERE p.status='approved'`;
    const params = [req.user.id];
    if (tag && tag !== 'All') { q += ` AND p.tag=$${params.length+1}`; params.push(tag); }
    q += ` ORDER BY p.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Math.min(parseInt(limit), 50), parseInt(offset));
    const { rows } = await db.query(q, params);
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

app.post('/api/community/posts', requireAuth,
  body('content').trim().isLength({ min: 10, max: 2000 }),
  body('tag').optional().trim(),
  body('is_anonymous').optional().isBoolean(),
  validate,
  async (req, res) => {
    try {
      const { content, tag, is_anonymous } = req.body;
      const { rows } = await db.query(
        `INSERT INTO posts (user_id, content, tag, is_anonymous, status)
         VALUES ($1,$2,$3,$4,'pending') RETURNING *`,
        [req.user.id, content, tag, is_anonymous || false]
      );
      res.status(201).json({ post: rows[0], message: 'Post submitted for review. It will appear once approved.' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to create post' });
    }
  }
);

app.post('/api/community/posts/:id/like', requireAuth,
  param('id').isUUID(),
  validate,
  async (req, res) => {
    try {
      const { id } = req.params;
      const existing = await db.query('SELECT 1 FROM post_likes WHERE user_id=$1 AND post_id=$2', [req.user.id, id]);
      if (existing.rows[0]) {
        await db.query('DELETE FROM post_likes WHERE user_id=$1 AND post_id=$2', [req.user.id, id]);
        await db.query('UPDATE posts SET likes_count = likes_count - 1 WHERE id=$1', [id]);
        return res.json({ liked: false });
      }
      await db.query('INSERT INTO post_likes (user_id, post_id) VALUES ($1,$2)', [req.user.id, id]);
      await db.query('UPDATE posts SET likes_count = likes_count + 1 WHERE id=$1', [id]);
      res.json({ liked: true });
    } catch (e) {
      res.status(500).json({ error: 'Failed to toggle like' });
    }
  }
);

app.post('/api/community/posts/:id/report', requireAuth,
  param('id').isUUID(),
  validate,
  async (req, res) => {
    try {
      const { reason } = req.body;
      await db.query('INSERT INTO post_reports (user_id, post_id, reason) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.user.id, req.params.id, reason]);
      await db.query('UPDATE posts SET reports_count = reports_count + 1 WHERE id=$1', [req.params.id]);
      res.json({ message: 'Post reported. Our team will review it.' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to report post' });
    }
  }
);

app.get('/api/community/posts/:id/comments', requireAuth, param('id').isUUID(), validate, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.*,
         CASE WHEN c.is_anonymous THEN 'Anonymous' ELSE u.name END as author_name
       FROM comments c JOIN users u ON u.id=c.user_id
       WHERE c.post_id=$1 ORDER BY c.created_at ASC`,
      [req.params.id]
    );
    res.json({ comments: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

app.post('/api/community/posts/:id/comments', requireAuth,
  param('id').isUUID(),
  body('content').trim().isLength({ min: 2, max: 1000 }),
  validate,
  async (req, res) => {
    try {
      const { content, is_anonymous } = req.body;
      const { rows } = await db.query(
        `INSERT INTO comments (post_id, user_id, content, is_anonymous) VALUES ($1,$2,$3,$4) RETURNING *`,
        [req.params.id, req.user.id, content, is_anonymous || false]
      );
      await db.query('UPDATE posts SET comments_count = comments_count + 1 WHERE id=$1', [req.params.id]);
      res.status(201).json({ comment: rows[0] });
    } catch (e) {
      res.status(500).json({ error: 'Failed to add comment' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// AI CHAT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
const NIA_SYSTEM = `You are Nia, a warm, knowledgeable AI health companion specialising in women's hormonal health — especially PCOS, menstrual cycles, nutrition, mood, fitness, and mental wellness.

Your personality: Warm, empathetic, supportive — like a knowledgeable best friend. Science-based but never cold. Practical and actionable. Culturally aware (many users are African women, particularly Kenyan and Nigerian). Never judgmental. Always encouraging.

You help with: PCOS management, cycle tracking and phase insights, nutrition guidance (including African and Kenyan foods like ugali, sukuma wiki, githeri, tilapia, mukimo), exercise recommendations based on cycle phase, mood and stress support, sleep tips, supplement guidance (inositol, magnesium, vitamin D, omega-3, spearmint tea, NAC), understanding symptoms, and emotional support.

Keep responses concise (2-4 paragraphs), warm, end with one practical actionable tip. Use occasional relevant emojis naturally. NEVER diagnose medical conditions — always encourage professional medical consultation for serious concerns. You are a companion, not a doctor.`;

app.get('/api/ai/sessions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, title, created_at, updated_at FROM chat_sessions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ sessions: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.post('/api/ai/sessions', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *`,
      [req.user.id, req.body.title || 'New conversation']
    );
    res.status(201).json({ session: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

app.get('/api/ai/sessions/:id/messages', requireAuth, param('id').isUUID(), validate, async (req, res) => {
  try {
    const { rows: sessionRows } = await db.query('SELECT * FROM chat_sessions WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!sessionRows[0]) return res.status(404).json({ error: 'Session not found' });
    const { rows } = await db.query('SELECT * FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ messages: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/ai/chat', requireAuth,
  body('message').trim().isLength({ min: 1, max: 4000 }),
  body('session_id').optional().isUUID(),
  validate,
  async (req, res) => {
    try {
      const { message, session_id } = req.body;
      const user = req.user;

      // Get or create session
      let sid = session_id;
      if (!sid) {
        const { rows } = await db.query(
          `INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id`,
          [user.id, message.slice(0, 60)]
        );
        sid = rows[0].id;
      }

      // Verify session belongs to user
      const { rows: sess } = await db.query('SELECT id FROM chat_sessions WHERE id=$1 AND user_id=$2', [sid, user.id]);
      if (!sess[0]) return res.status(404).json({ error: 'Session not found' });

      // Load conversation history
      const { rows: history } = await db.query(
        `SELECT role, content FROM chat_messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT 20`,
        [sid]
      );

      // Build context-aware system prompt
      const day = getDayOfCycle(user.last_period_date, user.cycle_length);
      const phase = day ? getPhase(day) : null;
      const contextPrompt = `${NIA_SYSTEM}

Current user context:
- Name: ${user.name}
- Age: ${user.age || 'not specified'}
- Goals: ${(user.goals || []).join(', ') || 'not set'}
- Symptoms: ${(user.symptoms || []).join(', ') || 'none recorded'}
- Cycle day: ${day || 'unknown'} of ${user.cycle_length} days
- Current phase: ${phase?.phase || 'unknown'}
Use this context to personalise your responses.`;

      // Call Anthropic
      const aiResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: contextPrompt,
        messages: [
          ...history.map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: message },
        ],
      });

      const reply = aiResponse.content[0].text;

      // Save both messages
      await db.query(
        `INSERT INTO chat_messages (session_id, user_id, role, content) VALUES ($1,$2,'user',$3), ($1,$2,'assistant',$4)`,
        [sid, user.id, message, reply]
      );
      await db.query('UPDATE chat_sessions SET updated_at=NOW() WHERE id=$1', [sid]);

      res.json({ reply, session_id: sid });
    } catch (e) {
      console.error('AI chat error:', e);
      if (e.status === 429) return res.status(429).json({ error: 'AI service is busy. Please try again.' });
      res.status(500).json({ error: 'Failed to get AI response' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [req.user.id]
    );
    res.json({ notifications: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read=true WHERE user_id=$1', [req.user.id]);
    res.json({ message: 'All notifications marked as read' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

app.put('/api/notifications/:id/read', requireAuth, param('id').isUUID(), validate, async (req, res) => {
  try {
    await db.query('UPDATE notifications SET is_read=true WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'Notification marked as read' });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [users, posts, messages, logsToday, newToday] = await Promise.all([
      db.query('SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE is_active) as active FROM users WHERE NOT is_admin'),
      db.query("SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='pending') as pending, COUNT(*) FILTER (WHERE status='approved') as approved FROM posts"),
      db.query('SELECT COUNT(*) as total FROM chat_messages WHERE created_at > NOW()-INTERVAL \'24 hours\''),
      db.query('SELECT COUNT(DISTINCT user_id) as count FROM daily_logs WHERE logged_at > NOW()-INTERVAL \'24 hours\''),
      db.query('SELECT COUNT(*) as count FROM users WHERE created_at > NOW()-INTERVAL \'24 hours\' AND NOT is_admin'),
    ]);
    const [plans, countries, symptoms, growth] = await Promise.all([
      db.query('SELECT plan, COUNT(*) as count FROM users WHERE NOT is_admin GROUP BY plan'),
      db.query('SELECT country, COUNT(*) as count FROM users WHERE country IS NOT NULL AND NOT is_admin GROUP BY country ORDER BY count DESC LIMIT 10'),
      db.query(`SELECT unnest(symptoms) as symptom, COUNT(*) as count FROM users WHERE NOT is_admin GROUP BY symptom ORDER BY count DESC LIMIT 10`),
      db.query(`SELECT DATE_TRUNC('week', created_at) as week, COUNT(*) as signups FROM users WHERE NOT is_admin AND created_at > NOW()-INTERVAL '12 weeks' GROUP BY week ORDER BY week`),
    ]);
    res.json({
      users:    users.rows[0],
      posts:    posts.rows[0],
      messages: messages.rows[0],
      logsToday: logsToday.rows[0],
      newToday: newToday.rows[0],
      plans:    plans.rows,
      countries: countries.rows,
      symptoms: symptoms.rows,
      growth:   growth.rows,
    });
  } catch (e) {
    console.error('Admin stats error:', e);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { search, plan, limit = 50, offset = 0 } = req.query;
    let q = `SELECT id, email, name, age, goals, symptoms, plan, is_active, country, created_at,
              (SELECT COUNT(*) FROM daily_logs WHERE user_id=users.id) as log_count,
              (SELECT COUNT(DISTINCT DATE(logged_at)) FROM daily_logs WHERE user_id=users.id AND logged_at > NOW()-INTERVAL '30 days') as streak
             FROM users WHERE NOT is_admin`;
    const params = [];
    if (search) { params.push(`%${search}%`); q += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length})`; }
    if (plan)   { params.push(plan); q += ` AND plan=$${params.length}`; }
    q += ` ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Math.min(parseInt(limit), 100), parseInt(offset));
    const { rows } = await db.query(q, params);
    const total = await db.query('SELECT COUNT(*) FROM users WHERE NOT is_admin');
    res.json({ users: rows, total: parseInt(total.rows[0].count) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/users/:id', requireAuth, requireAdmin, param('id').isUUID(), validate, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT u.*, 
        (SELECT COUNT(*) FROM daily_logs WHERE user_id=u.id) as total_logs,
        (SELECT COUNT(*) FROM chat_sessions WHERE user_id=u.id) as chat_sessions,
        (SELECT score FROM wellness_scores WHERE user_id=u.id ORDER BY scored_on DESC LIMIT 1) as latest_score
      FROM users u WHERE u.id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: safeUser(rows[0]), meta: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, param('id').isUUID(), validate, async (req, res) => {
  try {
    const { plan, is_active } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET plan=COALESCE($1,plan), is_active=COALESCE($2,is_active) WHERE id=$3 RETURNING *`,
      [plan, is_active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: safeUser(rows[0]) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.get('/api/admin/posts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    let q = `SELECT p.*, CASE WHEN p.is_anonymous THEN 'Anonymous' ELSE u.name END as author_name, u.email as author_email
             FROM posts p JOIN users u ON u.id=p.user_id`;
    const params = [];
    if (status) { params.push(status); q += ` WHERE p.status=$1`; }
    q += ` ORDER BY p.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(Math.min(parseInt(limit), 100), parseInt(offset));
    const { rows } = await db.query(q, params);
    res.json({ posts: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

app.put('/api/admin/posts/:id/moderate', requireAuth, requireAdmin, param('id').isUUID(), validate, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['approved','rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await db.query(
      `UPDATE posts SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: rows[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to moderate post' });
  }
});

app.post('/api/admin/notifications/broadcast', requireAuth, requireAdmin,
  body('title').trim().isLength({ min: 2, max: 200 }),
  body('body').trim().isLength({ min: 5, max: 2000 }),
  body('target').isIn(['all', 'free', 'wellness', 'premium', 'pcos']),
  validate,
  async (req, res) => {
    try {
      const { title, body: msgBody, target } = req.body;
      // Build user query based on target
      let userQuery = 'SELECT id FROM users WHERE is_active=true AND NOT is_admin';
      if (target === 'pcos') userQuery += " AND 'Manage PCOS'=ANY(goals)";
      else if (['free','wellness','premium'].includes(target)) userQuery += ` AND plan='${target}'`;
      const { rows: targetUsers } = await db.query(userQuery);
      if (targetUsers.length === 0) return res.status(400).json({ error: 'No users match this target' });
      // Insert notifications in batches
      const insertValues = targetUsers.map((u, i) => `($${i*4+1},$${i*4+2},$${i*4+3},'broadcast')`);
      const insertParams = targetUsers.flatMap(u => [u.id, title, msgBody]);
      await db.query(
        `INSERT INTO notifications (user_id, title, body, type) VALUES ${insertValues.join(',')}`,
        insertParams
      );
      // Log broadcast
      const { rows: broadcast } = await db.query(
        `INSERT INTO broadcasts (admin_id, title, body, target_audience, recipient_count) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user.id, title, msgBody, target, targetUsers.length]
      );
      res.status(201).json({ broadcast: broadcast[0], recipientCount: targetUsers.length });
    } catch (e) {
      console.error('Broadcast error:', e);
      res.status(500).json({ error: 'Failed to send broadcast' });
    }
  }
);

app.get('/api/admin/broadcasts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT b.*, u.name as admin_name FROM broadcasts b LEFT JOIN users u ON u.id=b.admin_id ORDER BY b.sent_at DESC LIMIT 20`
    );
    res.json({ broadcasts: rows });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch broadcasts' });
  }
});

// ─── MOBILE PWA ──────────────────────────────────────────────────────────────────
app.get('/mobile', (req, res) => res.redirect('/mobile/'));
app.use('/mobile', express.static(path.join(__dirname, 'public', 'mobile')));
app.get('/mobile/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile', 'index.html')));

// ─── PAYMENT ROUTES ──────────────────────────────────────────────────────────
const paymentRoutes = require('./routes/payments');
app.use('/api/payments', (req,res,next)=>{req.db=db;next()}, requireAuth, paymentRoutes);
app.use('/api/admin/revenue', (req,res,next)=>{req.db=db;next()}, requireAuth, requireAdmin, paymentRoutes);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
  } catch {
    res.status(503).json({ status: 'db_error' });
  }
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🌿 niA Health server running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   API: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
