const STORAGE_KEY = "clawdly_admin_token";

const els = {
  generatedAt: document.getElementById("generated-at"),
  adminToken: document.getElementById("admin-token"),
  saveToken: document.getElementById("save-token"),
  refresh: document.getElementById("refresh"),
  statsCards: document.getElementById("stats-cards"),
  userSearch: document.getElementById("user-search"),
  usersBody: document.getElementById("users-body"),
  sessionSearch: document.getElementById("session-search"),
  sessionState: document.getElementById("session-state"),
  sessionsBody: document.getElementById("sessions-body"),
};

const state = {
  authMode: "token",
  users: [],
  sessions: [],
  stats: {},
};
const deprovisioningUsers = new Set();
const reprovisioningUsers = new Set();
const resetWaUsers = new Set();

// ── Profile modal ────────────────────────────────────────────

const profileModal = {
  overlay: document.getElementById("profile-modal"),
  title: document.getElementById("profile-modal-title"),
  meta: document.getElementById("profile-modal-meta"),
  body: document.getElementById("profile-modal-body"),
  close: document.getElementById("profile-modal-close"),
  resynthesize: document.getElementById("profile-modal-resynthesize"),
  tabs: document.querySelectorAll(".modal-tab"),
};
let profileModalData = null;
let profileModalUserId = null;

