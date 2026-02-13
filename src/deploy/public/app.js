const screens = {
  landing: document.getElementById("screen-landing"),
  pairing: document.getElementById("screen-pairing"),
  deploying: document.getElementById("screen-deploying"),
  success: document.getElementById("screen-success"),
  customize: document.getElementById("screen-customize"),
  faq: document.getElementById("screen-faq"),
};

const qrCanvas = document.getElementById("qr-canvas");
const qrStatus = document.getElementById("qr-status");
const qrExpiry = document.getElementById("qr-expiry");
const customizeForm = document.getElementById("customize-form");
const customizeStatus = document.getElementById("customize-status");

let currentSessionId = null;
let currentUserId = null;
let eventSource = null;
let authToken = localStorage.getItem("clawdly_auth") || null;
let redirectInFlight = false;
let redirectedToGateway = false;

const showScreen = (name) => {
  Object.values(screens).forEach((screen) => screen.classList.remove("screen-active"));
  if (name === "landing") {
    if (screens.landing) screens.landing.classList.add("screen-active");
    if (screens.faq) screens.faq.classList.add("screen-active");
    return;
  }
  const next = screens[name];
  if (next) {
    next.classList.add("screen-active");
  }
};

const buildGatewayRootPath = (userId, gatewayToken) => {
  if (!userId) {
    return null;
  }
  const proxyBasePath = `/admin/openclaw/${encodeURIComponent(userId)}/`;
  const rootUrl = new URL(proxyBasePath, window.location.origin);
  const wsUrl = new URL(proxyBasePath, window.location.origin);
  wsUrl.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  rootUrl.searchParams.set("gatewayUrl", wsUrl.toString());
  if (gatewayToken) {
    rootUrl.searchParams.set("token", gatewayToken);
  }
  return `${rootUrl.pathname}${rootUrl.search}`;
};

const redirectToGateway = (gatewayPath) => {
  if (!gatewayPath || redirectedToGateway || redirectInFlight) {
    return;
  }
  redirectedToGateway = true;
  redirectInFlight = true;
  try {
    const opened = window.open(gatewayPath, "_blank", "noopener");
    if (!opened) {
      window.location.assign(gatewayPath);
    }
  } finally {
    redirectInFlight = false;
  }
};

const setStatus = (text) => {
  if (qrStatus) {
    qrStatus.textContent = text;
  }
};

const setExpiry = (expiresAt) => {
  if (!qrExpiry) {
    return;
  }
  if (!expiresAt) {
    qrExpiry.textContent = "";
    return;
  }
  const remainingMs = new Date(expiresAt).getTime() - Date.now();
  const minutes = Math.max(0, Math.round(remainingMs / 60000));
  qrExpiry.textContent = minutes > 0 ? `Expires in ~${minutes} min` : "Expiring soon";
};

const renderQr = async (qr) => {
  if (!qrCanvas) {
    return;
  }
  const ctx = qrCanvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, qrCanvas.width, qrCanvas.height);
  if (qr?.image) {
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, qrCanvas.width, qrCanvas.height);
    };
    img.onerror = () => {
      setStatus("Failed to render QR.");
    };
    img.src = qr.image;
    return;
  }
  if (window.QRCode && qr?.qr) {
    window.QRCode.toCanvas(
      qrCanvas,
      qr.qr,
      {
        width: 260,
        margin: 1,
        color: {
          dark: "#1e1c17",
          light: "#ffffff",
        },
      },
      (err) => {
        if (err) {
          setStatus("Failed to render QR.");
        }
      },
    );
    return;
  }
  setStatus("QR received, but renderer is unavailable. Refresh and retry.");
};

const connectStream = (url) => {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(url);
  eventSource.addEventListener("qr", (event) => {
    const data = JSON.parse(event.data);
    setStatus("Scan with WhatsApp");
    setExpiry(data.expiresAt);
    renderQr(data);
    showScreen("pairing");
  });
  eventSource.addEventListener("status", (event) => {
    const data = JSON.parse(event.data);
    const state = data.state;
    if (state === "waiting" || state === "linked") {
      setStatus("Waiting for scan");
      showScreen("pairing");
    }
    if (state === "deploying") {
      showScreen("deploying");
    }
    if (state === "ready") {
      showScreen("success");
      void loadUserAndAgent({ redirectIfGatewayRunning: true });
    }
  });
  eventSource.addEventListener("auth", (event) => {
    const data = JSON.parse(event.data);
    if (data && data.token) {
      authToken = data.token;
      localStorage.setItem("clawdly_auth", data.token);
      void loadUserAndAgent({ redirectIfGatewayRunning: true });
    }
  });
  eventSource.addEventListener("error", (event) => {
    if (event.data) {
      const data = JSON.parse(event.data);
      setStatus(data.message || "Something went wrong.");
    } else {
      setStatus("Connection lost. Please restart.");
    }
    showScreen("pairing");
  });
};

