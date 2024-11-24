const router = require('express').Router();
const crawler = require('../utilities/crawler');
const query = require('../db/db');

const authCheck = (req, res, next) => {
    if(!req.user){
        res.redirect('/auth/login');
    } else {
        next();
    }
};

// New track landing page
router.get('/', (req, res) => {
  res.render('new-track', { user: req.user });
});

// New track landing page
router.get('/tracklist', authCheck, (req, res) => {
  getTracks(req.user, res);
});

router.post('/', (req, res) => {
    //console.log(req.body);
    console.log("New track posted in background...")
    let trackRequest = {
      price_url: req.body.url,
      orig_price: crawler.extractNumber(req.body.price),
      email: req.body.email,
      user_id: req.user.id
    }
    //trackRequest = checkIfTrackExists(trackRequest, res);
    crawler.findAndSavePrices(trackRequest, false, res);
  });
  
  router.post('/update-prices', (req, res) => {
    console.log("Updating prices in background...")
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).send('Track update job started');
    crawler.updatePrices();
  });
  
  router.delete('/*', (req, res) => {
    console.log('delete track route hit')
    deleteTrack(res, req);
  });

  async function checkIfTrackExists( trackRequest, res) {
    console.log(`Getting track with url ${trackRequest.price_url } and for user: ${trackRequest.user_id}`)
    const result = await query(
      `SELECT * FROM track WHERE user_id = ${user.id} and price_url = ${trackRequest.price_url} ORDER BY created_at DESC`
    );
    let track = result.rows[0];
    if (track) {
      if (track.active) {
        res.status(404).json({error: `You are already tracking this price`})
        return;
      } else {
        trackRequest.action = 'update';
      }
    } 
    return trackRequest;
  }

  async function getTracks(user, res) {
    console.log('Getting tracks for user:' + user.id)
    const result = await query(
      `SELECT * FROM track WHERE user_id = ${user.id} ORDER BY created_at DESC`
    );
    console.log(result.rows);
    res.render('my-tracks', { user: user, tracks: result.rows });
  }

  async function deleteTrack(res, req) {
    let trackId = req.params[0];
    let user = req.user;
    
    const getTrackResult = await query(
        `SELECT * FROM track WHERE id = '${trackId}'`
    );
    let track = getTrackResult.rows[0];
    if (!track) {
        res.status(404).json({error: `Track ${trackId} does not exist`})
        return;
    }
    if (!user) {
        res.status(404).json({error: `User has to be logged on to delete track`})
        return;
    }
    if (track.user_id === user.id) {
        // Delete track
        const deleteTrackResult = await query(
            `DELETE FROM track WHERE id = '${trackId}'`
        );
        console.log({
            deleteTrackResult: deleteTrackResult
        })
        const getDeleteTrackResult = await query(
            `SELECT * FROM track WHERE id = '${trackId}'`
        );
        let track = getDeleteTrackResult.rows[0];
        if (track) {
            res.sendStatus(404).json({error: `Failed to delete track ${trackId}`})
            return;
        } else {
            res.sendStatus(200);
            return;
        }
    } else {
        res.status(404).json({error: 'user.id does not match track.user_id'})
        console.log(`user ${user.id} tried to delete track owned by ${track.user_id}`)
    }
}

module.exports = router;