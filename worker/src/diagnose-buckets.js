/**
 * Diagnostic: connect to source Odoo, find a Tax PH task, dump all x_studio_* fields
 * and attachment res_field values to show exactly why bucket resolution fails.
 *
 * Usage: node src/diagnose-buckets.js
 */
import 'dotenv/config';
import { odooExecuteKw } from './odoo.js';
import { TAX_BUCKET_FIELDS, FIELD_TO_TAX_BUCKET, GVT_CONTRIB_BUCKET_FIELDS, FIELD_TO_GVT_CONTRIB_BUCKET } from './folders.js';

const sourceCfg = {
  baseUrl: process.env.SOURCE_BASE_URL,
  db: process.env.SOURCE_DB,
  login: process.env.SOURCE_LOGIN,
  password: process.env.SOURCE_PASSWORD,
};

async function run() {
  console.log('=== STEP 1: Find a Tax PH task in APPROVED / DONE stage ===\n');

  const taskIds = await odooExecuteKw(sourceCfg, 'project.task', 'search', [
    [['name', 'ilike', 'Tax PH'], ['stage_id.name', 'ilike', 'approved']],
  ], { limit: 5, order: 'id desc' }) || [];
  console.log('Found task IDs:', taskIds);
  if (!taskIds.length) { console.log('No tasks found. Done.'); return; }

  const tasks = await odooExecuteKw(sourceCfg, 'project.task', 'read', [taskIds, ['id', 'name', 'project_id', 'stage_id']], {}) || [];
  for (const t of tasks) {
    console.log(`  Task ${t.id}: "${t.name}" | project=${JSON.stringify(t.project_id)} | stage=${JSON.stringify(t.stage_id)}`);
  }

  const taskId = tasks[0].id;
  console.log(`\nUsing task ${taskId}: "${tasks[0].name}"\n`);

  console.log('=== STEP 2: Get ALL fields on project.task model that start with x_studio_ ===\n');

  const allFields = await odooExecuteKw(sourceCfg, 'ir.model.fields', 'search_read', [
    [['model', '=', 'project.task'], ['name', 'like', 'x_studio_']],
    ['name', 'field_description', 'ttype', 'relation'],
  ], { limit: 100 }) || [];
  console.log(`Found ${allFields.length} x_studio_* fields on project.task:\n`);
  for (const f of allFields) {
    console.log(`  ${f.name} | label="${f.field_description}" | type=${f.ttype} | relation=${f.relation || '-'}`);
  }

  const m2mBinaryFields = allFields.filter(f => f.ttype === 'many2many' && f.relation === 'ir.attachment');
  console.log(`\nMany2many attachment fields (potential buckets): ${m2mBinaryFields.length}`);
  for (const f of m2mBinaryFields) {
    console.log(`  ${f.name} -> "${f.field_description}"`);
  }

  console.log('\n=== STEP 3: Compare with hardcoded bucket field names ===\n');

  const allBucketFields = [...TAX_BUCKET_FIELDS, ...GVT_CONTRIB_BUCKET_FIELDS];
  const fieldToBucket = { ...FIELD_TO_TAX_BUCKET, ...FIELD_TO_GVT_CONTRIB_BUCKET };
  const actualFieldNames = new Set(allFields.map(f => f.name));

  for (const coded of allBucketFields) {
    const exists = actualFieldNames.has(coded);
    const bucket = fieldToBucket[coded];
    console.log(`  ${exists ? 'OK' : 'MISSING!'} ${coded} -> "${bucket}" ${exists ? '' : '<-- THIS FIELD DOES NOT EXIST IN ODOO'}`);
  }

  const unmapped = m2mBinaryFields.filter(f => !allBucketFields.includes(f.name));
  if (unmapped.length) {
    console.log('\n  UNMAPPED attachment fields in Odoo (not in our config):');
    for (const f of unmapped) {
      console.log(`    ${f.name} -> "${f.field_description}" <-- NEEDS MAPPING?`);
    }
  }

  console.log('\n=== STEP 4: Read task bucket field values ===\n');

  const fieldNamesToRead = [...new Set([...allBucketFields, ...m2mBinaryFields.map(f => f.name)])];
  const taskData = await odooExecuteKw(sourceCfg, 'project.task', 'read', [[taskId], ['id', ...fieldNamesToRead]], {}) || [];
  if (!taskData.length) { console.log('Could not read task. Done.'); return; }

  const t = taskData[0];
  for (const fieldName of fieldNamesToRead) {
    const raw = t[fieldName];
    const inConfig = allBucketFields.includes(fieldName);
    const bucket = fieldToBucket[fieldName] || '(not mapped)';
    const val = raw === false ? 'false' : raw == null ? 'null' : Array.isArray(raw) ? `[${raw.length}] ${JSON.stringify(raw.slice(0, 5))}` : JSON.stringify(raw);
    console.log(`  ${fieldName} ${inConfig ? '-> ' + bucket : '(unmapped)'} = ${val}`);
  }

  console.log('\n=== STEP 5: Read attachments on this task and show res_field ===\n');

  const attIds = await odooExecuteKw(sourceCfg, 'ir.attachment', 'search', [
    [['res_model', '=', 'project.task'], ['res_id', '=', taskId], ['type', '=', 'binary']],
  ], { limit: 50 }) || [];
  console.log(`Found ${attIds.length} attachments on task ${taskId}`);

  if (attIds.length) {
    const atts = await odooExecuteKw(sourceCfg, 'ir.attachment', 'read', [attIds, ['id', 'name', 'res_field', 'mimetype']], {}) || [];
    for (const a of atts) {
      const resField = a.res_field || '(empty/false)';
      const mappedBucket = fieldToBucket[a.res_field] || '(no mapping)';
      console.log(`  att ${a.id}: "${a.name}" | res_field=${resField} | bucket_from_res_field=${mappedBucket}`);
    }
  }

  console.log('\n=== DONE ===');
}

run().catch(e => { console.error('Diagnostic failed:', e); process.exit(1); });
