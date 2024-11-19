
function errorHandler(err, req, res ,next) {
  console.log('Custom error handler handling error')
  let object = {
    status: err.status || 500,
    message: err.message || 'Something failed'
  }
  res.status(object.status).send(JSON.stringify(object));
}

module.exports = errorHandler;