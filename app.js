const express = require('express');
const http = require('http');
const cookieSession = require('cookie-session')
const passport = require('passport')
const authRoutes = require('./routes/auth-routes');
const adminRoutes = require('./routes/admin-routes');
const profileRoutes = require('./routes/profile-routes');
const trackRoutes = require('./routes/track-routes');
const passportSetup = require('./config/passport')
const keys = require('./config/keys');
const errorHandler = require('./utilities/errorHandler');
const { ensureAppConfigTable } = require('./utilities/app-config');
const { initializeLogger } = require('./utilities/logger');
const { ensureTrackSoftDeleteColumn } = require('./utilities/track-soft-delete');
const { ensureTrackUniqueActiveIndex } = require('./utilities/track-uniqueness');
const { ensureUserAuthSchema } = require('./utilities/user-auth-schema');

initializeLogger();

const app = express();
const server = http.createServer(app);

const port = keys.port;

// res.authError is set in passport.js if deserialization of user from cookie fails
app.get('/*', (req, res, next) => {
  if ( res.authError ) {
    console.warn('[auth] Session authentication error, redirecting to login', {
      error: res.authError
    });
    res.authError = null;
    res.redirect('/auth/login');
  } else {
    next();
  }
});

// set view engine
app.set('view engine', 'ejs');

app.use(express.static('public'));

app.use(express.json());

// set up session cookies
app.use(cookieSession({
  name: 'google-auth-session',
  maxAge: 365 * 24 * 60 * 60 * 1000,
  keys: [keys.session.cookieKey]
}));

// initialize passport
app.use(passport.initialize());
app.use(passport.session());

app.use((req, res, next) => {
  res.locals.user = req.user;
  res.locals.isAdmin = Boolean(
    req.user &&
    req.user.email &&
    keys.admin.allowedEmails.includes(req.user.email.toLowerCase())
  );
  next();
});

// Handle passport deserializion errors
app.use(function(err, req, res, next) {
  if (err) {
      req.logout();
      res.redirect('/');
  } else {
      next();
  }
});

// set up routes
app.use('/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/profile', profileRoutes);
app.use('/track', trackRoutes);
app.use('/', trackRoutes);

app.use(errorHandler);

server.listen(port, () => {
  console.log(`Price watch listening on port ${port}`)
})

initializeAppConfig();
initializeTrackSoftDelete();
initializeTrackUniqueness();
initializeUserAuthSchema();

async function initializeAppConfig() {
  try {
    await ensureAppConfigTable();
  } catch (error) {
    console.error('[startup] Failed to initialize app_config table', error);
  }
}

async function initializeTrackSoftDelete() {
  try {
    await ensureTrackSoftDeleteColumn();
  } catch (error) {
    console.error('[startup] Failed to initialize track soft delete column', error);
  }
}

async function initializeTrackUniqueness() {
  try {
    await ensureTrackUniqueActiveIndex();
  } catch (error) {
    console.error('[startup] Failed to initialize track uniqueness', error);
  }
}

async function initializeUserAuthSchema() {
  try {
    await ensureUserAuthSchema();
  } catch (error) {
    console.error('[startup] Failed to initialize user auth schema', error);
  }
}
