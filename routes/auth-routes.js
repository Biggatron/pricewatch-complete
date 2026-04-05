const router = require('express').Router();
const passport = require('passport');
const crypto  = require('crypto');
const query = require('../db/db');
const { sendImmediateTemplateEmail } = require('../utilities/crawler');
const { attachGuestTracksToUserByEmail } = require('../utilities/user-track-assignment');

const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60;
const MIN_VERIFICATION_EMAIL_INTERVAL_MS = 1000 * 60 * 3;
const VERIFICATION_EMAIL_WINDOW_MS = 1000 * 60 * 60;
const MAX_VERIFICATION_EMAILS_PER_WINDOW = 3;
const GENERIC_FORGOT_PASSWORD_MESSAGE = 'If an account exists for that email, we sent instructions to it.';


// auth signup
router.get('/signup', (req, res) => {
    res.render('signup', { user: req.user });
});

// auth login
router.get('/login', (req, res) => {
    res.render('login', {
        user: req.user,
        message: getLoginMessage(req.query.message),
        messageType: req.query.message === 'verify_failed' ? 'error' : 'success'
    });
});

router.get('/forgot-password', (req, res) => {
    res.render('forgot-password', {
        user: req.user,
        message: req.query.message === 'sent' ? GENERIC_FORGOT_PASSWORD_MESSAGE : null
    });
});

router.get('/reset-password', async (req, res, next) => {
    try {
        const token = String(req.query.token || '').trim();
        const user = token ? await getUserByPasswordResetToken(token) : null;

        res.render('reset-password', {
            user: req.user,
            resetToken: token,
            isValidToken: Boolean(user),
            message: user ? null : 'The password reset link is invalid or has expired.'
        });
    } catch (error) {
        next(error);
    }
});

