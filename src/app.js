'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const methodOverride = require('method-override');
const { createProxyMiddleware } = require('http-proxy-middleware');
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
// Dynamic reverse proxy
// Cache active projects for 5 seconds to avoid DB hammering
// -------------------------------------------------------------------------
const proxyCache = {
  data: null,
  lastFetched: 0,
  ttl: 5000 // 5 seconds
};

// Map of projectName (lowercase) -> createProxyMiddleware instance
const proxyMiddlewareMap = new Map();

async function getActiveProjects() {
  const now = Date.now();
  if (proxyCache.data && now - proxyCache.lastFetched < proxyCache.ttl) {
    return proxyCache.data;
  }
  try {
    const projects = await query("SELECT name, port, status FROM projects WHERE status = 'active'");
    proxyCache.data = projects;
    proxyCache.lastFetched = now;
    return projects;
  } catch (err) {
    // Return stale cache on DB error rather than crashing
    return proxyCache.data || [];
  }
}

function getOrCreateProxy(projectName, port) {
  const key = `${projectName}:${port}`;
  if (!proxyMiddlewareMap.has(key)) {
    const proxy = createProxyMiddleware({
      target: `http://localhost:${port}`,
      changeOrigin: true,
      ws: true,
      pathRewrite: (reqPath) => {
        // Strip the /projectName prefix
        const prefix = `/${projectName}`;
        if (reqPath.toLowerCase().startsWith(prefix.toLowerCase())) {
          const stripped = reqPath.slice(prefix.length) || '/';
          return stripped;
        }
        return reqPath;
      },
      on: {
        error: (err, req, res) => {
          console.error(`Proxy error for ${projectName}:`, err.message);
          if (res && !res.headersSent) {
            res.status(502).send(`<h1>502 Bad Gateway</h1><p>The application "${projectName}" is not responding.</p>`);
          }
        }
      }
    });
    proxyMiddlewareMap.set(key, proxy);
  }
  return proxyMiddlewareMap.get(key);
}

// Dynamic proxy middleware — runs for all requests
app.use(async (req, res, next) => {
  // Skip admin/auth/webhook routes
  const skipPrefixes = ['/admin', '/auth', '/webhook', '/public'];
  if (skipPrefixes.some((p) => req.path.startsWith(p))) {
    return next();
  }

  // Extract first path segment
  const segments = req.path.split('/').filter(Boolean);
  if (!segments.length) {
    return next();
  }
  const firstSegment = segments[0];

  try {
    const projects = await getActiveProjects();
    const matched = projects.find(
      (p) => p.name.toLowerCase() === firstSegment.toLowerCase()
    );

    if (!matched) {
      return next();
    }

    // Invalidate proxy instances if port changed (stale cache scenario)
    const proxy = getOrCreateProxy(matched.name, matched.port);
    return proxy(req, res, next);
  } catch (err) {
    return next();
  }
});

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
// Start server
// -------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`NodeDeploy portal running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
