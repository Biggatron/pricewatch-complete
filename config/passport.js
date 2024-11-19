const passport = require('passport');
const query = require('../db/db');
const GoogleStrategy = require('passport-google-oauth2').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const crypto  = require('crypto');

const keys = require('./keys');
  
passport.serializeUser((user , done) => {
    console.log("user.id: " + user.id)
    done(null , user.id);
}),

passport.deserializeUser(async (id, done) => {
  console.log("id: " + id)
  // Look up user id in database
  const result = await query(
    'SELECT * FROM user_account WHERE id = $1',
    [id]
  );
  console.log("length: " + result.rows.length)
  if (result.rows.length !== 0){
    var user = {
      id : result.rows[0].id,
      name : result.rows[0].name,
      email : result.rows[0].email
    };
    console.log(user);
    done(null, user);
  } else {
    done('authError', null);
  }
});  
  
passport.use(new GoogleStrategy({
    clientID: keys.google.clientID,
    clientSecret: keys.google.clientSecret,
    callbackURL:keys.google.callbackURL,
    passReqToCallback:true
  },
  async function(request, accessToken, refreshToken, profile, done) {
    // Check if user exists in database
    const result = await query(
      'SELECT * FROM user_account WHERE google_id = $1',
      [profile.id]
    );
    if (result.rows.length === 0){
      console.log(profile.email)
      console.log(profile.displayName)
      console.log(profile)
      // User does not exist a new one is created
      const result = await query(
        'INSERT INTO user_account (google_id, name, email, created_at) VALUES ($1, $2, $3, $4) RETURNING *',
        [profile.id, profile.displayName, profile.email, new Date()]
      );
      if (result.rows.length === 0) {
          res.status(500).json({
              message: 'Couldnt create user'
          });
      } else {
        var user = {
          id : result.rows[0].id,
          name : result.rows[0].name,
          email : result.rows[0].email
        };
      };
    } else {
      var user = {
        id : result.rows[0].id,
        name : result.rows[0].name,
        email : result.rows[0].email
      };
    }
    return done(null, user);
  }
));

passport.use(new LocalStrategy({
  usernameField: 'email',
  passwordField: 'password'
}, async (username, password, done) => {
    // Check if user exists in database
    console.log('Signing in user:')
    let email = username;
    console.log({ email: email,
                  password: password});
    const result = await query(
      'SELECT * FROM user_account WHERE email = $1',
      [email]
    );
    if (!result.rows[0]) {
      return done(null, false, { message: 'Incorrect username or password.' });
    };
    let row = result.rows[0];
    let user = {
      id : result.rows[0].id,
      googleId : result.rows[0].google_id,
      name : result.rows[0].name,
      email : result.rows[0].email,
    };

    // If googleId is present then there's no password to validate and user must login using google
    if (user.googleId) {
      return done(null, false, { message: 'Email is associated with a google account' });
    };

    // Validate password
    console.log({salt: row.salt});
    crypto.pbkdf2(password, row.salt, 310000, 32, 'sha256', function(err, hashedPassword) {
      if (err) { return cb(err); }
      console.log({
        db: row.hashed_password,
        provided: hashedPassword
      })
      if (!crypto.timingSafeEqual(row.hashed_password, hashedPassword)) {
        return done(null, false, { message: 'Incorrect username or password.' });
      }
      return done(null, user);
    });
  }
));