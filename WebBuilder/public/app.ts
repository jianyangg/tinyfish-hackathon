const form = document.getElementById("pitch-form") as HTMLFormElement;
const textarea = document.getElementById("pitch") as HTMLTextAreaElement;
const submitBtn = document.getElementById("submit-btn") as HTMLButtonElement;
const sessionsContainer = document.getElementById("sessions-container") as HTMLElement;

type SessionStatusTone = "idle" | "running" | "warn" | "ok" | "error";

interface PermissionRequest {
  id: string;
  message: string;
}

interface SessionStartPayload {
  sessionId: string;
  title: string;
}

interface BuildItem {
  title: string;
  whatToBuild: string;
  expectedUser: string;
  additionalContext: string;
}

interface BatchResponse {
  sessions: SessionStartPayload[];
}

interface SessionView {
  stream: EventSource | null;
  statusBadge: HTMLSpanElement;
  summaryText: HTMLParagraphElement;
  permissionPanel: HTMLElement;
  permissionMessage: HTMLParagraphElement;
  approveBtn: HTMLButtonElement;
  denyBtn: HTMLButtonElement;
  previewFrame: HTMLIFrameElement;
  expandBtn: HTMLButtonElement;
  pendingPermission: PermissionRequest | null;
  previewRefreshTimer: number | null;
  previewUrl: string;
}

const sessionViews = new Map<string, SessionView>();

function setStatus(view: SessionView, label: string, tone: SessionStatusTone): void {
  view.statusBadge.textContent = label;

  const toneMap: Record<SessionStatusTone, { fg: string; bg: string; border: string }> = {
    idle: { fg: "#ffcc66", bg: "rgba(255, 204, 102, 0.2)", border: "rgba(255, 204, 102, 0.45)" },
    running: { fg: "#6bd6ff", bg: "rgba(107, 214, 255, 0.2)", border: "rgba(107, 214, 255, 0.45)" },
    warn: { fg: "#ffd280", bg: "rgba(255, 210, 128, 0.2)", border: "rgba(255, 210, 128, 0.45)" },
    ok: { fg: "#9bf0c8", bg: "rgba(155, 240, 200, 0.2)", border: "rgba(155, 240, 200, 0.45)" },
    error: { fg: "#ff9b9b", bg: "rgba(255, 155, 155, 0.2)", border: "rgba(255, 155, 155, 0.45)" },
  };

  const style = toneMap[tone];
  view.statusBadge.style.color = style.fg;
  view.statusBadge.style.backgroundColor = style.bg;
  view.statusBadge.style.borderColor = style.border;
}

function closeStream(view: SessionView): void {
  if (view.stream) {
    view.stream.close();
    view.stream = null;
  }
}

function clearPermission(view: SessionView): void {
  view.pendingPermission = null;
  view.permissionPanel.classList.add("hidden");
}

function showPermission(view: SessionView, request: PermissionRequest): void {
  view.pendingPermission = request;
  view.permissionMessage.textContent = request.message;
  view.permissionPanel.classList.remove("hidden");
  setStatus(view, "Awaiting Approval", "warn");
  setSummary(view, "Waiting for approval to continue.");
}

function setSummary(view: SessionView, summary: string): void {
  view.summaryText.textContent = summary;
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");
}

function summarizeOutputChunk(text: string): string | null {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || /^(\d+\/\d+|token|at\s+\S)/i.test(line)) {
      continue;
    }
    if (/permission|approve|deny/i.test(line)) {
      return "Agent is blocked and waiting for permission input.";
    }
    if (/write|edit|create|update|patch/i.test(line)) {
      return "Agent is generating and editing website files.";
    }
    if (/build|compile|test|npm|pnpm|yarn|run/i.test(line)) {
      return "Agent is running project commands and checks.";
    }
    if (/done|completed|finished/i.test(line)) {
      return "Agent is finalizing the website output.";
    }

    return line.length > 140 ? `${line.slice(0, 137)}...` : line;
  }

  return null;
}

function startPreviewRefresh(view: SessionView): void {
  const load = (): void => {
    view.previewFrame.src = `${view.previewUrl}?t=${Date.now()}`;
  };

  load();
  if (view.previewRefreshTimer) {
    window.clearInterval(view.previewRefreshTimer);
  }
  view.previewRefreshTimer = window.setInterval(load, 3000);
}

