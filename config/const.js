module.exports = {
    crawler: {
      intervalTime: 1000*3600*24, // milliseconds // Every 24 hours
      htmlMinMatchSize: 50
    },
    email: {
      sendEmail: true
    },
    html: {
      saveNewTrackHTML: true,
      saveUpdateTrackHTML: true,
      onlyFailed: false
    }
  }
