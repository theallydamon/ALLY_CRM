"use strict";
const { sha256 } = require("./lib");
const { records, saveRecord, searchRecords, snapshot, text } = require("./crm-records");
function makeService(db, workspaceRef, integrationRef, serverTimestamp) {
  async function readWorkspace() {
    const snap = await workspaceRef.get();
    if (!snap.exists) throw new Error("ALLY CRM workspace does not exist.");
    return snap.data();
  }
  return async function call(name, args, actorEmail) {
    if (name === "searchCrmRecords") return searchRecords(await readWorkspace(), args);
    if (name === "getCrmRecord") {
      const item = records(await readWorkspace(), args.board).find((record) => record.id === text(args.id, "id"));
      if (!item) throw new Error("CRM record not found.");
      return snapshot(args.board, item);
    }
    if (name !== "saveCrmRecord") throw new Error("Unknown CRM tool.");
    const requestId = text(args.requestId, "requestId");
    if (!requestId) throw new Error("requestId is required.");
    const operation = integrationRef.collection("operations").doc(sha256(actorEmail + ":" + requestId));
    const inputHash = sha256(JSON.stringify(args));
    return db.runTransaction(async (tx) => {
      const [workspace, prior] = await Promise.all([tx.get(workspaceRef), tx.get(operation)]);
      if (prior.exists) {
        if (prior.data().inputHash !== inputHash) throw new Error("requestId was already used for different arguments.");
        return { ...prior.data().result, replayed: true };
      }
      if (!workspace.exists) throw new Error("ALLY CRM workspace does not exist.");
      const current = workspace.data();
      if (!current.ally || !current.mama) throw new Error("ALLY CRM workspace has an unexpected shape.");
      const saved = saveRecord(current, args);
      if (!saved.result.duplicate) tx.set(workspaceRef, { ...saved.workspace, workspaceId: "ally-crm", updatedAt: serverTimestamp(), updatedBy: "ally-assistant:" + actorEmail });
      tx.set(operation, { inputHash, result: saved.result, createdAt: serverTimestamp() });
      return saved.result;
    });
  };
}
module.exports = { makeService };
