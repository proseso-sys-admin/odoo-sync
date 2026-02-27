/**
 * Target Odoo: upsert document for attachment, delete doc+attachment (GC).
 * Ported from Apps Script upsertMoveDocumentForAttachment_, deleteTargetDocAndAttachment_.
 */

import { odooExecuteKw, requireId } from './odoo.js';

function kwWithCompany(companyId, extraKw = {}) {
  return Object.assign({ context: { allowed_company_ids: [companyId], force_company: companyId } }, extraKw);
}

async function assertFolderDoc(targetCfg, companyId, docId, ctx = {}) {
  const id = requireId(docId, { where: 'assertFolderDoc', ...ctx });
  // Odoo 19: no is_folder field; type === 'folder' is enough
  const rows = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'read',
    [[id], ['id', 'name', 'type', 'folder_id', 'company_id', 'owner_id']],
    kwWithCompany(companyId)
  );
  const d = (rows && rows[0]) || null;
  if (!d) throw new Error('Folder doc not found: ' + JSON.stringify({ id, ctx }));
  const isFolder = String(d.type || '').toLowerCase() === 'folder';
  if (!isFolder) throw new Error('Resolved folder is not a folder: ' + JSON.stringify({ got: d, ctx }));
  return id;
}

export async function upsertMoveDocumentForAttachment(targetCfg, companyId, attachmentId, destFolderId, docName) {
  const attId = requireId(attachmentId, { where: 'upsertMoveDocumentForAttachment' });
  const folderId = await assertFolderDoc(targetCfg, companyId, destFolderId, { attId });
  const docIds = await odooExecuteKw(
    targetCfg,
    'documents.document',
    'search',
    [[['attachment_id', '=', attId]]],
    kwWithCompany(companyId, { limit: 5 })
  );
  if (docIds && docIds.length) {
    const docId = requireId(docIds[0], { where: 'doc existing', attId });
    await odooExecuteKw(
      targetCfg,
      'documents.document',
      'write',
      [[docId], { folder_id: folderId, name: String(docName || 'Document'), company_id: companyId, owner_id: false }],
      kwWithCompany(companyId)
    );
    return { action: 'moved', doc_id: docId };
  }
  try {
    const createdDocId = await odooExecuteKw(
      targetCfg,
      'documents.document',
      'create',
      [[{ name: String(docName || 'Document'), folder_id: folderId, attachment_id: attId, company_id: companyId, owner_id: false }]],
      kwWithCompany(companyId)
    );
    const docId = requireId(createdDocId, { where: 'doc create', attId });
    return { action: 'created', doc_id: docId };
  } catch (createErr) {
    const msg = String(createErr && createErr.message ? createErr.message : createErr);
    const isAlreadyDocument =
      /already a document/i.test(msg) ||
      /documents_document_attachment_unique|UniqueViolation/i.test(msg);
    if (!isAlreadyDocument) throw createErr;
    // Attachment already has a document (e.g. search missed it due to company or race). Find and move.
    let retryDocIds =
      (await odooExecuteKw(
        targetCfg,
        'documents.document',
        'search',
        [[['attachment_id', '=', attId]]],
        { limit: 5 }
      )) || [];
    if (!retryDocIds.length) {
      retryDocIds =
        (await odooExecuteKw(
          targetCfg,
          'documents.document',
          'search',
          [[['attachment_id', '=', attId]]],
          kwWithCompany(companyId, { limit: 5 })
        )) || [];
    }
    if (retryDocIds.length) {
      const docId = requireId(retryDocIds[0], { where: 'doc existing after create conflict', attId });
      await odooExecuteKw(
        targetCfg,
        'documents.document',
        'write',
        [[docId], { folder_id: folderId, name: String(docName || 'Document'), company_id: companyId, owner_id: false }],
        kwWithCompany(companyId)
      );
      return { action: 'moved', doc_id: docId };
    }
    throw createErr;
  }
}

export async function deleteTargetDocAndAttachment(targetCfg, companyId, targetAttachmentId) {
  const attId = Number(targetAttachmentId);
  if (!attId) return;
  const exists = await odooExecuteKw(targetCfg, 'ir.attachment', 'search', [[['id', '=', attId]]], { limit: 1 });
  if (!exists || !exists.length) return;
  let docIds = [];
  try {
    docIds = await odooExecuteKw(
      targetCfg,
      'documents.document',
      'search',
      [[['attachment_id', '=', attId]]],
      kwWithCompany(companyId, { limit: 50 })
    ) || [];
  } catch (_) {
    docIds = [];
  }
  if (docIds.length) {
    try {
      await odooExecuteKw(targetCfg, 'documents.document', 'unlink', [docIds], kwWithCompany(companyId));
    } catch (_) {}
  }
  try {
    await odooExecuteKw(targetCfg, 'ir.attachment', 'unlink', [[attId]], {});
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes('MissingError') || msg.includes('does not exist') || msg.includes('has been deleted')) return;
    throw e;
  }
}
