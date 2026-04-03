function errorHandler(err, req, res ,next) {
  const object = {
    status: err.status || 500,
    message: err.message || 'Something failed'
  };

  console.error('[http] Request failed', {
    method: req.method,
    path: req.originalUrl || req.url,
    status: object.status,
    message: object.message,
    error: err
  });

  res.status(object.status).send(JSON.stringify(object));
}

module.exports = errorHandler;
