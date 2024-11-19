const router = require('express').Router();

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

async function renderProfile(req, res) {
    console.log('Rendering profile page for user:');
    console.log({user: req.user});
    res.render('profile', { user: req.user });
}

module.exports = router;