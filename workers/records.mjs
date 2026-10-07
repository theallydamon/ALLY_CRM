import core from '../functions/crm-records.js';
import lib from '../functions/lib.js';
import { timestamp } from './firebase.mjs';
export const { TOOL_DEFINITIONS } = core;
const { records, searchRecords, snapshot, saveRecord, text } = core;
const { sha256 } = lib;
export async function callRecord(workspace, name, args, actor) {
  if (name !== 'saveCrmRecord') {
    const { data } = await workspace.read();
    if (name === 'searchCrmRecords') return searchRecords(data, args);
    if (name !== 'getCrmRecord') throw new Error('Unknown CRM tool.');
    const record = records(data, args.board).find(item => item.id === text(args.id, 'id'));
    if (!record) throw new Error('CRM record not found.');
    return snapshot(args.board, record);
  }
  const requestId = text(args.requestId, 'requestId');
  if (!requestId) throw new Error('requestId is required.');
  const key = sha256(actor.email + ':' + requestId), inputHash = sha256(JSON.stringify(args));
  for (let attempt = 0; attempt < 3; attempt++) {
    const [{ data, updateTime }, history] = await Promise.all([workspace.read(), workspace.history()]);
    const ledger = history.operations, prior = ledger[key];
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error('requestId was already used for different arguments.');
      const record = records(data, prior.board).find(item => item.id === prior.recordId);
      if (!record) throw new Error('This operation already succeeded, but its record has since been removed.');
      return { created: prior.created, duplicate: prior.duplicate, replayed: true, ...snapshot(prior.board, record) };
    }
    // No silent eviction: removing replay protection needs an explicit maintenance plan.
    if (Object.keys(ledger).length >= 1000) throw new Error('Operation history needs maintenance. No record was changed.');
    const saved = saveRecord(data, args);
    const next = { ...saved.workspace, workspaceId: 'ally-crm', updatedAt: timestamp(new Date().toISOString()), updatedBy: 'ally-assistant:' + actor.email };
    const operations = { ...ledger, [key]: { inputHash, board: args.board, recordId: saved.result.record.id, created: saved.result.created, duplicate: saved.result.duplicate } };
    // Both documents commit atomically with update-time preconditions. The app's whole-workspace
    // saves cannot erase this separate user-document operation history.
    if (await workspace.write(next, updateTime, { ...history, operations })) return saved.result;
  }
  throw new Error('CRM changed repeatedly. Read the record again before retrying.');
}
