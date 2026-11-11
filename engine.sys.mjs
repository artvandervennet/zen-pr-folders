/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shared engine: one instance for the whole browser.
// Holds the configuration and the token, runs the searches and hands the result
// to the window script, which creates and moves the tabs.

import { setInterval, clearInterval } from "resource://gre/modules/Timer.sys.mjs";
import { composeQuery, hasQualifier, parseItemId } from "./lib/query.sys.mjs";
import { searchPulls } from "./lib/github.sys.mjs";
import { searchPullsBySession } from "./lib/session.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const MAX_PAGE_BYTES = 5 * 1024 * 1024;

/**
 * Fetches a github.com page with the cookies of the given container, the way Zen's own
 * live folders do (nsZenLiveFolderProvider.fetch). Resolves to { status, text }.
 */
function sessionFetch(url, headers = {}, userContextId = 0) {
  const uri = lazy.NetUtil.newURI(url);
  const principal = Services.scriptSecurityManager.createContentPrincipal(uri, { userContextId });
  const channel = lazy.NetUtil.newChannel({
    uri,
    // TYPE_SAVEAS_DOWNLOAD makes the channel use the principal given here, so cookies are sent.
    contentPolicyType: Ci.nsIContentPolicy.TYPE_SAVEAS_DOWNLOAD,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    securityFlags:
      Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL | Ci.nsILoadInfo.SEC_COOKIES_INCLUDE,
  }).QueryInterface(Ci.nsIHttpChannel);
  for (const [name, value] of Object.entries(headers)) {
    channel.setRequestHeader(name, value, false);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let status = 0;
    channel.asyncOpen({
      onStartRequest(request) {
        try {
          status = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
        } catch {}
      },
      onDataAvailable(request, stream, offset, count) {
        total += count;
        if (total > MAX_PAGE_BYTES) {
          request.cancel(Cr.NS_ERROR_FILE_TOO_BIG);
          return;
        }
        chunks.push(new Uint8Array(lazy.NetUtil.readInputStream(stream, count)));
      },
      onStopRequest(request, code) {
        if (!Components.isSuccessCode(code)) {
          reject(new Error(`request failed (0x${code.toString(16)})`));
          return;
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, at);
          at += chunk.length;
        }
        resolve({ status, text: new TextDecoder().decode(bytes) });
      },
    });
  });
}
import { buildEntries, filterStack } from "./lib/group.sys.mjs";

export { diffContainer } from "./lib/reconcile.sys.mjs";
export { parseItemId, itemId } from "./lib/query.sys.mjs";

const CONFIG_FILE = "zen-pr-folders.json";
const LOGIN_ORIGIN = "chrome://zen-pr-folders";
const LOGIN_REALM = "GitHub token";
const INTERVAL_PREF = "zen-pr-folders.default-interval";
const TICK_MS = 5_000;
const MIN_INTERVAL = 15;
const ORPHAN_MS = 7 * 24 * 60 * 60 * 1000;

function newContainer(id, query, name = "", options = {}) {
  return {
    id,
    name,
    query,
    // Lines under this folder and under the stack groups in it (custom indentation only).
    divider: options.divider !== false,
    stackDivider: options.stackDivider !== false,
    dismissed: [],
    stackFolders: {},
    stackQueries: {},
  };
}

class PrFoldersEngine {
  #config = { folders: [], presets: [], stackIcon: "" };
  #loaded = null;
  #savedJson = "";
  #windows = new Map();
  #timer = null;
  #token;
  #busy = new Set();
  #fetched = new Map();
  #pausedUntil = 0;
  #observing = false;
  #stackCache = new Map();
  #shapeLogged = false;

