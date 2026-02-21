/**
 * CLI entrypoint: run sync once (e.g. for Cloud Run Job or local test).
 */

import { runFullSync } from './runSync.js';

runFullSync()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
