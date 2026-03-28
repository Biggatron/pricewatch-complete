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
const crawler = require('./utilities/crawler');
const constants = require('./config/const');
const { ensureAppConfigTable, getAppConfig } = require('./utilities/app-config');
const { initializeLogger } = require('./utilities/logger');

initializeLogger();

const app = express();
const server = http.createServer(app);

const port = keys.port;

// res.authError is set in passport.js if deserialization of user from cookie fails
app.get('/*', (req, res, next) => {
  if ( res.authError ) {
    console.log(res.authError)
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

startCrawlerScheduler();

async function startCrawlerScheduler() {
  try {
    await ensureAppConfigTable();
  } catch (error) {
    console.error('[scheduler] Failed to initialize app_config table', error);
  }

  scheduleNextCrawlerRun();
}

async function scheduleNextCrawlerRun() {
  const intervalMs = await getCrawlerScheduleInterval();

  console.info('[scheduler] Next crawler run scheduled', {
    intervalMs
  });

  setTimeout(async () => {
    try {
      const schedulerEnabled = await getAppConfig('crawler.schedule.enabled', true);

      if (schedulerEnabled) {
        await crawler.updatePrices({ triggerType: 'scheduled' });
      } else {
        console.info('[scheduler] Scheduled crawler run skipped because scheduler is disabled');
      }
    } catch (error) {
      console.error('[scheduler] Scheduled crawler run failed', error);
    } finally {
      scheduleNextCrawlerRun();
    }
  }, intervalMs);
}

async function getCrawlerScheduleInterval() {
  const intervalMs = await getAppConfig(
    'crawler.schedule.interval_ms',
    constants.crawler.intervalTime
  );

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return constants.crawler.intervalTime;
  }

  return intervalMs;
}