/** Minimal markdown → HTML: handles ###, **, *, bullets, paragraphs. */
const renderMarkdown = (md) => {
  const lines = md.split("\n");
  const out = [];
  let inUl = false;

  const flushUl = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Headings
    if (/^#{1,3}\s/.test(line)) {
      flushUl();
      const text = line.replace(/^#{1,3}\s+/, "");
      out.push(`<h3>${escapeHtml(text)}</h3>`);
      continue;
    }

    // Bullet list items  (- or * or •)
    if (/^[\-\*•]\s/.test(line)) {
      if (!inUl) {
        out.push("<ul>");
        inUl = true;
      }
      const text = line.replace(/^[\-\*•]\s+/, "");
      out.push(`<li>${inlineMarkdown(text)}</li>`);
      continue;
    }

    flushUl();

    if (line.trim() === "") {
      continue; // blank lines just close lists
    }

    out.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  flushUl();
  return out.join("\n");
};

/** Bold (**text**) and italic (*text*) inline. */
const inlineMarkdown = (text) =>
  escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");

const renderProfileTab = (data) => {
  if (!data?.profileMd) {
    return '<p class="profile-empty">No projected profile yet. Complete a fresh QR login to generate one.</p>';
  }
  return renderMarkdown(data.profileMd);
};

const renderWaDataTab = (data) => {
  const raw = data?.rawData;
  if (!raw) {
    return '<p class="profile-empty">No WhatsApp data captured yet.</p>';
  }
  const parts = [];
  parts.push(`<div class="wa-capture-section"><h4>Captured</h4><p class="wa-capture-count">${formatDate(raw.capturedAt)} · Display name: <strong>${escapeHtml(raw.displayName ?? "(unknown)")}</strong></p></div>`);

  if (raw.contacts.count > 0) {
    const shown = raw.contacts.names.slice(0, 80);
    const extra = raw.contacts.count - shown.length;
    parts.push(
      `<div class="wa-capture-section"><h4>Contacts (${raw.contacts.count})</h4>` +
      `<ul class="wa-name-list">${shown.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}` +
      (extra > 0 ? `<li style="color:var(--muted)">+${extra} more</li>` : "") +
      `</ul></div>`,
    );
  } else {
    parts.push('<div class="wa-capture-section"><h4>Contacts</h4><p class="profile-empty">None captured.</p></div>');
  }

  if (raw.chats.count > 0) {
    const shown = raw.chats.names.slice(0, 60);
    const extra = raw.chats.count - shown.length;
    parts.push(
      `<div class="wa-capture-section"><h4>Chats (${raw.chats.count})</h4>` +
      `<ul class="wa-name-list">${shown.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}` +
      (extra > 0 ? `<li style="color:var(--muted)">+${extra} more</li>` : "") +
      `</ul></div>`,
    );
  } else {
    parts.push('<div class="wa-capture-section"><h4>Chats</h4><p class="profile-empty">None captured.</p></div>');
  }

  if (raw.messages.count > 0) {
    const bubbles = raw.messages.items
      .map((m) => `<div class="wa-msg wa-msg-${m.role === "me" ? "me" : "them"}">${escapeHtml(m.text)}</div>`)
      .join("");
    parts.push(
      `<div class="wa-capture-section"><h4>Messages (${raw.messages.count} shown)</h4>` +
      `<div class="wa-msg-list">${bubbles}</div></div>`,
    );
  } else {
    parts.push('<div class="wa-capture-section"><h4>Messages</h4><p class="profile-empty">None captured.</p></div>');
  }

  return parts.join("\n");
};

const switchProfileTab = (tab) => {
  profileModal.tabs.forEach((btn) => {
    btn.classList.toggle("modal-tab-active", btn.dataset.tab === tab);
  });
  if (!profileModal.body) return;
  profileModal.body.dataset.activeTab = tab;
  if (tab === "profile") {
    profileModal.body.innerHTML = renderProfileTab(profileModalData);
  } else {
    profileModal.body.innerHTML = renderWaDataTab(profileModalData);
  }
};

const openProfileModal = (userId) => {
  const user = state.users.find((u) => u.userId === userId);
  if (!profileModal.overlay) return;

  profileModalData = null;
  profileModalUserId = userId;
  profileModal.title.textContent = user?.whatsappId ?? userId;
  profileModal.meta.textContent = "Loading…";
  profileModal.body.innerHTML = "";
  profileModal.overlay.hidden = false;
  document.body.style.overflow = "hidden";

  // Reset to Profile tab
  switchProfileTab("profile");

  fetch(`/v1/admin/users/${encodeURIComponent(userId)}/profile`, {
    headers: getAdminHeaders(),
  })
    .then((r) => r.json())
    .then((data) => {
      profileModalData = data;
      const activeTab = profileModal.body?.dataset.activeTab ?? "profile";
      profileModal.meta.textContent = data.updatedAt
        ? `Projected ${formatDate(data.updatedAt)}`
        : data.rawData?.capturedAt
          ? `Captured ${formatDate(data.rawData.capturedAt)} · not yet projected`
          : "No data yet";
      switchProfileTab(activeTab);
    })
    .catch(() => {
      profileModal.meta.textContent = "";
      profileModal.body.innerHTML = '<p class="profile-empty">Failed to load profile.</p>';
    });
};

const closeProfileModal = () => {
  if (profileModal.overlay) profileModal.overlay.hidden = true;
  document.body.style.overflow = "";
};

if (profileModal.close) {
  profileModal.close.addEventListener("click", closeProfileModal);
}
if (profileModal.resynthesize) {
  profileModal.resynthesize.addEventListener("click", async () => {
    const userId = profileModalUserId;
    if (!userId) return;
    const btn = profileModal.resynthesize;
    const original = btn.textContent;
    btn.textContent = "Rebuilding…";
    btn.disabled = true;
    try {
      const r = await fetch(`/v1/admin/users/${encodeURIComponent(userId)}/resynthesize`, {
        method: "POST",
        headers: getAdminHeaders(),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Reload the profile data and re-render
      openProfileModal(userId);
    } catch (err) {
      alert(`Profile rebuild failed: ${err.message}`);
      btn.textContent = original;
      btn.disabled = false;
    }
  });
}
if (profileModal.overlay) {
  profileModal.overlay.addEventListener("click", (e) => {
    if (e.target === profileModal.overlay) closeProfileModal();
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeProfileModal();
});
profileModal.tabs.forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab) switchProfileTab(btn.dataset.tab);
  });
});

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const formatDate = (iso) => {
  if (!iso) {
    return "—";
  }
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
};

const getToken = () => {
  const value = localStorage.getItem(STORAGE_KEY);
  return value && value.trim().length > 0 ? value.trim() : "";
};

const getAdminHeaders = () => {
  const token = getToken();
  return token ? { "x-admin-token": token } : {};
};

const setStatusText = (message) => {
  if (els.generatedAt) {
    els.generatedAt.textContent = message;
  }
};