function stopPreviewRefresh(view: SessionView): void {
  if (view.previewRefreshTimer) {
    window.clearInterval(view.previewRefreshTimer);
    view.previewRefreshTimer = null;
  }
  view.previewFrame.src = view.previewUrl;
}

function showExpandButton(view: SessionView): void {
  view.expandBtn.disabled = false;
  view.expandBtn.classList.remove("hidden");
}

function parsePitchesJson(rawInput: string): BuildItem[] {
  const parsed = JSON.parse(rawInput) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Input must be a non-empty JSON array.");
  }

  const normalized: BuildItem[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      throw new Error("Each item must be an object.");
    }

    const candidate = item as {
      title?: unknown;
      whatToBuild?: unknown;
      expectedUser?: unknown;
      additionalContext?: unknown;
    };

    if (
      typeof candidate.title !== "string" ||
      typeof candidate.whatToBuild !== "string" ||
      typeof candidate.expectedUser !== "string" ||
      typeof candidate.additionalContext !== "string"
    ) {
      throw new Error("Each item must include title, whatToBuild, expectedUser, and additionalContext strings.");
    }

    const normalizedItem: BuildItem = {
      title: candidate.title.trim(),
      whatToBuild: candidate.whatToBuild.trim(),
      expectedUser: candidate.expectedUser.trim(),
      additionalContext: candidate.additionalContext.trim(),
    };

    if (!normalizedItem.title || !normalizedItem.whatToBuild || !normalizedItem.expectedUser || !normalizedItem.additionalContext) {
      throw new Error("All fields in each item must be non-empty.");
    }

    normalized.push(normalizedItem);
  }

  if (normalized.length === 0) {
    throw new Error("No valid pitches found in JSON list.");
  }

  return normalized;
}

