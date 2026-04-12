const defaultEmailTransportMode = process.env.NODE_ENV === 'production' ? 'ses' : 'smtp';

module.exports = {
  crawler: {
    intervalTime: 1000 * 3600 * 24, // milliseconds // Every 24 hours
    htmlMinMatchSize: 50,
    domainAccessProfileMaxAgeMs: 1000 * 60 * 60 * 24 * 7
  },
  preview: {
    screenshotCacheDurationMs: 1000 * 60 * 60 * 2,
    postNavigationDelayMs: 150,
    postBannerDelayMs: 250
  },
  email: {
    sendEmail: true,
    transportMode: defaultEmailTransportMode,
    sesAddress: 'pricewatcher@birgirs.com',
    retryDelayMs: 1000 * 60 * 15
  },
  html: {
    saveNewTrackHTML: true,
    saveUpdateTrackHTML: true,
    onlyFailed: false
  }
};
