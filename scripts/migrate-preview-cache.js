const { initializeLogger } = require('../utilities/logger');
const { migrateLegacyPreviewMetadataFiles } = require('../utilities/preview-cache');

initializeLogger({ announce: false });

main().catch((error) => {
  console.error('[migrate-preview-cache] Migration failed', error);
  process.exitCode = 1;
});

async function main() {
  await migrateLegacyPreviewMetadataFiles();
  console.info('[migrate-preview-cache] Legacy preview metadata migration completed');
}
