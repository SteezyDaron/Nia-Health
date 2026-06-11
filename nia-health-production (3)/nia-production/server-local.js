'use strict';
/**
 * niA Health — Local Development Server
 * Uses JSON file storage instead of PostgreSQL.
 * Identical API to server.js — swap to server.js when deploying.
 *
 * Run:  node server-local.js
 * Open: http://localhost:3000
 */

require('dotenv').config({ path: '.env.local' });

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const fs        = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── JSON FILE STORE ──────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'db', 'local-data.json');

const EMPTY_DB = {
  users: [], cycle_logs: [], daily_logs: [], wellness_scores: [],
  posts: [], post_likes: [], post_reports: [], comments: [],
  chat_sessions: [], chat_messages: [],
  notifications: [], broadcasts: [], supplement_logs: [],
};

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { ...EMPTY_DB };
}

function saveDB(data) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let DB = loadDB();
const save = () => saveDB(DB);

// Simple query helpers
const tbl = (name) => DB[name] || [];
const find = (name, pred) => tbl(name).find(pred) || null;
const filter = (name, pred) => tbl(name).filter(pred);
const insert = (name, record) => {
  const row = { id: uuid(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...record };
  DB[name] = [...tbl(name), row];
  save();
  return row;
};
const update = (name, pred, changes) => {
  DB[name] = tbl(name).map(r => pred(r) ? { ...r, ...changes, updated_at: new Date().toISOString() } : r);
  save();
  return find(name, pred);
};
const remove = (name, pred) => { DB[name] = tbl(name).filter(r => !pred(r)); save(); };

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── AI CLIENT ────────────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'missing' });

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const validate = (req, res, next) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) return res.status(400).json({ errors: errs.array() });
  next();
};

const signToken = (user) =>
  jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin },
    process.env.JWT_SECRET, { expiresIn: '7d' });

const safeUser = (u) => ({
  id: u.id, email: u.email, name: u.name, age: u.age,
  goals: u.goals || [], symptoms: u.symptoms || [],
  cycle_length: u.cycle_length || 28, period_length: u.period_length || 5,
  last_period_date: u.last_period_date, plan: u.plan || 'free',
  is_admin: u.is_admin || false, country: u.country,
  avatar_url: u.avatar_url, created_at: u.created_at,
});

const getPhase = (day) => {
  if (day <= 5)  return { phase: 'Menstrual',  emoji: '🩸', color: '#E05A3A' };
  if (day <= 13) return { phase: 'Follicular', emoji: '🌱', color: '#4A8A2E' };
  if (day <= 16) return { phase: 'Ovulation',  emoji: '✨', color: '#7DBE57' };
  return              { phase: 'Luteal',      emoji: '🌙', color: '#7C5CBF' };
};

const getDayOfCycle = (lastDate, cycleLen = 28) => {
  if (!lastDate) return null;
  const diff = Math.floor((Date.now() - new Date(lastDate)) / 86400000);
  return (diff % cycleLen) + 1;
};

const computeScore = (userId) => {
  const since7 = new Date(Date.now() - 7 * 86400000).toISOString();
  const logs7  = filter('daily_logs', l => l.user_id === userId && l.logged_at > since7);
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const logs30  = filter('daily_logs', l => l.user_id === userId && l.logged_at > since30);
  const streakDays = new Set(logs30.map(l => l.logged_at.slice(0, 10))).size;
  const score = Math.min(100, 40 + Math.min(logs7.length * 3, 30) + Math.min(streakDays * 2, 20) + 10);
  return { score, logsThisWeek: logs7.length, streakDays };
};

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const requireAuth = (req, res, next) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorised' });
    const decoded = jwt.verify(h.split(' ')[1], process.env.JWT_SECRET);
    const user = find('users', u => u.id === decoded.id && u.is_active !== false);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
};