// auth logout
router.get('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

// Local signup
router.post('/local/signup', async (req, res, next) => {
    try {
        await newLocalUser(req, res);
    } catch (error) {
        next(error);
    }
});

// Local login
router.post('/local/login', (req, res, next) => {
    passport.authenticate('local', (err, user, info) => {
        if (err) {
            return next(err);
        }

        if (!user) {
            return res.status(401).json({
                message: (info && info.message) || 'Incorrect username or password.'
            });
        }

        req.login(user, function(loginError) {
            if (loginError) {
                return next(loginError);
            }

            return res.status(200).json({
                redirect: '/profile'
            });
        });
    })(req, res, next);
});

router.post('/forgot-password', async (req, res, next) => {
    try {
        const email = normalizeEmail(req.body && req.body.email);

        if (!email || !email.includes('@')) {
            return res.status(200).json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
        }

        const userResult = await query(
            `SELECT *
             FROM user_account
             WHERE LOWER(email) = $1
             ORDER BY id ASC
             LIMIT 1`,
            [email]
        );

        const account = userResult.rows[0];
        if (!account || account.google_id) {
            return res.status(200).json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
        }

        if (!account.is_email_verified) {
            await issueEmailVerification(account, getRequestBaseUrl(req), {
                enforceRateLimit: true
            });
        } else {
            await issuePasswordReset(account, getRequestBaseUrl(req));
        }

        return res.status(200).json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
    } catch (error) {
        if (isVerificationEmailRateLimitError(error)) {
            return res.status(200).json({ message: GENERIC_FORGOT_PASSWORD_MESSAGE });
        }

        next(error);
    }
});

router.post('/reset-password', async (req, res, next) => {
    try {
        const token = String((req.body && req.body.token) || '').trim();
        const password = String((req.body && req.body.password) || '');

        if (!token) {
            return res.status(400).json({ message: 'The password reset link is invalid or has expired.' });
        }

        if (!password || password.length < 8) {
            return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
        }

        const account = await getUserByPasswordResetToken(token);
        if (!account) {
            return res.status(400).json({ message: 'The password reset link is invalid or has expired.' });
        }

        const salt = crypto.randomBytes(16);
        const hashedPassword = await hashPassword(password, salt);

        await query(
            `UPDATE user_account
             SET hashed_password = $1,
                 salt = $2,
                 password_reset_token_hash = NULL,
                 password_reset_token_expires_at = NULL,
                 last_modified_at = $3,
                 last_modified_by = $4
             WHERE id = $5`,
            [hashedPassword, salt, new Date(), account.id, account.id]
        );

        return res.status(200).json({
            message: 'Your password has been reset. You can now log in.'
        });
    } catch (error) {
        next(error);
    }
});

router.get('/verify-email', async (req, res, next) => {
    try {
        const token = String(req.query.token || '').trim();
        if (!token) {
            return res.redirect('/auth/login?message=verify_failed');
        }

        const tokenHash = hashToken(token);
        const result = await query(
            `UPDATE user_account
             SET is_email_verified = TRUE,
                 email_verification_token_hash = NULL,
                 email_verification_token_expires_at = NULL,
                 last_modified_at = $2,
                 last_modified_by = id
             WHERE email_verification_token_hash = $1
               AND email_verification_token_expires_at > $2
             RETURNING id, name, email`,
            [tokenHash, new Date()]
        );

        const verifiedUser = result.rows[0];
        if (!verifiedUser) {
            return res.redirect('/auth/login?message=verify_failed');
        }

        req.login({
            id: verifiedUser.id,
            name: verifiedUser.name,
            email: verifiedUser.email
        }, (loginError) => {
            if (loginError) {
                next(loginError);
                return;
            }

            return res.redirect('/profile');
        });
    } catch (error) {
        next(error);
    }
});

// auth with google+
router.get('/google', passport.authenticate('google', {
    scope: ['profile', 'email']
}));

// callback route for google to redirect to
// hand control to passport to use code to grab profile info
router.get('/google/redirect', passport.authenticate('google'), (req, res) => {
    // res.send(req.user);
    res.redirect('/profile');
});

async function newLocalUser(req, res) {
    let user = req.body || {};
    user.email = normalizeEmail(user && user.email);
    user.create_date = new Date();

    if (!user.email || !user.email.includes('@')) {
        res.status(400).json({message: 'Invalid email'});
        return;
    }

    // Validate password
    if (!user.password || user.password.length < 8) {
        res.status(400).json({message: 'Password must be at least 8 characters long.'});
        return;
    }

    const existingAccount = await getLocalAccountByEmail(user.email);
    if (existingAccount) {
        if (existingAccount.google_id) {
            res.status(400).json({message: 'Email is associated with a Google account. Sign in with Google instead.'});
            return;
        }

        if (existingAccount.is_email_verified) {
            res.status(200).json({
                redirect: '/auth/login?message=already_verified'
            });
            return;
        }

        try {
            await issueEmailVerification(existingAccount, getRequestBaseUrl(req), {
                enforceRateLimit: true
            });

            res.status(200).json({
                redirect: '/auth/login?message=verification_resent'
            });
            return;
        } catch (error) {
            if (isVerificationEmailRateLimitError(error)) {
                res.status(error.status || 429).json({ message: error.message });
                return;
            }

            throw error;
        }
    }

    // Provided details valid. New user is created
    let salt = crypto.randomBytes(16);
    const hashedPassword = await hashPassword(user.password, salt);
    const result = await query(
        `INSERT INTO user_account (
            email,
            name,
            hashed_password,
            salt,
            is_email_verified,
            created_at,
            last_modified_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [user.email, user.name, hashedPassword, salt, false, user.create_date, user.create_date]
    );

    if (!result.rows[0]) {
        res.sendStatus(500);
        return;
    }

    await attachGuestTracksToUserByEmail({
        userId: result.rows[0].id,
        email: result.rows[0].email
    });

    await issueEmailVerification(result.rows[0], getRequestBaseUrl(req));

    res.status(201).json({
        redirect: '/auth/login?message=signup_verification_sent'
    });
}

async function issueEmailVerification(account, baseUrl, options = {}) {
    const now = new Date();
    const enforceRateLimit = Boolean(options.enforceRateLimit);
    const rateLimitState = getVerificationEmailRateLimitState(account, now);

    if (enforceRateLimit && rateLimitState.error) {
        throw rateLimitState.error;
    }

    const token = createRandomToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);

    await query(
        `UPDATE user_account
         SET email_verification_token_hash = $1,
             email_verification_token_expires_at = $2,
             email_verification_last_sent_at = $3,
             email_verification_sent_window_started_at = $4,
             email_verification_sent_count = $5,
             password_reset_token_hash = NULL,
             password_reset_token_expires_at = NULL,
             last_modified_at = $6,
             last_modified_by = $7
         WHERE id = $8`,
        [
            tokenHash,
            expiresAt,
            now,
            rateLimitState.windowStartedAt,
            rateLimitState.nextCount,
            now,
            account.id,
            account.id
        ]
    );

    await sendImmediateTemplateEmail({
        templateKey: 'email_verification',
        recipientEmail: account.email,
        emailType: 'email_verification',
        templateData: {
            name: account.name,
            verificationUrl: `${baseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`
        }
    });
}

async function issuePasswordReset(account, baseUrl) {
    const token = createRandomToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await query(
        `UPDATE user_account
         SET password_reset_token_hash = $1,
             password_reset_token_expires_at = $2,
             last_modified_at = $3,
             last_modified_by = $4
         WHERE id = $5`,
        [tokenHash, expiresAt, new Date(), account.id, account.id]
    );

    await sendImmediateTemplateEmail({
        templateKey: 'password_reset',
        recipientEmail: account.email,
        emailType: 'password_reset',
        templateData: {
            name: account.name,
            resetUrl: `${baseUrl}/auth/reset-password?token=${encodeURIComponent(token)}`
        }
    });
}

async function getUserByPasswordResetToken(token) {
    const tokenHash = hashToken(token);
    const result = await query(
        `SELECT *
         FROM user_account
         WHERE password_reset_token_hash = $1
           AND password_reset_token_expires_at > $2
         ORDER BY id ASC
         LIMIT 1`,
        [tokenHash, new Date()]
    );

    return result.rows[0] || null;
}

async function getLocalAccountByEmail(email) {
    const userResult = await query(
        `SELECT *
         FROM user_account
         WHERE LOWER(email) = $1
         ORDER BY id ASC
         LIMIT 1`,
        [normalizeEmail(email)]
    );

    return userResult.rows[0] || null;
}

function getVerificationEmailRateLimitState(account, now) {
    const lastSentAt = parseOptionalDate(account.email_verification_last_sent_at);
    const storedWindowStartedAt = parseOptionalDate(account.email_verification_sent_window_started_at);
    const windowStartedAt = (
        storedWindowStartedAt &&
        now.getTime() - storedWindowStartedAt.getTime() < VERIFICATION_EMAIL_WINDOW_MS
    )
        ? storedWindowStartedAt
        : now;
    const currentCount = windowStartedAt === storedWindowStartedAt
        ? Number(account.email_verification_sent_count) || 0
        : 0;

    if (lastSentAt) {
        const sinceLastSentMs = now.getTime() - lastSentAt.getTime();
        if (sinceLastSentMs < MIN_VERIFICATION_EMAIL_INTERVAL_MS) {
            return {
                windowStartedAt,
                nextCount: currentCount + 1,
                error: createVerificationEmailRateLimitError(
                    `We already sent a verification email recently. Please wait ${formatWaitTime(MIN_VERIFICATION_EMAIL_INTERVAL_MS - sinceLastSentMs)} before trying again.`
                )
            };
        }
    }

    if (currentCount >= MAX_VERIFICATION_EMAILS_PER_WINDOW) {
        const msUntilWindowReset = VERIFICATION_EMAIL_WINDOW_MS - (now.getTime() - windowStartedAt.getTime());
        return {
            windowStartedAt,
            nextCount: currentCount + 1,
            error: createVerificationEmailRateLimitError(
                `Too many verification emails were sent recently. Please wait ${formatWaitTime(msUntilWindowReset)} before trying again.`
            )
        };
    }

    return {
        error: null,
        windowStartedAt,
        nextCount: currentCount + 1
    };
}

function createVerificationEmailRateLimitError(message) {
    const error = new Error(message);
    error.code = 'EMAIL_VERIFICATION_RATE_LIMIT';
    error.status = 429;
    return error;
}

function isVerificationEmailRateLimitError(error) {
    return Boolean(error && error.code === 'EMAIL_VERIFICATION_RATE_LIMIT');
}

function normalizeEmail(email) {
    return String(email || '').trim().toLowerCase();
}

function createRandomToken() {
    return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.pbkdf2(password, salt, 310000, 32, 'sha256', (error, hashedPassword) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(hashedPassword);
        });
    });
}

function getRequestBaseUrl(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProto || req.protocol || 'http';
    return `${protocol}://${req.get('host')}`;
}

function parseOptionalDate(value) {
    if (!value) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatWaitTime(milliseconds) {
    const roundedMinutes = Math.max(1, Math.ceil(milliseconds / (1000 * 60)));

    if (roundedMinutes < 60) {
        return `${roundedMinutes} minute${roundedMinutes === 1 ? '' : 's'}`;
    }

    const roundedHours = Math.ceil(roundedMinutes / 60);
    return `${roundedHours} hour${roundedHours === 1 ? '' : 's'}`;
}

function getLoginMessage(messageCode) {
    const messages = {
        signup_verification_sent: 'Account created. Check your email to verify your account before logging in.',
        verification_resent: 'We sent a new verification email. Check your inbox to finish signing in.',
        already_verified: 'Account already exists. Please login using your email.',
        password_reset: 'Your password has been reset. You can log in now.',
        verified: 'Your email has been confirmed. You can log in now.',
        verify_failed: 'That verification link is invalid or has expired. Sign up again with the same email to get a new one.'
    };

    return messages[messageCode] || null;
}

module.exports = router;
