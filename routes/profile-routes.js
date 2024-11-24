const router = require('express').Router();
const query = require('../db/db');

const authCheck = (req, res, next) => {
    if(!req.user){
        res.redirect('/auth/login');
    } else {
        next();
    }
};

router.get('/', authCheck, (req, res) => {
    renderProfile(req, res);
});

router.post('/update-user-email', authCheck, (req, res) => {
    updateUserEmail(req, res);
});

async function renderProfile(req, res) {
    console.log('Rendering profile page for user:');
    console.log({user: req.user});
    res.render('profile', { user: req.user });
}

async function updateUserEmail(req, res) {
    try {
        // Extract user info and new email from the request
        const userId = req.user.id; // Assuming `req.user` contains the authenticated user's information
        const { newEmail } = req.body;

        if (!newEmail) {
            return res.status(400).json({ message: 'New email is required.' });
        }

        // Start a database transaction
        await query('BEGIN');

        // Update the email in the user_account table
        const userUpdateResult = await query(
            `UPDATE user_account 
             SET email = $1, last_modified_at = NOW(), last_modified_by = $2
             WHERE id = $3 AND deleted = FALSE 
             RETURNING *`,
            [newEmail, userId, userId]
        );

        if (userUpdateResult.rowCount === 0) {
            await query('ROLLBACK');
            return res.status(404).json({ message: 'User not found or is deleted.' });
        }

        // Update the email in the track table
        const trackUpdateResult = await query(
            `UPDATE track 
             SET email = $1, last_modified_at = NOW()
             WHERE user_id = $2`,
            [newEmail, userId]
        );

        // Commit the transaction
        await query('COMMIT');

        return res.status(200).json({
            message: 'Email updated successfully.',
            updatedUser: userUpdateResult.rows[0],
            updatedTracks: trackUpdateResult.rowCount
        });
    } catch (error) {
        // Rollback the transaction in case of an error
        await query('ROLLBACK');
        console.error('Error updating user email:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
}

module.exports = router;