const router = require('express').Router();
const keys = require('../config/keys');
const { readRecentLogs, getLogFilePath } = require('../utilities/logger');
const {
  getRecentCrawlerFailureLogs,
  getCrawlerFailureLogById
} = require('../utilities/crawler-failure-log');

const authCheck = (req, res, next) => {
  if (!req.user) {
    res.redirect('/auth/login');
  } else {
    next();
  }
};

const adminCheck = (req, res, next) => {
  const userEmail = ((req.user && req.user.email) || '').toLowerCase();
  if (!keys.admin.allowedEmails.includes(userEmail)) {
    return res.status(403).render('admin', {
      user: req.user,
      logs: [],
      logFilePath: getLogFilePath(),
      accessDenied: true
    });
  }
  next();
};

router.get('/', authCheck, adminCheck, async (req, res, next) => {
  try {
    const [logs, failedUpdates] = await Promise.all([
      readRecentLogs(),
      getRecentCrawlerFailureLogs()
    ]);

    res.render('admin', {
      user: req.user,
      logs,
      failedUpdates,
      logFilePath: getLogFilePath(),
      accessDenied: false
    });
  } catch (error) {
    next(error);
  }
});

router.get('/failed-updates/:id', authCheck, adminCheck, async (req, res, next) => {
  try {
    const failure = await getCrawlerFailureLogById(req.params.id);
    if (!failure) {
      return res.status(404).send('Failed update log not found');
    }

    res.render('admin-failure-detail', {
      user: req.user,
      failure
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