const requireAdmin = (req, res, next) =>
  req.user?.is_admin ? next() : res.status(403).json({ error: 'Admin access required' });

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/auth/register',
  body('email').isEmail().normalizeEmail(),
  body('name').trim().isLength({ min: 2 }),
  body('password').isLength({ min: 8 }),
  validate,
  async (req, res) => {
    try {
      const { email, name, password } = req.body;
      if (find('users', u => u.email === email))
        return res.status(409).json({ error: 'An account with this email already exists' });
      const password_hash = await bcrypt.hash(password, 12);
      const is_admin = email === process.env.ADMIN_EMAIL;
      const user = insert('users', { email, name, password_hash, is_admin, plan: 'free',
        goals: [], symptoms: [], cycle_length: 28, period_length: 5 });
      insert('notifications', {
        user_id: user.id, title: '🌿 Welcome to niA Health!',
        body: `Hi ${name}, your wellness journey starts today. Let's build your health profile.`,
        type: 'welcome', is_read: false,
      });
      res.status(201).json({ token: signToken(user), user: safeUser(user) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Registration failed' }); }
  }
);

app.post('/api/auth/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  validate,
  async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = find('users', u => u.email === email);
      if (!user || !(await bcrypt.compare(password, user.password_hash)))
        return res.status(401).json({ error: 'Invalid email or password' });
      res.json({ token: signToken(user), user: safeUser(user) });
    } catch (e) { res.status(500).json({ error: 'Login failed' }); }
  }
);

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: safeUser(req.user) }));

app.put('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { name, age, goals, symptoms, cycle_length, period_length, last_period_date, country } = req.body;
    const updated = update('users', u => u.id === req.user.id, {
      ...(name !== undefined && { name }),
      ...(age !== undefined && { age }),
      ...(goals !== undefined && { goals }),
      ...(symptoms !== undefined && { symptoms }),
      ...(cycle_length !== undefined && { cycle_length }),
      ...(period_length !== undefined && { period_length }),
      ...(last_period_date !== undefined && { last_period_date }),
      ...(country !== undefined && { country }),
    });
    res.json({ user: safeUser(updated) });
  } catch (e) { res.status(500).json({ error: 'Profile update failed' }); }
});