  /** Logs the field names github.com returned, once per session. Names only, no content. */
  #logShape(shape) {
    this.#shapeLogged = true;
    console.info("[zen-pr-folders] github.com list format", JSON.stringify(shape));
  }

  // --- configuration -----------------------------------------------------

  get #path() {
    return PathUtils.join(PathUtils.profileDir, CONFIG_FILE);
  }

  load() {
    this.#loaded ??= (async () => {
      try {
        const data = await IOUtils.readJSON(this.#path);
        if (Array.isArray(data?.folders)) {
          this.#config = data;
        }
      } catch (error) {
        if (error.name !== "NotFoundError") {
          console.error("[zen-pr-folders] could not read the configuration", error);
        }
      }
      this.#config.presets ??= [];
      this.#config.stackIcon ??= "";
      for (const folder of this.#config.folders) {
        folder.subfolders ??= [];
        for (const container of [folder, ...folder.subfolders]) {
          container.dismissed ??= [];
          container.stackFolders ??= {};
          container.stackQueries ??= {};
        }
      }
      this.#savedJson = JSON.stringify(this.#config);
    })();
    return this.#loaded;
  }

  async #save() {
    const json = JSON.stringify(this.#config);
    if (json === this.#savedJson) {
      return;
    }
    this.#savedJson = json;
    try {
      await IOUtils.writeJSON(this.#path, this.#config, { tmpPath: `${this.#path}.tmp` });
    } catch (error) {
      console.error("[zen-pr-folders] could not save the configuration", error);
    }
  }

  get defaultInterval() {
    let value = 60;
    try {
      const type = Services.prefs.getPrefType(INTERVAL_PREF);
      if (type === Services.prefs.PREF_INT) {
        value = Services.prefs.getIntPref(INTERVAL_PREF);
      } else if (type === Services.prefs.PREF_STRING) {
        value = Number(Services.prefs.getStringPref(INTERVAL_PREF));
      }
    } catch {}
    return Number.isFinite(value) && value >= MIN_INTERVAL ? value : 60;
  }

  /**
   * What a Zen folder id means to this mod, or null when it is not managed.
   * kind "folder":    a top-level PR folder
   * kind "subfolder": a hand-made subfolder with its own query
   * kind "stack":     an automatic stack group; `container` is the folder it sits in
   */
  describe(id) {
    for (const folder of this.#config.folders) {
      if (folder.id === id) {
        return { kind: "folder", folder, container: folder, query: folder.query };
      }
      for (const container of [folder, ...folder.subfolders]) {
        if (container !== folder && container.id === id) {
          return { kind: "subfolder", folder, container, query: container.query };
        }
        for (const [stackKey, stackFolderId] of Object.entries(container.stackFolders)) {
          if (stackFolderId === id) {
            return {
              kind: "stack",
              folder,
              container,
              stackKey,
              query: container.stackQueries[stackKey] ?? "",
            };
          }
        }
      }
    }
    return null;
  }

  async addFolder(id, query, options = {}) {
    await this.load();
    const folder = newContainer(id, query, "", options);
    folder.interval = this.defaultInterval;
    folder.subfolders = [];
    this.#config.folders.push(folder);
    await this.#save();
    return this.refresh(id);
  }

  async addSubfolder(parentId, id, name, query, options = {}) {
    const parent = this.describe(parentId);
    if (parent?.kind !== "folder") {
      return;
    }
    parent.folder.subfolders.push(newContainer(id, query, name, options));
    await this.#save();
    await this.refresh(parent.folder.id);
  }

  /** Sets the query of a folder, a subfolder or a stack group. An empty stack query removes the filter. */
  async setQuery(id, query) {
    const found = this.describe(id);
    if (!found) {
      return;
    }
    if (found.kind === "stack") {
      if (query) {
        found.container.stackQueries[found.stackKey] = query;
      } else {
        delete found.container.stackQueries[found.stackKey];
      }
    } else {
      found.container.query = query;
    }
    await this.#save();
    await this.refresh(found.folder.id);
  }

  /** key is "divider" (the folder's own line) or "stackDivider" (lines under its stack groups). */
  async setDivider(id, key, enabled) {
    const found = this.describe(id);
    if (!found || !["divider", "stackDivider"].includes(key)) {
      return;
    }
    found.container[key] = !!enabled;
    await this.#save();
  }

  async setFolderInterval(id, seconds) {
    const found = this.describe(id);
    if (!found) {
      return;
    }
    found.folder.interval = Math.max(MIN_INTERVAL, seconds);
    await this.#save();
  }

  /** The user closed a managed tab: leave that pull request out until it stops matching. */
  async dismiss(tabItemId) {
    const parsed = parseItemId(tabItemId);
    const found = parsed && this.describe(parsed.containerId);
    if (!found || found.kind === "stack") {
      return;
    }
    if (!found.container.dismissed.includes(parsed.key)) {
      found.container.dismissed.push(parsed.key);
      await this.#save();
    }
  }

  async restoreDismissed(id) {
    const found = this.describe(id);
    if (!found) {
      return;
    }
    const containers =
      found.kind === "folder" ? [found.folder, ...found.folder.subfolders] : [found.container];
    for (const container of containers) {
      container.dismissed = [];
    }
    await this.#save();
    await this.refresh(found.folder.id);
  }

  /** Stops managing a folder or subfolder. The Zen folder and its tabs stay. */
  async forget(id) {
    const found = this.describe(id);
    if (!found || found.kind === "stack") {
      return;
    }
    if (found.kind === "folder") {
      this.#config.folders = this.#config.folders.filter(folder => folder !== found.folder);
      this.#fetched.delete(id);
    } else {
      found.folder.subfolders = found.folder.subfolders.filter(sub => sub !== found.container);
    }
    await this.#save();
    if (found.kind === "subfolder") {
      await this.refresh(found.folder.id);
    }
  }

  // --- presets and stack icon ---------------------------------------------

  /** Presets are folders remembered by name: { name, icon, query }. */
  get presets() {
    return this.#config.presets;
  }

  /** Saves a preset, replacing one with the same name. */
  async savePreset({ name, icon = "", query = "", divider = true, stackDivider = true }) {
    if (!name) {
      return;
    }
    this.#config.presets = [
      ...this.#config.presets.filter(preset => preset.name !== name),
      { name, icon, query, divider, stackDivider },
    ].sort((a, b) => a.name.localeCompare(b.name));
    await this.#save();
  }

  async removePreset(name) {
    this.#config.presets = this.#config.presets.filter(preset => preset.name !== name);
    await this.#save();
  }

  /** Icon given to new stack groups. Empty means Zen's default folder icon. */
  get stackIcon() {
    return this.#config.stackIcon;
  }

  async setStackIcon(icon) {
    this.#config.stackIcon = icon ?? "";
    await this.#save();
  }

  // --- token -------------------------------------------------------------

  async #getToken() {
    if (this.#token === undefined) {
      try {
        const logins = await Services.logins.searchLoginsAsync({
          origin: LOGIN_ORIGIN,
          httpRealm: LOGIN_REALM,
        });
        this.#token = logins[0]?.password ?? "";
      } catch (error) {
        console.error("[zen-pr-folders] could not read the token", error);
        return "";
      }
    }
    return this.#token;
  }

  async hasToken() {
    return !!(await this.#getToken());
  }

  /** Stores the token in Firefox's login store. An empty token removes it. */
  async setToken(token) {
    const existing = await Services.logins.searchLoginsAsync({
      origin: LOGIN_ORIGIN,
      httpRealm: LOGIN_REALM,
    });
    for (const login of existing) {
      Services.logins.removeLogin(login);
    }
    if (token) {
      const info = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
      info.init(LOGIN_ORIGIN, null, LOGIN_REALM, "github", token, "", "");
      await Services.logins.addLoginAsync(info);
    }
    this.#token = token;
    this.#pausedUntil = 0;
    await this.refresh();
  }

  // --- windows -----------------------------------------------------------

  /**
   * ui = { exists(id), contextId(id), apply(plan), showError(folderId, message | null) }
   * Only one window does the work: Zen mirrors folders and tabs to the others itself.
   */
  async register(window, ui) {
    await this.load();
    this.#windows.set(window, ui);
    if (!this.#observing) {
      Services.obs.addObserver(this, "wake_notification");
      this.#observing = true;
    }
    this.#timer ??= setInterval(() => this.#tick(), TICK_MS);
    this.#tick();
  }

  unregister(window) {
    this.#windows.delete(window);
    if (this.#windows.size) {
      return;
    }
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#observing) {
      Services.obs.removeObserver(this, "wake_notification");
      this.#observing = false;
    }
  }

  observe(subject, topic) {
    if (topic === "wake_notification") {
      this.refresh();
    }
  }

  #ui() {
    let first = null;
    try {
      first = ChromeUtils.importESModule("resource:///modules/zen/ZenWindowSync.sys.mjs")
        .ZenWindowSync?.firstSyncedWindow;
    } catch {}
    if (first && this.#windows.has(first)) {
      return this.#windows.get(first);
    }
    for (const [window, ui] of this.#windows) {
      if (!window.closed) {
        return ui;
      }
    }
    return null;
  }

  // --- refreshing --------------------------------------------------------

  #tick() {
    const now = Date.now();
    if (now < this.#pausedUntil) {
      return;
    }
    for (const folder of this.#config.folders) {
      const interval = Math.max(MIN_INTERVAL, folder.interval || this.defaultInterval) * 1000;
      if (now - (this.#fetched.get(folder.id) ?? 0) >= interval) {
        this.#refreshFolder(folder);
      }
    }
  }

  /** Refreshes one folder (by the id of the folder or anything inside it), or all of them. */
  async refresh(id = null) {
    await this.load();
    const target = id ? this.describe(id)?.folder : null;
    const folders = target ? [target] : this.#config.folders;
    await Promise.all(folders.map(folder => this.#refreshFolder(folder)));
  }

  /** Refreshes folders whose last fetch is older than maxAgeMs. Used on focus and on expand. */
  refreshStale(maxAgeMs, id = null) {
    const now = Date.now();
    if (now < this.#pausedUntil) {
      return;
    }
    const target = id ? this.describe(id)?.folder : null;
    for (const folder of target ? [target] : this.#config.folders) {
      if (now - (this.#fetched.get(folder.id) ?? 0) >= maxAgeMs) {
        this.#refreshFolder(folder);
      }
    }
  }

  /** Returns false when the Zen folder is gone. Forgets it after a week of absence. */
  #present(ui, container, drop) {
    if (ui.exists(container.id)) {
      delete container.missingSince;
      return true;
    }
    container.missingSince ??= Date.now();
    if (Date.now() - container.missingSince > ORPHAN_MS) {
      drop();
    }
    return false;
  }

  async #refreshFolder(folder) {
    const ui = this.#ui();
    if (!ui || this.#busy.has(folder.id)) {
      return;
    }
    this.#fetched.set(folder.id, Date.now());

    const stillThere = this.#present(ui, folder, () => {
      this.#config.folders = this.#config.folders.filter(other => other !== folder);
    });
    if (!stillThere) {
      await this.#save();
      return;
    }

    this.#busy.add(folder.id);
    try {
      // With a token the documented API is used. Without one, the login of the folder's space.
      const token = await this.#getToken();
      const contextId = ui.contextId?.(folder.id) ?? 0;
      const fetchText = (url, headers) => sessionFetch(url, headers, contextId);
      const run = query =>
        token
          ? searchPulls({ query, token })
          : searchPullsBySession({
              query,
              fetchText,
              cache: this.#stackCache,
              onShape: this.#shapeLogged ? null : shape => this.#logShape(shape),
            });

      const subfolders = folder.subfolders.filter(sub =>
        this.#present(ui, sub, () => {
          folder.subfolders = folder.subfolders.filter(other => other !== sub);
        })
      );

      const plans = [];
      const claimed = new Set();
      for (const sub of subfolders) {
        const pulls = await run(composeQuery(folder.query, sub.query));
        for (const pull of pulls) {
          claimed.add(pull.key);
        }
        plans.push(await this.#plan(sub, pulls, [folder.query, sub.query], run));
      }
      // The folder itself shows what matches its query and no subfolder.
      const rootPulls = (await run(composeQuery(folder.query))).filter(
        pull => !claimed.has(pull.key)
      );
      plans.push(await this.#plan(folder, rootPulls, [folder.query], run));

      const result = await ui.apply({ folderId: folder.id, containers: plans });
      for (const applied of result?.containers ?? []) {
        const container = [folder, ...folder.subfolders].find(c => c.id === applied.id);
        if (!container) {
          continue;
        }
        container.dismissed = applied.dismissed;
        container.stackFolders = applied.stackFolders;
        for (const key of Object.keys(container.stackQueries)) {
          if (!(key in container.stackFolders)) {
            delete container.stackQueries[key];
          }
        }
      }
      ui.showError(folder.id, null);
    } catch (error) {
      if (error.kind === "rate" && error.retryAt) {
        this.#pausedUntil = error.retryAt;
      }
      if (!error.kind) {
        console.error("[zen-pr-folders] refresh failed", error);
      }
      try {
        ui.showError(folder.id, error.message || String(error));
      } catch {}
    } finally {
      this.#busy.delete(folder.id);
      await this.#save();
    }
  }

  async #plan(container, pulls, queryParts, run) {
    // Without update times (a format change on github.com) GitHub's own order is the best there is.
    const searchOrder =
      queryParts.some(part => hasQualifier(part, "sort")) || pulls.some(pull => !pull.updatedAt);
    const entries = buildEntries(pulls, { searchOrder });
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const stackQuery = entry.type === "stack" && container.stackQueries[entry.key];
      if (!stackQuery) {
        continue;
      }
      const allowed = await run(composeQuery(...queryParts, stackQuery, `repo:${entry.repo}`));
      entries[i] = filterStack(entry, new Set(allowed.map(pull => pull.key)));
    }
    return {
      id: container.id,
      entries,
      dismissed: [...container.dismissed],
      stackFolders: { ...container.stackFolders },
    };
  }
}

export const Engine = new PrFoldersEngine();
