const router = require('express').Router();
const keys = require('../config/keys');
const { readRecentLogs, getLogFilePath } = require('../utilities/logger');

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
    const logs = await readRecentLogs();
    res.render('admin', {
      user: req.user,
      logs,
      logFilePath: getLogFilePath(),
      accessDenied: false
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
