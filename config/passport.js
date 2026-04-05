const passport = require('passport');
const query = require('../db/db');
const GoogleStrategy = require('passport-google-oauth2').Strategy;
const LocalStrategy = require('passport-local').Strategy;
const crypto  = require('crypto');
const { attachGuestTracksToUserByEmail } = require('../utilities/user-track-assignment');

const keys = require('./keys');
  
passport.serializeUser((user , done) => {
    done(null , user.id);
}),

passport.deserializeUser(async (id, done) => {
  // Look up user id in database
  const result = await query(
    'SELECT * FROM user_account WHERE id = $1',
    [id]
  );
  if (result.rows.length !== 0){
    var user = {
      id : result.rows[0].id,
      name : result.rows[0].name,
      email : result.rows[0].email
    };
    done(null, user);
  } else {
    console.warn('[auth] Failed to deserialize user', { id });
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
    const googleResult = await query(
      'SELECT * FROM user_account WHERE google_id = $1',
      [profile.id]
    );
    let result = googleResult;

    if (googleResult.rows.length === 0 && profile.email) {
      const existingEmailResult = await query(
        'SELECT * FROM user_account WHERE LOWER(email) = $1 ORDER BY id ASC LIMIT 1',
        [String(profile.email || '').trim().toLowerCase()]
      );

      if (existingEmailResult.rows.length !== 0) {
        result = await query(
          `UPDATE user_account
           SET google_id = $1,
               is_email_verified = TRUE,
               name = COALESCE(NULLIF(name, ''), $2),
               last_modified_at = $3,
               last_modified_by = id
           WHERE id = $4
           RETURNING *`,
          [profile.id, profile.displayName, new Date(), existingEmailResult.rows[0].id]
        );
      }
    }

    if (result.rows.length === 0){
      console.info('[auth] Creating new Google user', {
        email: profile.email,
        name: profile.displayName
      });
      // User does not exist a new one is created
      const result = await query(
        `INSERT INTO user_account (google_id, name, email, is_email_verified, created_at, last_modified_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [profile.id, profile.displayName, profile.email, true, new Date(), new Date()]
      );
      if (result.rows.length === 0) {
          return done(new Error('Could not create user'));
      } else {
        await attachGuestTracksToUserByEmail({
          userId: result.rows[0].id,
          email: result.rows[0].email
        });
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
    let email = username;
    console.info('[auth] Local sign-in attempt', { email });
    const result = await query(
      'SELECT * FROM user_account WHERE LOWER(email) = $1 ORDER BY id ASC LIMIT 1',
      [String(email || '').trim().toLowerCase()]
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

    if (!row.is_email_verified) {
      return done(null, false, { message: 'Please verify your email address before logging in. If you need a new verification email, sign up again with the same email.' });
    }

    // Validate password
    crypto.pbkdf2(password, row.salt, 310000, 32, 'sha256', function(err, hashedPassword) {
      if (err) { return done(err); }
      if (!crypto.timingSafeEqual(row.hashed_password, hashedPassword)) {
        return done(null, false, { message: 'Incorrect username or password.' });
      }
      return done(null, user);
    });
  }
));