const startSession = async () => {
  setStatus("Requesting QR...");
  setExpiry(null);
  showScreen("pairing");
  currentUserId = null;
  redirectedToGateway = false;
  redirectInFlight = false;
  authToken = null;
  localStorage.removeItem("clawdly_auth");
  try {
    const resp = await fetch("/v1/login-sessions", { method: "POST" });
    if (!resp.ok) {
      throw new Error("Failed to start session");
    }
    const data = await resp.json();
    currentSessionId = data.sessionId;
    connectStream(data.streamUrl);
  } catch (err) {
    setStatus("Could not start login. Try again.");
  }
};

const loadUserAndAgent = async ({ redirectIfGatewayRunning = false } = {}) => {
  if (!currentSessionId) {
    return;
  }
  try {
    const resp = await fetch(`/v1/login-sessions/${currentSessionId}`);
    if (!resp.ok) {
      return;
    }
    const session = await resp.json();
    if (!session.userId) {
      return;
    }
    currentUserId = session.userId;
    if (!authToken) {
      return;
    }
    const agentResp = await fetch(`/v1/agent`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!agentResp.ok) {
      return;
    }
    const agent = await agentResp.json();
    if (redirectIfGatewayRunning && !redirectedToGateway && !redirectInFlight) {
      if (agent.gatewayStatus === "running") {
        const gatewayPath = buildGatewayRootPath(currentUserId, agent.gatewayToken);
        if (gatewayPath) {
          redirectToGateway(gatewayPath);
          return;
        }
      }
    }
    if (!customizeForm) {
      return;
    }
    const nameField = customizeForm.elements.namedItem("name");
    const toneField = customizeForm.elements.namedItem("tone");
    const languageField = customizeForm.elements.namedItem("language");
    const modelTierField = customizeForm.elements.namedItem("modelTier");
    const allowlistField = customizeForm.elements.namedItem("allowlistOnly");
    if (nameField) nameField.value = agent.name || "Claw";
    if (toneField) toneField.value = agent.tone || "Clear and concise";
    if (languageField) languageField.value = agent.language || "Auto";
    if (modelTierField) modelTierField.value = agent.modelTier || "best";
    if (allowlistField) allowlistField.checked = agent.allowlistOnly !== false;
  } catch {
    // ignore
  } finally {
    redirectInFlight = false;
  }
};

const maybeResumeAndRedirect = async () => {
  if (!authToken || redirectedToGateway || redirectInFlight) {
    return;
  }
  try {
    const meResp = await fetch("/v1/me", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!meResp.ok) {
      authToken = null;
      localStorage.removeItem("clawdly_auth");
      return;
    }
    const me = await meResp.json();
    currentUserId = me.userId || null;
    if (!currentUserId) {
      return;
    }
    const agentResp = await fetch("/v1/agent", {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!agentResp.ok) {
      return;
    }
    const agent = await agentResp.json();
    if (agent.gatewayStatus !== "running") {
      return;
    }
    const gatewayPath = buildGatewayRootPath(currentUserId, agent.gatewayToken);
    if (!gatewayPath) {
      return;
    }
    redirectToGateway(gatewayPath);
  } catch {
    // ignore
  } finally {
    redirectInFlight = false;
  }
};

const handleCustomizeSubmit = async (event) => {
  event.preventDefault();
  if (!currentUserId) {
    customizeStatus.textContent = "Your session is not ready yet.";
    return;
  }
  if (!authToken) {
    customizeStatus.textContent = "Missing auth token. Please reconnect.";
    return;
  }
  const nameField = customizeForm.elements.namedItem("name");
  const toneField = customizeForm.elements.namedItem("tone");
  const languageField = customizeForm.elements.namedItem("language");
  const modelTierField = customizeForm.elements.namedItem("modelTier");
  const allowlistField = customizeForm.elements.namedItem("allowlistOnly");
  const payload = {
    name: nameField ? nameField.value.trim() : "",
    tone: toneField ? toneField.value.trim() : "",
    language: languageField ? languageField.value.trim() : "",
    modelTier: modelTierField ? modelTierField.value : "best",
    allowlistOnly: allowlistField ? allowlistField.checked : true,
  };
  try {
    const resp = await fetch(`/v1/agent`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      throw new Error("Failed");
    }
    customizeStatus.textContent = "Saved.";
  } catch {
    customizeStatus.textContent = "Could not save changes.";
  }
};

const setupActions = () => {
  ["cta-hero", "cta-top", "cta-footer", "cta-restart"].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.addEventListener("click", startSession);
    }
  });
  const ctaHow = document.getElementById("cta-how");
  if (ctaHow) {
    ctaHow.addEventListener("click", () => {
      const how = document.getElementById("how");
      if (how) {
        how.scrollIntoView({ behavior: "smooth" });
      }
    });
  }
  const ctaCustomize = document.getElementById("cta-customize");
  if (ctaCustomize) {
    ctaCustomize.addEventListener("click", () => showScreen("customize"));
  }
  const ctaSkip = document.getElementById("cta-skip");
  if (ctaSkip) {
    ctaSkip.addEventListener("click", () => showScreen("success"));
  }
  if (customizeForm) {
    customizeForm.addEventListener("submit", handleCustomizeSubmit);
  }
};

setupActions();
showScreen("landing");
void maybeResumeAndRedirect();
