/* Attachments live in the signed-in user's Drive, never inside the Firestore workspace blob.
   Request drive.file only after an explicit attachment click. Calendar/Sheets tokens are untouched. */
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
  function reset() { session = null; notify(); }
  function connect(email, clientId) {
    if (!email) return Promise.reject(new Error("Sign in to the CRM before attaching files."));
    if (!window.google?.accounts?.oauth2) return Promise.reject(new Error("Google sign-in is still loading. Try again in a moment."));
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: `${scope} openid email`, include_granted_scopes: true, login_hint: email,
        callback: async (result) => {
          if (!result.access_token || !google.accounts.oauth2.hasGrantedAllScopes(result, scope)) {
            reject(new Error("Drive access was not granted. Your task is unchanged.")); return;
          }
          try {
            const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${result.access_token}` } });
            const account = response.ok && await response.json();
            if (!account?.email_verified || String(account.email).toLowerCase() !== email.toLowerCase()) throw new Error("Choose the same Google account you use for the CRM.");
          } catch (error) { reject(error); return; }
          session = { email, value: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000, folder: null };
          notify(); resolve();
        },
        error_callback: () => reject(new Error("Drive connection was cancelled. Your task is unchanged.")),
      });
      client.requestAccessToken({ prompt: "", login_hint: email });
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
    const value = token(email);
    if (!value) throw new Error("Connect Drive before choosing files.");
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
  window.TaskFiles = { token, connect, upload, reset, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
})();
