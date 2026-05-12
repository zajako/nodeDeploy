'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const methodOverride = require('method-override');
const { query } = require('./config/database');
const passport = require('./config/passport');

const app = express();

// Trust nginx reverse proxy — required for secure cookies and correct
// req.protocol / req.ip when sitting behind nginx.
app.set('trust proxy', 1);

// -------------------------------------------------------------------------
// View engine
// -------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// -------------------------------------------------------------------------
// Security & logging
// -------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'cdn.jsdelivr.net', "'unsafe-inline'"],
        styleSrc: ["'self'", 'cdn.jsdelivr.net', "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'avatars.githubusercontent.com', 'github.com'],
        fontSrc: ["'self'", 'cdn.jsdelivr.net']
      }
    }
  })
);
app.use(morgan('combined'));

// -------------------------------------------------------------------------
// Raw body BEFORE global parsers — needed for webhook signature verification
// -------------------------------------------------------------------------
app.use('/webhook', express.raw({ type: 'application/json' }));

// -------------------------------------------------------------------------
// Body parsers
// -------------------------------------------------------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride('_method'));

// -------------------------------------------------------------------------
// Sessions
// TODO: Replace MemoryStore with a persistent store (e.g., express-mysql-session) for production
// -------------------------------------------------------------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.COOKIE_SECURE === 'true',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    }
  })
);

// -------------------------------------------------------------------------
// Passport
// -------------------------------------------------------------------------
app.use(passport.initialize());
app.use(passport.session());

// -------------------------------------------------------------------------
// Flash messages
// -------------------------------------------------------------------------
app.use(flash());

// Make base domain available in all views as <%= baseDomain %>
app.locals.baseDomain = process.env.BASE_DOMAIN || 'npmdeploy.com';

// Pass flash messages and user to all views via res.locals
app.use((req, res, next) => {
  res.locals.user = req.user || null;
  res.locals.messages = {
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info')
  };
  next();
});

// -------------------------------------------------------------------------
// Static files
// -------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// -------------------------------------------------------------------------
// Routes
// -------------------------------------------------------------------------
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');
const webhookRouter = require('./routes/webhook');

app.use('/auth', authRouter);
app.use('/admin', adminRouter);
app.use('/webhook', webhookRouter);

// Home / dashboard (redirects to admin if logged in, else to login)
app.get('/', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/admin');
  }
  res.redirect('/auth/login');
});

// -------------------------------------------------------------------------
// 404 handler
// -------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('error', {
    title: '404 Not Found - NodeDeploy',
    status: 404,
    message: 'The page you are looking for could not be found.'
  });
});

// -------------------------------------------------------------------------
// Error handler
// -------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err.stack);
  const status = err.status || 500;
  res.status(status).render('error', {
    title: `${status} Error - NodeDeploy`,
    status,
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred.' : err.message
  });
});

// -------------------------------------------------------------------------
// Security: strip portal-private vars from process.env
// All modules above have already captured their values into module-level
// constants. Removing these now ensures that if PM2 forks its daemon from
// this process, the daemon will NOT inherit the portal's credentials and
// cannot pass them to deployed apps.
// -------------------------------------------------------------------------
const PORTAL_PRIVATE_KEYS = [
  'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD',
  'SESSION_SECRET',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_CALLBACK_URL',
  'ADMIN_GITHUB_USERNAMES'
];
for (const key of PORTAL_PRIVATE_KEYS) delete process.env[key];

// -------------------------------------------------------------------------
// Start server
// -------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const { ensureConfExists, generateNginxConfig } = require('./services/nginxService');

app.listen(PORT, async () => {
  console.log(`NodeDeploy portal running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  // Sync nginx projects.conf with the database on every startup
  await ensureConfExists();
  await generateNginxConfig();
});

module.exports = app;
