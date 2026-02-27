/**
 * Debug script: load routes and run sync, then print why nothing might be happening.
 * Run from worker folder: node src/debug-sync.js
 * Requires .env with SOURCE_BASE_URL, SOURCE_DB, SOURCE_LOGIN, SOURCE_PASSWORD.
 */

import { getSourceConfig } from './config.js';
import { loadRoutesFromOdoo } from './routes.js';
import { runFullSync } from './runSync.js';
import { routeKey, odooAuthenticate } from './odoo.js';

async function main() {
  process.env.ODOO_SYNC_DEBUG = '1';
  console.log('--- Loading routes from source ---\n');
  const sourceCfg = getSourceConfig();
  const routing = await loadRoutesFromOdoo(sourceCfg);

  const routeList = [...routing.entries()].map(([spid, r]) => ({
    source_project_id: Number(spid),
    target: `${r.target_base_url} (db: ${r.target_db}, company: ${r.target_company_id})`,
    key: routeKey(r),
  }));

  console.log('\n--- Loaded routes ---');
  if (!routeList.length) {
    console.log('No routes. So nothing will be synced.');
    console.log('Fix: In source DB, ensure each project has a General task with x_studio_enabled=true,');
    console.log('     x_studio_accounting_database=<target URL>, x_studio_email, x_studio_api_key.');
    process.exit(0);
  }
  routeList.forEach((r) => console.log(`  Project ${r.source_project_id} → ${r.target}`));
  const hdfKey = routeList.find((r) => r.target.includes('hdf-energy'))?.key;
  if (hdfKey) console.log('\n  (hdf-energy target key:', hdfKey + ')');
  else console.log('\n  (No route for hdf-energy-holdings-incorporated in the list above)');

  console.log('\n--- Checking target credentials ---\n');
  const badTargets = [];
  for (const [spid, route] of routing.entries()) {
    const targetCfg = {
      baseUrl: route.target_base_url,
      db: route.target_db,
      login: route.target_login,
      password: route.target_password,
    };
    try {
      await odooAuthenticate(targetCfg);
      console.log(`  OK   Project ${spid} → ${route.target_base_url} (${route.target_db})`);
    } catch (e) {
      const msg = e && e.message;
      badTargets.push({
        projectId: spid,
        url: route.target_base_url,
        db: route.target_db,
        login: route.target_login,
        message: msg,
      });
      console.log(`  FAIL Project ${spid} → ${route.target_base_url} (${route.target_db}) login=${route.target_login}`);
      console.log(`       ${msg}`);
    }
  }
  if (badTargets.length) {
    console.log('\n--- Bad credentials (these targets will be skipped during sync) ---');
    badTargets.forEach((t) =>
      console.log(`  Project ${t.projectId}: ${t.url} | db=${t.db} | login=${t.login}`)
    );
  }

  console.log('\n--- Running full sync ---\n');
  const result = await runFullSync();
  console.log('\n--- Result summary ---');
  console.log('routes:', result.routes);
  console.log('tax metrics:', JSON.stringify(result.tax?.metrics ?? result.tax, null, 2));
  if (result.tax?.failures?.length) {
    console.log('tax failures:', result.tax.failures.length);
    result.tax.failures.slice(0, 5).forEach((f) => console.log('  ', f));
  }
  if (result.target_filter) console.log('target_filter:', result.target_filter);
  console.log('\nFull result:', JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