app.put('/api/auth/change-password', requireAuth,
  body('current_password').notEmpty(),
  body('new_password').isLength({ min: 8 }),
  validate,
  async (req, res) => {
    try {
      const { current_password, new_password } = req.body;
      if (!(await bcrypt.compare(current_password, req.user.password_hash)))
        return res.status(400).json({ error: 'Current password is incorrect' });
      const password_hash = await bcrypt.hash(new_password, 12);
      update('users', u => u.id === req.user.id, { password_hash });
      res.json({ message: 'Password updated successfully' });
    } catch { res.status(500).json({ error: 'Password change failed' }); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// CYCLE
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/cycle/current', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const dayOfCycle = getDayOfCycle(u.last_period_date, u.cycle_length);
    const phase = dayOfCycle ? getPhase(dayOfCycle) : null;
    const nextPeriod = u.last_period_date
      ? new Date(new Date(u.last_period_date).getTime() + (u.cycle_length || 28) * 86400000)
      : null;
    const daysUntilNext = nextPeriod ? Math.max(0, Math.floor((nextPeriod - Date.now()) / 86400000)) : null;
    const { score, streakDays } = computeScore(u.id);
    // Save score for today
    const today = new Date().toISOString().slice(0, 10);
    const existing = find('wellness_scores', s => s.user_id === u.id && s.scored_on === today);
    if (existing) update('wellness_scores', s => s.id === existing.id, { score });
    else insert('wellness_scores', { user_id: u.id, score, scored_on: today });
    res.json({ dayOfCycle, phase, nextPeriod, daysUntilNext, cycleLength: u.cycle_length || 28, score, streakDays });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to get cycle data' }); }
});

app.post('/api/cycle/log', requireAuth,
  body('start_date').isISO8601(), validate,
  (req, res) => {
    try {
      const { start_date, notes } = req.body;
      const row = insert('cycle_logs', { user_id: req.user.id, start_date, notes });
      update('users', u => u.id === req.user.id, { last_period_date: start_date });
      res.status(201).json({ cycle: row });
    } catch { res.status(500).json({ error: 'Failed to log period' }); }
  }
);

app.get('/api/cycle/history', requireAuth, (req, res) => {
  const history = filter('cycle_logs', l => l.user_id === req.user.id)
    .sort((a, b) => b.start_date.localeCompare(a.start_date))
    .slice(0, 12);
  res.json({ history });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DAILY LOGS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/logs', requireAuth,
  body('log_type').trim().notEmpty(), validate,
  (req, res) => {
    try {
      const { log_type, value, numeric_value, notes } = req.body;
      const row = insert('daily_logs', {
        user_id: req.user.id, log_type,
        value: value || null,
        numeric_value: numeric_value !== undefined ? parseFloat(numeric_value) : null,
        notes: notes || null,
        logged_at: new Date().toISOString(),
      });
      res.status(201).json({ log: row });
    } catch { res.status(500).json({ error: 'Failed to save log' }); }
  }
);

app.get('/api/logs', requireAuth, (req, res) => {
  const { type, days = 30, limit = 100 } = req.query;
  const since = new Date(Date.now() - parseInt(days) * 86400000).toISOString();
  let logs = filter('daily_logs', l =>
    l.user_id === req.user.id && l.logged_at > since && (!type || l.log_type === type)
  ).sort((a, b) => b.logged_at.localeCompare(a.logged_at)).slice(0, Math.min(parseInt(limit), 500));
  res.json({ logs });
});

app.get('/api/logs/stats', requireAuth, (req, res) => {
  const uid = req.user.id;
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const since7  = new Date(Date.now() - 7 * 86400000).toISOString();
  const logs30  = filter('daily_logs', l => l.user_id === uid && l.logged_at > since30);
  const logs7   = filter('daily_logs', l => l.user_id === uid && l.logged_at > since7);

  // Mood counts
  const moodMap = {};
  logs30.filter(l => l.log_type === 'mood').forEach(l => { moodMap[l.value] = (moodMap[l.value] || 0) + 1; });
  const mood = Object.entries(moodMap).map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);

  // Water avg
  const waterLogs = logs7.filter(l => l.log_type === 'water' && l.numeric_value);
  const avg_glasses = waterLogs.length ? (waterLogs.reduce((a, l) => a + l.numeric_value, 0) / waterLogs.length).toFixed(1) : null;

  // Sleep avg
  const sleepLogs = logs7.filter(l => l.log_type === 'sleep_hours' && l.numeric_value);
  const avg_hours = sleepLogs.length ? (sleepLogs.reduce((a, l) => a + l.numeric_value, 0) / sleepLogs.length).toFixed(1) : null;

  // Streak
  const days = new Set(logs30.map(l => l.logged_at.slice(0, 10))).size;

  // Score history
  const scores = filter('wellness_scores', s => s.user_id === uid)
    .sort((a, b) => b.scored_on.localeCompare(a.scored_on)).slice(0, 12).reverse();

  res.json({ mood, water: { avg_glasses }, sleep: { avg_hours }, streak: { streak: days }, scores });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTS
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/supplements/log', requireAuth,
  body('supplement_name').trim().notEmpty(), validate,
  (req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { supplement_name, dose } = req.body;
      const existing = find('supplement_logs', l => l.user_id === req.user.id && l.supplement_name === supplement_name && l.logged_on === today);
      if (existing) return res.status(201).json({ log: existing });
      const row = insert('supplement_logs', { user_id: req.user.id, supplement_name, dose: dose || '', logged_on: today, taken_at: new Date().toISOString() });
      res.status(201).json({ log: row });
    } catch { res.status(500).json({ error: 'Failed to log supplement' }); }
  }
);

app.get('/api/supplements/today', requireAuth, (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const supplements = filter('supplement_logs', l => l.user_id === req.user.id && l.logged_on === today);
  res.json({ supplements });
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMMUNITY
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/community/posts', requireAuth, (req, res) => {
  const { tag, limit = 20, offset = 0 } = req.query;
  let posts = filter('posts', p => p.status === 'approved' && (!tag || tag === 'All' || p.tag === tag))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(parseInt(offset), parseInt(offset) + Math.min(parseInt(limit), 50));

  posts = posts.map(p => {
    const author = find('users', u => u.id === p.user_id);
    const user_liked = !!find('post_likes', l => l.user_id === req.user.id && l.post_id === p.id);
    return {
      ...p,
      author_name: p.is_anonymous ? 'Anonymous' : (author?.name || 'User'),
      user_liked,
    };
  });
  res.json({ posts });
});

app.post('/api/community/posts', requireAuth,
  body('content').trim().isLength({ min: 10, max: 2000 }),
  validate,
  (req, res) => {
    try {
      const { content, tag, is_anonymous } = req.body;
      const row = insert('posts', {
        user_id: req.user.id, content, tag: tag || 'General',
        is_anonymous: !!is_anonymous, status: 'pending',
        likes_count: 0, comments_count: 0, reports_count: 0,
      });
      res.status(201).json({ post: row, message: 'Post submitted for review. It will appear once approved.' });
    } catch { res.status(500).json({ error: 'Failed to create post' }); }
  }
);

app.post('/api/community/posts/:id/like', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const existing = find('post_likes', l => l.user_id === req.user.id && l.post_id === id);
    if (existing) {
      remove('post_likes', l => l.user_id === req.user.id && l.post_id === id);
      update('posts', p => p.id === id, { likes_count: Math.max(0, (find('posts', p => p.id === id)?.likes_count || 1) - 1) });
      return res.json({ liked: false });
    }
    insert('post_likes', { user_id: req.user.id, post_id: id });
    const post = find('posts', p => p.id === id);
    if (post) update('posts', p => p.id === id, { likes_count: (post.likes_count || 0) + 1 });
    res.json({ liked: true });
  } catch { res.status(500).json({ error: 'Failed to toggle like' }); }
});