const statusClass = (status) => {
  const normalized = String(status ?? "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `status status-${normalized}`;
};

const statusBadge = (status) =>
  `<span class="${statusClass(status)}">${escapeHtml(status ?? "unknown")}</span>`;

const addTokenToPath = (path) => {
  const token = getToken();
  if (!token) {
    return path;
  }
  const url = new URL(path, window.location.origin);
  url.searchParams.set("adminToken", token);
  return `${url.pathname}${url.search}`;
};

const buildGatewayRootPath = (proxyBasePath, gatewayToken) => {
  if (!proxyBasePath) {
    return null;
  }
  const adminToken = getToken();
  const rootUrl = new URL(addTokenToPath(proxyBasePath), window.location.origin);
  const wsUrl = new URL(proxyBasePath, window.location.origin);
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (adminToken) {
    wsUrl.searchParams.set("adminToken", adminToken);
  }
  rootUrl.searchParams.set("gatewayUrl", wsUrl.toString());
  if (gatewayToken) {
    rootUrl.searchParams.set("token", gatewayToken);
  }
  return `${rootUrl.pathname}${rootUrl.search}`;
};

const renderStats = () => {
  if (!els.statsCards) {
    return;
  }
  const cards = [
    ["Users", state.stats.usersTotal ?? 0],
    ["Active Users", state.stats.usersActive ?? 0],
    ["Gateways Running", state.stats.gatewaysRunning ?? 0],
    ["Session Total", state.stats.sessionsTotal ?? 0],
    ["Session Ready", state.stats.sessionsReady ?? 0],
    ["Session Errors", state.stats.sessionsError ?? 0],
  ];
  els.statsCards.innerHTML = cards
    .map(
      ([label, value]) => `
      <div class="card">
        <div class="card-label">${escapeHtml(label)}</div>
        <div class="card-value">${escapeHtml(value)}</div>
      </div>
    `,
    )
    .join("");
};

const renderUsers = () => {
  if (!els.usersBody) {
    return;
  }
  const search = (els.userSearch?.value || "").trim().toLowerCase();
  const filtered = state.users.filter((user) => {
    if (!search) {
      return true;
    }
    const parts = [
      user.userId,
      user.whatsappId,
      user.status,
      user.agent?.id,
      user.agent?.name,
      user.gateway?.id,
      user.gateway?.containerId,
      user.gateway?.authDirPath,
      user.latestSession?.id,
      user.latestSession?.errorMessage,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return parts.includes(search);
  });

  if (filtered.length === 0) {
    els.usersBody.innerHTML = `<tr><td class="empty" colspan="6">No users match this filter.</td></tr>`;
    return;
  }

  els.usersBody.innerHTML = filtered
    .map((user) => {
      const rootPath = buildGatewayRootPath(user.gateway?.proxyBasePath, user.gateway?.gatewayToken);
      const canvasPath = user.gateway?.canvasPath ? addTokenToPath(user.gateway.canvasPath) : null;
      const agentText = user.agent
        ? `${escapeHtml(user.agent.name || "Unnamed")} · ${escapeHtml(user.agent.modelTier)}`
        : "Not created";
      const latestSession = user.latestSession
        ? `${statusBadge(user.latestSession.state)}<div class="subtle">${escapeHtml(user.latestSession.id)}</div>${
            user.latestSession.errorMessage
              ? `<div class="subtle">${escapeHtml(user.latestSession.errorMessage)}</div>`
              : ""
          }`
        : `<span class="subtle">None</span>`;
      const gatewayDetails = user.gateway
        ? `<details class="inline-details">
            <summary>Gateway details</summary>
            <div class="details-grid">
              <div><span class="subtle">Auth dir</span><div class="mono">${escapeHtml(user.gateway.authDirPath || "n/a")}</div></div>
              <div><span class="subtle">Created</span><div>${formatDate(user.gateway.createdAt)}</div></div>
              <div><span class="subtle">Runtime IP</span><div class="mono">${escapeHtml(user.gateway.runtimeIp || "n/a")}</div></div>
            </div>
          </details>`
        : "";
      const gateway = user.gateway
        ? `${statusBadge(user.gateway.status)}
            <div class="mono">${escapeHtml(user.gateway.id)}</div>
            <div class="subtle">container: ${escapeHtml(user.gateway.containerId || "n/a")}</div>
            <div class="subtle">runtime: ${escapeHtml(user.gateway.runtimeStatus || "unknown")}</div>
            ${gatewayDetails}`
        : `<span class="subtle">Not provisioned</span>`;
      const deprovisionBusy = deprovisioningUsers.has(user.userId);
      const reprovisionBusy = reprovisioningUsers.has(user.userId);
      const resetWaBusy = resetWaUsers.has(user.userId);
      const deprovisionLabel = user.gateway?.containerId
        ? "Close Session + Deprovision"
        : "Close Session";
      const actions = `<div class="actions-row">
          ${
            rootPath
              ? `<a class="mini-link" href="${escapeHtml(rootPath)}" target="_blank" rel="noreferrer">Gateway Root</a>`
              : ""
          }
          ${
            canvasPath
              ? `<a class="mini-link" href="${escapeHtml(canvasPath)}" target="_blank" rel="noreferrer">Canvas</a>`
              : ""
          }
          ${
            user.gateway
              ? `<button
                  type="button"
                  class="mini-btn"
                  data-action="reprovision-user"
                  data-user-id="${escapeHtml(user.userId)}"
                  ${reprovisionBusy ? "disabled" : ""}
                >
                  ${escapeHtml(reprovisionBusy ? "Reprovisioning..." : "Reprovision")}
                </button>`
              : ""
          }
          <button
            type="button"
            class="mini-btn"
            data-action="view-profile"
            data-user-id="${escapeHtml(user.userId)}"
          >
            View Profile
          </button>
          <button
            type="button"
            class="mini-btn mini-btn-danger"
            data-action="reset-wa-session"
            data-user-id="${escapeHtml(user.userId)}"
            ${resetWaBusy ? "disabled" : ""}
          >
            ${escapeHtml(resetWaBusy ? "Resetting..." : "Reset WA")}
          </button>
          <button
            type="button"
            class="mini-btn mini-btn-danger"
            data-action="deprovision-user"
            data-user-id="${escapeHtml(user.userId)}"
            ${deprovisionBusy ? "disabled" : ""}
          >
            ${escapeHtml(deprovisionBusy ? "Working..." : deprovisionLabel)}
          </button>
        </div>`;
      return `
        <tr>
          <td>
            <div>${escapeHtml(user.whatsappId)}</div>
            <div class="subtle">${statusBadge(user.status)}</div>
          </td>
          <td>
            <div class="mono">${escapeHtml(user.userId)}</div>
            <div class="subtle">${formatDate(user.createdAt)}</div>
          </td>
          <td>
            <div>${agentText}</div>
            ${
              user.agent
                ? `<div class="subtle">${escapeHtml(user.agent.language || "auto")} · ${
                    user.agent.allowlistOnly ? "allowlist-only" : "open"
                  }</div>`
                : ""
            }
          </td>
          <td>${latestSession}</td>
          <td>${gateway}</td>
          <td>${actions}</td>
        </tr>
      `;
    })
    .join("");
};

const renderSessions = () => {
  if (!els.sessionsBody) {
    return;
  }
  const search = (els.sessionSearch?.value || "").trim().toLowerCase();
  const stateFilter = els.sessionState?.value || "all";
  const filtered = state.sessions.filter((session) => {
    if (stateFilter !== "all" && session.state !== stateFilter) {
      return false;
    }
    if (!search) {
      return true;
    }
    const composite = [
      session.id,
      session.state,
      session.userId,
      session.whatsappId,
      session.errorCode,
      session.errorMessage,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return composite.includes(search);
  });

  if (filtered.length === 0) {
    els.sessionsBody.innerHTML = `<tr><td class="empty" colspan="7">No sessions match this filter.</td></tr>`;
    return;
  }

  els.sessionsBody.innerHTML = filtered
    .map(
      (session) => `
      <tr>
        <td class="mono">${escapeHtml(session.id)}</td>
        <td>${statusBadge(session.state)}</td>
        <td class="mono">${escapeHtml(session.userId || "—")}</td>
        <td>${escapeHtml(session.whatsappId || "—")}</td>
        <td>${formatDate(session.createdAt)}</td>
        <td>${formatDate(session.expiresAt)}</td>
        <td>
          ${
            session.errorCode || session.errorMessage
              ? `<div>${escapeHtml(session.errorCode || "error")}</div><div class="subtle">${escapeHtml(
                  session.errorMessage || "",
                )}</div>`
              : `<span class="subtle">—</span>`
          }
        </td>
      </tr>
    `,
    )
    .join("");
};

const renderAll = () => {
  renderStats();
  renderUsers();
  renderSessions();
};

const runDeprovision = async (userId) => {
  if (!userId || deprovisioningUsers.has(userId)) {
    return;
  }
  const user = state.users.find((entry) => entry.userId === userId);
  const userLabel = user?.whatsappId || userId;
  const confirmed = window.confirm(
    `Close active session and deprovision ${userLabel}? This will stop and remove the user's gateway container.`,
  );
  if (!confirmed) {
    return;
  }

  deprovisioningUsers.add(userId);
  renderUsers();
  setStatusText(`Deprovisioning ${userLabel}...`);

  try {
    const resp = await fetch(`/v1/admin/users/${encodeURIComponent(userId)}/deprovision`, {
      method: "POST",
      headers: getAdminHeaders(),
    });
    if (resp.status === 401) {
      setStatusText("Unauthorized. Save a valid admin token, then refresh.");
      return;
    }
    if (resp.status === 404) {
      setStatusText("Admin dashboard is disabled in production without OPENCLAW_DEPLOY_ADMIN_TOKEN.");
      return;
    }
    if (!resp.ok) {
      setStatusText(`Could not deprovision ${userLabel} (HTTP ${resp.status}).`);
      return;
    }

    const data = await resp.json();
    const sessionsClosed =
      data && typeof data.sessionsClosed === "number" ? data.sessionsClosed : 0;
    await loadOverview();
    setStatusText(
      `Deprovisioned ${userLabel}. Closed ${sessionsClosed} session${sessionsClosed === 1 ? "" : "s"}.`,
    );
  } catch {
    setStatusText(`Failed to deprovision ${userLabel}. Check server logs.`);
  } finally {
    deprovisioningUsers.delete(userId);
    renderUsers();
  }
};

const runReprovision = async (userId) => {
  if (!userId || reprovisioningUsers.has(userId)) {
    return;
  }
  const user = state.users.find((entry) => entry.userId === userId);
  const userLabel = user?.whatsappId || userId;
  const confirmed = window.confirm(
    `Reprovision gateway for ${userLabel}? This will recreate the container with the latest config and model settings.`,
  );
  if (!confirmed) {
    return;
  }

  reprovisioningUsers.add(userId);
  renderUsers();
  setStatusText(`Reprovisioning ${userLabel}...`);

  try {
    const resp = await fetch(`/v1/admin/users/${encodeURIComponent(userId)}/reprovision`, {
      method: "POST",
      headers: getAdminHeaders(),
    });
    if (resp.status === 401) {
      setStatusText("Unauthorized. Save a valid admin token, then refresh.");
      return;
    }
    if (resp.status === 404) {
      setStatusText("User not found or admin dashboard disabled.");
      return;
    }
    if (!resp.ok) {
      setStatusText(`Could not reprovision ${userLabel} (HTTP ${resp.status}).`);
      return;
    }

    const data = await resp.json();
    await loadOverview();
    setStatusText(
      `Reprovisioned ${userLabel}. Gateway ${data.healthy ? "is healthy" : "failed health check"}.`,
    );
  } catch {
    setStatusText(`Failed to reprovision ${userLabel}. Check server logs.`);
  } finally {
    reprovisioningUsers.delete(userId);
    renderUsers();
  }
};

const runResetWaSession = async (userId) => {
  if (!userId || resetWaUsers.has(userId)) {
    return;
  }
  const user = state.users.find((entry) => entry.userId === userId);
  const userLabel = user?.whatsappId || userId;
  const confirmed = window.confirm(
    `Reset WhatsApp session for ${userLabel}?\n\nThis will:\n• Stop the gateway\n• Delete the WA credentials\n• Require a fresh QR code scan to reconnect\n\nThe next login will capture full contact/chat history for profile projection.`,
  );
  if (!confirmed) {
    return;
  }

  resetWaUsers.add(userId);
  renderUsers();
  setStatusText(`Resetting WA session for ${userLabel}...`);

  try {
    const resp = await fetch(`/v1/admin/users/${encodeURIComponent(userId)}/reset-wa-session`, {
      method: "POST",
      headers: getAdminHeaders(),
    });
    if (resp.status === 401) {
      setStatusText("Unauthorized. Save a valid admin token, then refresh.");
      return;
    }
    if (resp.status === 404) {
      setStatusText("User not found or admin dashboard disabled.");
      return;
    }
    if (!resp.ok) {
      setStatusText(`Could not reset WA session for ${userLabel} (HTTP ${resp.status}).`);
      return;
    }

    await loadOverview();
    setStatusText(`WA session reset for ${userLabel}. User must scan a new QR code to reconnect.`);
  } catch {
    setStatusText(`Failed to reset WA session for ${userLabel}. Check server logs.`);
  } finally {
    resetWaUsers.delete(userId);
    renderUsers();
  }
};

const loadOverview = async () => {
  setStatusText("Loading data...");
  const token = getToken();
  if (els.adminToken && els.adminToken.value !== token) {
    els.adminToken.value = token;
  }
  try {
    const resp = await fetch("/v1/admin/overview", {
      headers: getAdminHeaders(),
    });
    if (resp.status === 401) {
      setStatusText("Unauthorized. Save a valid admin token, then refresh.");
      return;
    }
    if (resp.status === 404) {
      setStatusText("Admin dashboard is disabled in production without OPENCLAW_DEPLOY_ADMIN_TOKEN.");
      return;
    }
    if (!resp.ok) {
      setStatusText(`Could not load admin data (HTTP ${resp.status}).`);
      return;
    }
    const data = await resp.json();
    state.authMode = data.authMode || "token";
    state.users = Array.isArray(data.users) ? data.users : [];
    state.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    state.stats = data.stats || {};
    renderAll();
    const modeText = state.authMode === "open" ? "open mode" : "token mode";
    setStatusText(`Updated ${formatDate(data.generatedAt)} (${modeText})`);
  } catch {
    setStatusText("Failed to load admin data. Check server logs.");
  }
};

const setup = () => {
  if (els.adminToken) {
    els.adminToken.value = getToken();
  }
  if (els.saveToken) {
    els.saveToken.addEventListener("click", () => {
      const token = els.adminToken?.value?.trim() || "";
      if (!token) {
        localStorage.removeItem(STORAGE_KEY);
        setStatusText("Admin token cleared.");
        return;
      }
      localStorage.setItem(STORAGE_KEY, token);
      setStatusText("Admin token saved.");
    });
  }
  if (els.refresh) {
    els.refresh.addEventListener("click", loadOverview);
  }
  if (els.userSearch) {
    els.userSearch.addEventListener("input", renderUsers);
  }
  if (els.sessionSearch) {
    els.sessionSearch.addEventListener("input", renderSessions);
  }
  if (els.sessionState) {
    els.sessionState.addEventListener("change", renderSessions);
  }
  const onUserAction = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const deprovisionBtn = target.closest('button[data-action="deprovision-user"]');
    if (deprovisionBtn instanceof HTMLButtonElement) {
      const userId = deprovisionBtn.dataset.userId?.trim();
      if (userId) {
        void runDeprovision(userId);
      }
      return;
    }
    const reprovisionBtn = target.closest('button[data-action="reprovision-user"]');
    if (reprovisionBtn instanceof HTMLButtonElement) {
      const userId = reprovisionBtn.dataset.userId?.trim();
      if (userId) {
        void runReprovision(userId);
      }
      return;
    }
    const resetWaBtn = target.closest('button[data-action="reset-wa-session"]');
    if (resetWaBtn instanceof HTMLButtonElement) {
      const userId = resetWaBtn.dataset.userId?.trim();
      if (userId) {
        void runResetWaSession(userId);
      }
      return;
    }
    const viewProfileBtn = target.closest('button[data-action="view-profile"]');
    if (viewProfileBtn instanceof HTMLButtonElement) {
      const userId = viewProfileBtn.dataset.userId?.trim();
      if (userId) {
        openProfileModal(userId);
      }
    }
  };
  if (els.usersBody) {
    els.usersBody.addEventListener("click", onUserAction);
  }
};

setup();
loadOverview();
