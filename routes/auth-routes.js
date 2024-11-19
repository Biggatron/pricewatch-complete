const router = require('express').Router();
const passport = require('passport');
const crypto  = require('crypto');
const query = require('../db/db');


// auth signup
router.get('/signup', (req, res) => {
    res.render('signup', { user: req.user });
});

// auth login
router.get('/login', (req, res) => {
    res.render('login', { user: req.user });
});

// auth logout
router.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

// Local signup
router.post('/local/signup', (req, res) => {
    console.log("local/signup route hit")
    newLocalUser(req, res);
});

// Local login
router.post('/local/login', passport.authenticate('local', { successRedirect: '/profile', failWithError: true }), (err, req, res, next) => {
    if (err) {
        err.message = 'Incorrect username or password'
        err.status = 401;
        next(err);
    } else {
        console.log('redirecting to profile')
        res.redirect('/profile');
    }
});

// auth with google+
router.get('/google', passport.authenticate('google', {
    scope: ['profile']
}));

// callback route for google to redirect to
// hand control to passport to use code to grab profile info
router.get('/google/redirect', passport.authenticate('google'), (req, res) => {
    // res.send(req.user);
    res.redirect('/profile');
});

async function newLocalUser(req, res) {
    let user = req.body;
    user.create_date = new Date();
    console.log({user: user})
    // Validate email, if invalid returns message
    let validationError = await validateEmail(user.email);
    if (validationError) {
        console.log({validationEmail: validationError})
        res.status(400).json({error: validationError});
        return;
    }
    // Validate password
    if (!user.password || user.password.length < 8) {
        console.log("invalid password");
        res.status(400).json({error: 'Invalid password'});
        return;
    }

    // Provided details valid. New user is created
    let salt = crypto.randomBytes(16);
    crypto.pbkdf2(user.password, salt, 310000, 32, 'sha256', async function(err, hashedPassword) {
        if (err) { return next(err); }
        console.log('Inserting new user')
        console.log({hashedPassword: hashedPassword})
        const result = await query(
            `INSERT INTO user_account (email, name, hashed_password, salt, created_at, last_modified_at) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [user.email, user.name, hashedPassword, salt, user.create_date, user.create_date]
        );

        if (result.rows[0]) {
            console.log({userCreated: result.rows})
            //res.status(200).json(result.rows[0]);
            let user = {
                id: result.rows[0].id,
                email: result.rows[0].email,
                name: result.rows[0].name
            }
            console.log('Logging in user')
            req.login(user, function(err) {
                if (err) { return next(err); }
                res.status(200).json(user);
            });
        } else {
            res.sendStatus(500);
        }
    });
}

async function validateEmail(email) {
    if (!email.includes('@')) {
        return 'Invalid email';
    } else {
        const userResult = await query(
            `SELECT * FROM user_account WHERE email = '${email}'`
        );
        if (userResult.rows[0]) {
            return 'User with provided email already exists';
        }
    }
    return;
}

module.exports = router;