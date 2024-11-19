const express = require('express');
const http = require('http');
const cookieSession = require('cookie-session')
const passport = require('passport')
const authRoutes = require('./routes/auth-routes');
const profileRoutes = require('./routes/profile-routes');
const otherRoutes = require('./routes/other-routes');
const passportSetup = require('./config/passport')
const keys = require('./config/keys');
const errorHandler = require('./utilities/errorHandler');

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
app.use('/profile', profileRoutes);
app.use('/other', otherRoutes);

app.get('/', (req, res) => {
    res.render('home', { user: req.user });
})

app.use(errorHandler);

server.listen(port, () => {
  console.log(`Template app listening on port ${port}`)
})