async function respondToPermission(sessionId: string, decision: "approve" | "deny"): Promise<void> {
  const view = sessionViews.get(sessionId);
  if (!view || !view.pendingPermission) {
    return;
  }

  view.approveBtn.disabled = true;
  view.denyBtn.disabled = true;

  try {
    const response = await fetch(`/api/sessions/${sessionId}/permission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Unknown error" }));
      setSummary(view, `Permission error: ${payload.error ?? "Unable to send decision."}`);
    } else {
      clearPermission(view);
      setStatus(view, "Running", "running");
      setSummary(view, `Permission ${decision.toUpperCase()} sent. Continuing generation.`);
    }
  } catch (error) {
    setSummary(view, `Network error while sending permission: ${(error as Error).message}`);
  } finally {
    view.approveBtn.disabled = false;
    view.denyBtn.disabled = false;
  }
}

function createSessionCard(sessionId: string, titleText: string): SessionView {
  const card = document.createElement("section");
  card.className = "card session-card";

  const header = document.createElement("div");
  header.className = "terminal-header";
  const title = document.createElement("h2");
  title.textContent = titleText;
  const status = document.createElement("span");
  status.className = "status-badge";
  status.textContent = "Starting";
  header.append(title, status);

  const summaryText = document.createElement("p");
  summaryText.className = "summary-text";
  summaryText.textContent = "Agent starting up and preparing workspace.";

  const permissionPanel = document.createElement("div");
  permissionPanel.className = "permission-panel hidden";
  const permissionMessage = document.createElement("p");
  const actions = document.createElement("div");
  actions.className = "actions";
  const approveBtn = document.createElement("button");
  approveBtn.className = "approve";
  approveBtn.type = "button";
  approveBtn.textContent = "Approve";
  const denyBtn = document.createElement("button");
  denyBtn.className = "deny";
  denyBtn.type = "button";
  denyBtn.textContent = "Deny";
  actions.append(approveBtn, denyBtn);
  permissionPanel.append(permissionMessage, actions);

  const previewWrap = document.createElement("div");
  previewWrap.className = "preview-wrap";
  const previewTitle = document.createElement("h3");
  previewTitle.textContent = "Live Website Preview";
  const previewFrame = document.createElement("iframe");
  previewFrame.title = `Generated webpage preview for ${titleText}`;
  previewFrame.className = "preview-frame";
  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "expand-btn hidden";
  expandBtn.disabled = true;
  expandBtn.textContent = "Open Full Page";
  previewWrap.append(previewTitle, previewFrame, expandBtn);

  card.append(header, summaryText, permissionPanel, previewWrap);
  sessionsContainer.append(card);

  const view: SessionView = {
    stream: null,
    statusBadge: status,
    summaryText,
    permissionPanel,
    permissionMessage,
    approveBtn,
    denyBtn,
    previewFrame,
    expandBtn,
    pendingPermission: null,
    previewRefreshTimer: null,
    previewUrl: `/api/sessions/${sessionId}/preview/index.html`,
  };

  approveBtn.addEventListener("click", () => {
    void respondToPermission(sessionId, "approve");
  });
  denyBtn.addEventListener("click", () => {
    void respondToPermission(sessionId, "deny");
  });
  expandBtn.addEventListener("click", () => {
    window.open(view.previewUrl, "_blank", "noopener,noreferrer");
  });

  startPreviewRefresh(view);
  setStatus(view, "Starting", "running");
  return view;
}

function startStream(sessionId: string): void {
  const view = sessionViews.get(sessionId);
  if (!view) {
    return;
  }

  closeStream(view);
  view.stream = new EventSource(`/api/sessions/${sessionId}/stream`);

  view.stream.addEventListener("session", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      status: string;
      pendingPermission: PermissionRequest | null;
      previewUrl: string | null;
    };

    if (payload.previewUrl) {
      view.previewUrl = payload.previewUrl;
    }

    if (payload.pendingPermission) {
      showPermission(view, payload.pendingPermission);
    }

    if (payload.status === "running") {
      setStatus(view, "Running", "running");
      setSummary(view, "Agent is actively generating the website.");
    }
    if (payload.status === "completed") {
      setStatus(view, "Completed", "ok");
      setSummary(view, "Website generation completed.");
      stopPreviewRefresh(view);
      showExpandButton(view);
    }
  });

  view.stream.addEventListener("output", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { text: string };
    const summary = summarizeOutputChunk(payload.text);
    if (summary) {
      setSummary(view, summary);
    }
  });

  view.stream.addEventListener("permission_request", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as PermissionRequest;
    showPermission(view, payload);
  });

  view.stream.addEventListener("permission_result", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as { decision: string };
    clearPermission(view);
    setStatus(view, "Running", "running");
    setSummary(view, `Permission result received: ${payload.decision}.`);
  });

  view.stream.addEventListener("session_error", (event) => {
    if ((event as MessageEvent).data) {
      const payload = JSON.parse((event as MessageEvent).data) as { message: string };
      setSummary(view, `Error: ${payload.message}`);
      setStatus(view, "Error", "error");
      stopPreviewRefresh(view);
    }
  });

  view.stream.onerror = () => {
    setSummary(view, "Stream error: connection interrupted.");
    setStatus(view, "Error", "error");
    stopPreviewRefresh(view);
  };

  view.stream.addEventListener("done", (event) => {
    const payload = JSON.parse((event as MessageEvent).data) as {
      status: "completed" | "failed";
      previewUrl: string | null;
    };

    if (payload.previewUrl) {
      view.previewUrl = payload.previewUrl;
    }
    if (payload.status === "completed") {
      setStatus(view, "Completed", "ok");
      setSummary(view, "Website is deployed locally and ready in the preview window.");
      showExpandButton(view);
    } else {
      setStatus(view, "Failed", "error");
      setSummary(view, "Generation failed before completion.");
    }
    stopPreviewRefresh(view);
    closeStream(view);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = textarea.value.trim();
  if (!raw) {
    return;
  }

  submitBtn.disabled = true;
  sessionsContainer.textContent = "";
  for (const view of sessionViews.values()) {
    closeStream(view);
    stopPreviewRefresh(view);
  }
  sessionViews.clear();

  try {
    const pitches = parsePitchesJson(raw);
    const response = await fetch("/api/sessions/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: pitches }),
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: "Unknown error" }));
      throw new Error(payload.error ?? "Failed to start batch sessions.");
    }

    const data = (await response.json()) as BatchResponse;
    for (const session of data.sessions) {
      const view = createSessionCard(session.sessionId, session.title);
      sessionViews.set(session.sessionId, view);
      startStream(session.sessionId);
    }
  } catch (error) {
    const card = document.createElement("section");
    card.className = "card session-card";
    card.innerHTML = `<h2>Batch Error</h2><p class="summary-text">[error] ${(error as Error).message}</p>`;
    sessionsContainer.append(card);
  } finally {
    submitBtn.disabled = false;
  }
});
