const defaultEmailTransportMode = process.env.NODE_ENV === 'production' ? 'ses' : 'smtp';

module.exports = {
  crawler: {
    intervalTime: 1000 * 3600 * 24, // milliseconds // Every 24 hours
    htmlMinMatchSize: 50
  },
  email: {
    sendEmail: true,
    transportMode: defaultEmailTransportMode,
    sesAddress: 'pricewatcher@birgirs.com'
  },
  html: {
    saveNewTrackHTML: true,
    saveUpdateTrackHTML: true,
    onlyFailed: false
  }
};