app.post('/api/community/posts/:id/report', requireAuth, (req, res) => {
  try {
    const existing = find('post_reports', r => r.user_id === req.user.id && r.post_id === req.params.id);
    if (!existing) {
      insert('post_reports', { user_id: req.user.id, post_id: req.params.id, reason: req.body.reason || '' });
      const post = find('posts', p => p.id === req.params.id);
      if (post) update('posts', p => p.id === req.params.id, { reports_count: (post.reports_count || 0) + 1 });
    }
    res.json({ message: 'Post reported. Our team will review it.' });
  } catch { res.status(500).json({ error: 'Failed to report post' }); }
});

app.get('/api/community/posts/:id/comments', requireAuth, (req, res) => {
  const comments = filter('comments', c => c.post_id === req.params.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(c => {
      const author = find('users', u => u.id === c.user_id);
      return { ...c, author_name: c.is_anonymous ? 'Anonymous' : (author?.name || 'User') };
    });
  res.json({ comments });
});

app.post('/api/community/posts/:id/comments', requireAuth,
  body('content').trim().isLength({ min: 2, max: 1000 }), validate,
  (req, res) => {
    try {
      const { content, is_anonymous } = req.body;
      const row = insert('comments', { post_id: req.params.id, user_id: req.user.id, content, is_anonymous: !!is_anonymous });
      const post = find('posts', p => p.id === req.params.id);
      if (post) update('posts', p => p.id === req.params.id, { comments_count: (post.comments_count || 0) + 1 });
      res.status(201).json({ comment: row });
    } catch { res.status(500).json({ error: 'Failed to add comment' }); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// AI CHAT
// ═══════════════════════════════════════════════════════════════════════════════
let MOCK_IDX = 0;

const NIA_SYSTEM = `You are Nia, a warm, knowledgeable AI health companion specialising in women's hormonal health — especially PCOS, menstrual cycles, nutrition, mood, fitness, and mental wellness.
Your personality: Warm, empathetic, supportive — like a knowledgeable best friend. Science-based but never cold. Practical and actionable. Culturally aware (many users are African women, particularly Kenyan and Nigerian). Never judgmental.
Keep responses concise (2-4 paragraphs), warm, end with one practical actionable tip. Use occasional emojis. NEVER diagnose — encourage professional consultation for serious concerns.`;

app.get('/api/ai/sessions', requireAuth, (req, res) => {
  const sessions = filter('chat_sessions', s => s.user_id === req.user.id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 20);
  res.json({ sessions });
});

app.post('/api/ai/sessions', requireAuth, (req, res) => {
  const session = insert('chat_sessions', { user_id: req.user.id, title: req.body.title || 'New conversation' });
  res.status(201).json({ session });
});

app.get('/api/ai/sessions/:id/messages', requireAuth, (req, res) => {
  const session = find('chat_sessions', s => s.id === req.params.id && s.user_id === req.user.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const messages = filter('chat_messages', m => m.session_id === req.params.id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  res.json({ messages });
});

app.post('/api/ai/chat',
  body('message').trim().isLength({ min: 1, max: 4000 }),
  validate,
  requireAuth,
  async (req, res) => {
    try {
      const { message, session_id } = req.body;
      const u = req.user;

      const noKey = !process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your-key-here';

      // Create/validate session
      let sid = session_id;
      if (!sid) {
        const sess = insert('chat_sessions', { user_id: u.id, title: message.slice(0, 60) });
        sid = sess.id;
      } else {
        const sess = find('chat_sessions', s => s.id === sid && s.user_id === u.id);
        if (!sess) return res.status(404).json({ error: 'Session not found' });
      }

      const now = new Date().toISOString();
      insert('chat_messages', { session_id: sid, user_id: u.id, role: 'user', content: message, created_at: now });

      // ── DEMO MODE (no API key) ────────────────────────────────────────────────
      if (noKey) {
        const day = getDayOfCycle(u.last_period_date, u.cycle_length);
        const phase = day ? getPhase(day) : null;
        const demos = [
          `Hi ${u.name}! 🌿 I'm Nia, your hormonal health companion. I'm running in demo mode — all your data saves and every feature works, I just give placeholder responses until you add your Anthropic API key to .env.local.\n\nCurrent phase: **${phase ? phase.phase : 'Not set yet'}**. Log your last period in Cycle Tracker to unlock phase insights!\n\n💡 Go to Daily Log and track your mood — your wellness score updates in real time.`,
          `Thanks for testing, ${u.name}! 💚 Demo mode response here. The real Nia will give personalised answers based on your cycle phase, symptoms, and health history once your API key is added.\n\nIn the meantime everything else is fully live — log symptoms, track your cycle, browse meal plans, and check the supplement guide.\n\n💡 Check the Supplements tab — tick off what you've taken today and it logs to your health record.`,
          `Great question! 🌸 Demo mode can't give a personalised answer, but here's a real tip: the highest-impact habits for hormonal health are consistent cycle tracking, an anti-inflammatory diet, and the supplement stack in your Supplements tab (especially Inositol + Magnesium for PCOS).\n\n💡 Test the admin panel — scroll to the footer, click the small 'admin' link, and sign in with your admin account.`,
          `I hear you, ${u.name}! 💜 Still in demo mode. Add ANTHROPIC_API_KEY to .env.local and restart the server — then Nia will respond with real, context-aware hormonal health guidance personalised to your cycle and symptoms.\n\n💡 Post something in Community — it goes into a moderation queue you can approve from the admin panel.`,
          `Hello ${u.name}! 🌿 Demo response #5. You've been thorough with testing — that's great! Everything you've tested (auth, logging, cycle tracking, community, supplements, admin) works exactly the same in production.\n\nWhen you add your API key, this chat becomes fully live AI powered by Claude.\n\n💡 Try the Journey tab — your wellness score chart will start showing real data from your logs.`,
        ];
        const reply = demos[MOCK_IDX % demos.length];
        MOCK_IDX++;
        insert('chat_messages', { session_id: sid, user_id: u.id, role: 'assistant', content: reply, created_at: new Date().toISOString() });
        update('chat_sessions', s => s.id === sid, { updated_at: new Date().toISOString() });
        return res.json({ reply, session_id: sid, mode: 'demo' });
      }

      // ── LIVE MODE (API key set) ───────────────────────────────────────────────
      const history = filter('chat_messages', m => m.session_id === sid)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(-20);

      const day = getDayOfCycle(u.last_period_date, u.cycle_length);
      const phase = day ? getPhase(day) : null;
      const contextPrompt = `${NIA_SYSTEM}\n\nUser context:\n- Name: ${u.name}\n- Age: ${u.age || 'not set'}\n- Goals: ${(u.goals || []).join(', ') || 'not set'}\n- Symptoms: ${(u.symptoms || []).join(', ') || 'none'}\n- Cycle day: ${day || 'unknown'} / ${u.cycle_length || 28}\n- Phase: ${phase?.phase || 'unknown'}`;

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
      insert('chat_messages', { session_id: sid, user_id: u.id, role: 'assistant', content: reply, created_at: new Date().toISOString() });
      update('chat_sessions', s => s.id === sid, { updated_at: new Date().toISOString() });

      res.json({ reply, session_id: sid });
    } catch (e) {
      console.error('AI error:', e.message);
      if (e.status === 429) return res.status(429).json({ error: 'AI is busy. Please try again.' });
      res.status(500).json({ error: 'AI temporarily unavailable. Please try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/notifications', requireAuth, (req, res) => {
  const notifications = filter('notifications', n => n.user_id === req.user.id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30);
  res.json({ notifications });
});

app.put('/api/notifications/read-all', requireAuth, (req, res) => {
  DB.notifications = tbl('notifications').map(n =>
    n.user_id === req.user.id ? { ...n, is_read: true } : n
  );
  save();
  res.json({ message: 'All marked as read' });
});

app.put('/api/notifications/:id/read', requireAuth, (req, res) => {
  update('notifications', n => n.id === req.params.id && n.user_id === req.user.id, { is_read: true });
  res.json({ message: 'Marked as read' });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
  const allUsers   = filter('users', u => !u.is_admin);
  const allPosts   = tbl('posts');
  const since24h   = new Date(Date.now() - 86400000).toISOString();
  const msgs24h    = filter('chat_messages', m => m.created_at > since24h && m.role === 'user');
  const newToday   = filter('users', u => u.created_at > since24h && !u.is_admin);
  const logsToday  = new Set(filter('daily_logs', l => l.logged_at > since24h).map(l => l.user_id));
  const since12w   = new Date(Date.now() - 84 * 86400000);

  // Growth per week
  const weekMap = {};
  allUsers.forEach(u => {
    const d = new Date(u.created_at);
    if (d < since12w) return;
    const monday = new Date(d); monday.setDate(d.getDate() - d.getDay() + 1);
    const key = monday.toISOString().slice(0, 10);
    weekMap[key] = (weekMap[key] || 0) + 1;
  });
  const growth = Object.entries(weekMap).sort(([a], [b]) => a.localeCompare(b)).map(([week, signups]) => ({ week, signups }));

  // Plans
  const planMap = {};
  allUsers.forEach(u => { planMap[u.plan || 'free'] = (planMap[u.plan || 'free'] || 0) + 1; });
  const plans = Object.entries(planMap).map(([plan, count]) => ({ plan, count }));

  // Countries
  const countryMap = {};
  allUsers.filter(u => u.country).forEach(u => { countryMap[u.country] = (countryMap[u.country] || 0) + 1; });
  const countries = Object.entries(countryMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([country, count]) => ({ country, count }));

  // Symptoms
  const symMap = {};
  allUsers.forEach(u => (u.symptoms || []).forEach(s => { symMap[s] = (symMap[s] || 0) + 1; }));
  const symptoms = Object.entries(symMap).sort(([, a], [, b]) => b - a).slice(0, 10).map(([symptom, count]) => ({ symptom, count }));

  res.json({
    users:    { total: allUsers.length, active: allUsers.filter(u => u.is_active !== false).length },
    posts:    { total: allPosts.length, pending: filter('posts', p => p.status === 'pending').length, approved: filter('posts', p => p.status === 'approved').length },
    messages: { total: msgs24h.length },
    logsToday: { count: logsToday.size },
    newToday:  { count: newToday.length },
    growth, plans, countries, symptoms,
  });
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
  const { search, plan, limit = 50, offset = 0 } = req.query;
  let users = filter('users', u => !u.is_admin);
  if (search) users = users.filter(u => u.name?.toLowerCase().includes(search.toLowerCase()) || u.email?.toLowerCase().includes(search.toLowerCase()));
  if (plan)   users = users.filter(u => (u.plan || 'free') === plan);
  const total = users.length;
  users = users.sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(parseInt(offset), parseInt(offset) + Math.min(parseInt(limit), 100))
    .map(u => ({
      ...safeUser(u),
      is_active: u.is_active !== false,
      log_count: filter('daily_logs', l => l.user_id === u.id).length,
      streak: new Set(filter('daily_logs', l => l.user_id === u.id && l.logged_at > new Date(Date.now() - 30 * 86400000).toISOString()).map(l => l.logged_at.slice(0, 10))).size,
    }));
  res.json({ users, total });
});

app.put('/api/admin/users/:id', requireAuth, requireAdmin, (req, res) => {
  const { plan, is_active } = req.body;
  const updated = update('users', u => u.id === req.params.id, {
    ...(plan !== undefined && { plan }),
    ...(is_active !== undefined && { is_active }),
  });
  if (!updated) return res.status(404).json({ error: 'User not found' });
  res.json({ user: safeUser(updated) });
});

app.get('/api/admin/posts', requireAuth, requireAdmin, (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  let posts = status ? filter('posts', p => p.status === status) : tbl('posts');
  posts = posts.sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(parseInt(offset), parseInt(offset) + Math.min(parseInt(limit), 100))
    .map(p => {
      const author = find('users', u => u.id === p.user_id);
      return { ...p, author_name: p.is_anonymous ? 'Anonymous' : (author?.name || 'User'), author_email: p.is_anonymous ? '—' : (author?.email || '—') };
    });
  res.json({ posts });
});

app.put('/api/admin/posts/:id/moderate', requireAuth, requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const updated = update('posts', p => p.id === req.params.id, { status });
  if (!updated) return res.status(404).json({ error: 'Post not found' });
  res.json({ post: updated });
});

app.post('/api/admin/notifications/broadcast', requireAuth, requireAdmin,
  body('title').trim().isLength({ min: 2 }),
  body('body').trim().isLength({ min: 5 }),
  body('target').isIn(['all', 'free', 'wellness', 'premium', 'pcos']),
  validate,
  (req, res) => {
    try {
      const { title, body: msgBody, target } = req.body;
      let targetUsers = filter('users', u => u.is_active !== false && !u.is_admin);
      if (target === 'pcos') targetUsers = targetUsers.filter(u => (u.goals || []).includes('Manage PCOS'));
      else if (['free', 'wellness', 'premium'].includes(target)) targetUsers = targetUsers.filter(u => (u.plan || 'free') === target);
      if (targetUsers.length === 0) return res.status(400).json({ error: 'No users match this target' });
      targetUsers.forEach(u => insert('notifications', { user_id: u.id, title, body: msgBody, type: 'broadcast', is_read: false }));
      const broadcast = insert('broadcasts', { admin_id: req.user.id, title, body: msgBody, target_audience: target, recipient_count: targetUsers.length, open_count: 0, sent_at: new Date().toISOString() });
      res.status(201).json({ broadcast, recipientCount: targetUsers.length });
    } catch (e) { res.status(500).json({ error: 'Broadcast failed' }); }
  }
);

app.get('/api/admin/broadcasts', requireAuth, requireAdmin, (req, res) => {
  const broadcasts = tbl('broadcasts').sort((a, b) => b.sent_at.localeCompare(a.sent_at)).slice(0, 20)
    .map(b => ({ ...b, admin_name: find('users', u => u.id === b.admin_id)?.name || 'Admin' }));
  res.json({ broadcasts });
});

// ─── MOBILE PWA ──────────────────────────────────────────────────────────────────
app.get('/mobile', (req, res) => res.redirect('/mobile/'));
app.use('/mobile', express.static(path.join(__dirname, 'public', 'mobile')));
app.get('/mobile/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'mobile', 'index.html')));

// ─── HEALTH + FRONTEND ────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'ok', mode: 'local-dev', storage: 'json-file',
  db_file: DB_FILE, users: tbl('users').length,
  timestamp: new Date().toISOString(),
}));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        🌿  niA Health — Local Dev           ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  URL:     http://localhost:${PORT}              ║`);
  console.log(`║  Storage: JSON file (db/local-data.json)     ║`);
  console.log(`║  AI:      ${process.env.ANTHROPIC_API_KEY ? '✅ API key set' : '⚠️  No API key — set in .env.local'}         ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  Admin email: ${process.env.ADMIN_EMAIL || 'not set (set ADMIN_EMAIL in .env.local)'}`);
  console.log('  Data file:  ', DB_FILE);
  console.log('\n  Press Ctrl+C to stop.\n');
});
