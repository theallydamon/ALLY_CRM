/* Attachments live in the signed-in user's Drive, never inside the Firestore workspace blob.
   First approval stores an encrypted refresh credential on the backend. Access tokens stay in memory.
   Calendar/Sheets tokens are untouched. */
(function () {
  "use strict";
  const scope = "https://www.googleapis.com/auth/drive.file";
  const api = "https://www.googleapis.com/drive/v3/files";
  let session = null;
  const listeners = new Set();
  const notify = () => listeners.forEach((fn) => fn());
  function token(email) {
    return session && session.email === email && session.expiresAt > Date.now() + 60000 ? session.value : null;
  }
  const backend = "https://ally-crm-connector.theallydamon.workers.dev/drive";
  let generation = 0;
  let connection = null;
  let restoring = null;
  let restoreFailure = null;
  function reset() { generation++; session = null; connection = null; restoring = null; restoreFailure = null; notify(); }
  function connected(email) { return connection === email; }
  async function server(path, email, body = {}) {
    const user = window.firebase?.auth().currentUser;
    if (!user || user.email.toLowerCase() !== email.toLowerCase()) throw new Error("Sign in to the CRM before attaching files.");
    const response = await fetch(backend + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "AllyCRM", Authorization: `Bearer ${await user.getIdToken()}` },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Drive connection failed. Try again.");
    return result;
  }
  function accept(result, email, version) {
    if (version !== generation) return;
    restoreFailure = null;
    connection = result.connected ? email : null;
    session = result.connected ? { email, value: result.access_token, expiresAt: Date.now() + Number(result.expires_in) * 1000, folder: session?.email === email ? session.folder : null } : null;
    notify();
  }
  function restore(email) {
    if (!email) return Promise.resolve();
    if (restoring?.email === email) return restoring.promise;
    const version = generation;
    const promise = server("/token", email).then(result => accept(result, email, version)).catch(error => {
      if (version === generation) restoreFailure = email;
      throw error;
    }).finally(() => {
      if (restoring?.promise === promise) { restoring = null; notify(); }
    });
    restoring = { email, promise }; notify();
    return promise;
  }
  async function ensure(email) {
    if (!token(email)) await restore(email);
    const value = token(email);
    if (!value) throw new Error("Reconnect Drive before attaching files.");
    return value;
  }
  function connect(email, clientId) {
    if (!email) return Promise.reject(new Error("Sign in to the CRM before attaching files."));
    if (!window.google?.accounts?.oauth2) return Promise.reject(new Error("Google sign-in is still loading. Try again in a moment."));
    const version = generation;
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initCodeClient({
        client_id: clientId, scope: `${scope} openid email`, include_granted_scopes: false,
        ux_mode: "popup", hint: email,
        callback: async (result) => {
          if (!result.code || result.error) { reject(new Error("Drive access was not granted.")); return; }
          try { accept(await server("/connect", email, { code: result.code }), email, version); resolve(); }
          catch (error) { reject(error); }
        },
        error_callback: () => reject(new Error("Drive connection was cancelled.")),
      });
      client.requestCode();
    });
  }
  async function request(url, options, value) {
    const response = await fetch(url, { ...options, headers: { ...options?.headers, Authorization: `Bearer ${value}` } });
    if (!response.ok) {
      const code = response.status;
      if (code === 401) reset();
      throw new Error(code === 401 ? "Drive connection expired. Connect Drive and try again."
        : code === 403 ? "Drive could not save this file. Check your Drive access and available storage."
        : `Drive could not save this file (${code}). Please try again.`);
    }
    return response;
  }
  async function folder(value) {
    if (session?.value === value && session.folder) return session.folder;
    const query = "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='allyCrmAttachments' and value='v1' }";
    const found = await (await request(`${api}?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, {}, value)).json();
    const id = found.files?.[0]?.id || (await (await request(api + "?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ally CRM Attachments", mimeType: "application/vnd.google-apps.folder", appProperties: { allyCrmAttachments: "v1" } }),
    }, value)).json()).id;
    if (!id) throw new Error("Drive could not create the attachment folder.");
    if (session?.value === value) session.folder = id;
    return id;
  }
  async function upload(file, taskId, email, signal) {
    if (file.size > 25 * 1024 * 1024) throw new Error("Choose a file of 25 MB or less.");
    const value = await ensure(email);
    const parent = await folder(value);
    const start = await request("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", "X-Upload-Content-Type": file.type || "application/octet-stream" },
      body: JSON.stringify({ name: file.name, parents: [parent], appProperties: { allyCrmTask: String(taskId) } }),
    }, value);
    const location = start.headers.get("Location");
    if (!location || !["https://www.googleapis.com", "https://content.googleapis.com"].includes(new URL(location).origin)) throw new Error("Drive did not return a valid upload address.");
    const result = await (await request(location, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file, signal }, value)).json();
    if (!/^[\w-]+$/.test(result.id || "")) throw new Error("Drive did not confirm the saved file.");
    return { id: result.id, name: result.name || file.name, mimeType: result.mimeType || file.type || "application/octet-stream", size: Number(result.size || file.size), owner: email };
  }
  window.TaskFiles = { token, connected, restore, ensure, needsRetry(email) { return restoreFailure === email; }, isRestoring(email) { return restoring?.email === email; }, connect, upload, reset, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
})();
