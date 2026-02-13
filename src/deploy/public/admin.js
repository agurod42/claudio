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
    const hadContainer = Boolean(data?.gateway?.hadContainer);
    await loadOverview();
    setStatusText(
      `Deprovisioned ${userLabel}. Closed ${sessionsClosed} session${sessionsClosed === 1 ? "" : "s"}${
        hadContainer ? "; gateway container removed." : "."
      }`,
    );
  } catch {
    setStatusText(`Failed to deprovision ${userLabel}. Check server logs.`);
  } finally {
    deprovisioningUsers.delete(userId);
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
  const onDeprovisionClick = (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const button = target.closest('button[data-action="deprovision-user"]');
    if (!(button instanceof HTMLButtonElement)) {
      return;
    }
    const userId = button.dataset.userId?.trim();
    if (!userId) {
      return;
    }
    void runDeprovision(userId);
  };
  if (els.usersBody) {
    els.usersBody.addEventListener("click", onDeprovisionClick);
  }
};

setup();
loadOverview();
