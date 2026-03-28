import express from "express";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "../public");
const tmpRoot = path.join(process.cwd(), "tmp");

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

const PORT = Number(process.env.PORT ?? 3000);
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_ARGS = process.env.CODEX_ARGS ? process.env.CODEX_ARGS.split(" ").filter(Boolean) : [];
const CODEX_ISOLATE_HOME = process.env.CODEX_ISOLATE_HOME === "true";

type SessionStatus = "running" | "completed" | "failed";
type PermissionDecision = "approve" | "deny";

interface PermissionRequest {
  id: string;
  message: string;
}

interface SessionStartPayload {
  sessionId: string;
  title: string;
}

interface BuildSpec {
  title: string;
  whatToBuild: string;
  expectedUser: string;
  additionalContext: string;
}

interface Session {
  id: string;
  buildSpec: BuildSpec;
  runDirectory: string;
  process: ChildProcessWithoutNullStreams;
  events: EventEmitter;
  status: SessionStatus;
  pendingPermission: PermissionRequest | null;
  outputBuffer: Array<{ source: "stdout" | "stderr"; text: string }>;
}

const sessions = new Map<string, Session>();

const PERMISSION_LINE_PATTERNS: RegExp[] = [
  /\b(approve|allow|permission|grant access)\b.*\[(?:y|Y)\/(?:n|N)\]/,
  /\bDo you want to continue\?/i,
  /\bNeed approval\b/i,
];

function createCodexPrompt(buildSpec: BuildSpec): string {
  return [
    "Create a frontend-only prototype webpage based on this elevator pitch.",
    "Requirements:",
    "- Build only static frontend assets (HTML/CSS/JS).",
    "- No backend code.",
    "- Keep the prototype self-contained and visually polished.",
    "- At the end, summarize which files were created.",
    "",
    `Project title: ${buildSpec.title}`,
    `What to build: ${buildSpec.whatToBuild}`,
    `Expected user: ${buildSpec.expectedUser}`,
    `Additional context: ${buildSpec.additionalContext}`,
  ].join("\n");
}

function emitEvent(session: Session, event: string, payload: unknown): void {
  session.events.emit("event", { event, payload });
}

function shouldTreatAsPermissionPrompt(line: string): boolean {
  return PERMISSION_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function startSession(buildSpec: BuildSpec): Session {
  const id = randomUUID();
  const runDirectory = path.join(tmpRoot, id);
  mkdirSync(runDirectory, { recursive: true });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OTEL_SDK_DISABLED: "true",
  };

  if (CODEX_ISOLATE_HOME) {
    const codexHome = path.join(runDirectory, ".codex");
    mkdirSync(codexHome, { recursive: true });
    childEnv.CODEX_HOME = codexHome;
  }

  const child = spawn(
    CODEX_BIN,
    [...CODEX_ARGS, "exec", "--skip-git-repo-check", "-s", "workspace-write", "-"],
    {
      cwd: runDirectory,
      env: childEnv,
      stdio: "pipe",
    },
  );

  const session: Session = {
    id,
    buildSpec,
    runDirectory,
    process: child,
    events: new EventEmitter(),
    status: "running",
    pendingPermission: null,
    outputBuffer: [],
  };

  const handleChunk = (source: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString();
    session.outputBuffer.push({ source, text });
    emitEvent(session, "output", { source, text });

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      if (!session.pendingPermission && shouldTreatAsPermissionPrompt(line)) {
        const request: PermissionRequest = {
          id: randomUUID(),
          message: line.trim(),
        };
        session.pendingPermission = request;
        emitEvent(session, "permission_request", request);
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => handleChunk("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => handleChunk("stderr", chunk));

  child.on("close", (code, signal) => {
    session.status = code === 0 ? "completed" : "failed";
    emitEvent(session, "done", {
      code,
      signal,
      status: session.status,
      previewUrl: session.status === "completed" ? `/api/sessions/${session.id}/preview/index.html` : null,
    });
  });

  child.on("error", (error) => {
    session.status = "failed";
    emitEvent(session, "session_error", {
      message: error.message,
    });
  });

  child.stdin.write(`${createCodexPrompt(buildSpec)}\n`);
  child.stdin.end();

  sessions.set(id, session);
  return session;
}

function sendPreviewFile(res: express.Response, session: Session, requestedPath: string): void {
  const safeRelativePath = requestedPath.trim() || "index.html";
  const absolutePath = path.resolve(session.runDirectory, safeRelativePath);

  if (!absolutePath.startsWith(session.runDirectory + path.sep)) {
    res.status(400).json({ error: "Invalid preview path." });
    return;
  }

  res.sendFile(absolutePath, (error?: NodeJS.ErrnoException & { statusCode?: number }) => {
    if (error) {
      if (!res.headersSent) {
        if (safeRelativePath.endsWith(".html")) {
          res.status(200).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1.0" />
    <title>Preview Pending</title>
    <style>
      body { margin: 0; font-family: sans-serif; background: #0b1220; color: #e6eeff; display: grid; place-items: center; min-height: 100vh; }
      .box { text-align: center; padding: 1rem; max-width: 420px; }
      .muted { opacity: 0.7; font-size: 0.92rem; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>Preparing preview...</h1>
      <p class="muted">The agent is still generating files. This window will update automatically.</p>
    </div>
  </body>
</html>`);
          return;
        }

        res.status(error?.statusCode ?? 404).json({ error: "Preview file not found." });
      }
    }
  });
}

function cleanupTmpRoot(): void {
  if (!existsSync(tmpRoot)) {
    return;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

function normalizeBuildSpecInput(input: unknown): BuildSpec | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const candidate = input as {
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
    return null;
  }

  const title = candidate.title.trim();
  const whatToBuild = candidate.whatToBuild.trim();
  const expectedUser = candidate.expectedUser.trim();
  const additionalContext = candidate.additionalContext.trim();

  if (!title || !whatToBuild || !expectedUser || !additionalContext) {
    return null;
  }

  return { title, whatToBuild, expectedUser, additionalContext };
}

app.post("/api/sessions", (req, res) => {
  const buildSpec = normalizeBuildSpecInput(req.body?.item);
  if (!buildSpec) {
    res.status(400).json({
      error: "Body must include 'item' with title, whatToBuild, expectedUser, and additionalContext.",
    });
    return;
  }

  try {
    const session = startSession(buildSpec);
    const payload: SessionStartPayload = { sessionId: session.id, title: session.buildSpec.title };
    res.status(201).json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Codex.";
    res.status(500).json({ error: message });
  }
});

app.post("/api/sessions/batch", (req, res) => {
  const itemsInput = req.body?.items;
  if (!Array.isArray(itemsInput) || itemsInput.length === 0) {
    res.status(400).json({ error: "Body must include a non-empty 'items' array." });
    return;
  }

  const normalizedSpecs: BuildSpec[] = [];
  for (const item of itemsInput) {
    const buildSpec = normalizeBuildSpecInput(item);
    if (!buildSpec) {
      res.status(400).json({
        error: "Each item must include non-empty title, whatToBuild, expectedUser, and additionalContext fields.",
      });
      return;
    }
    normalizedSpecs.push(buildSpec);
  }

  try {
    const sessionsPayload: SessionStartPayload[] = normalizedSpecs.map((buildSpec) => {
      const session = startSession(buildSpec);
      return { sessionId: session.id, title: session.buildSpec.title };
    });
    res.status(201).json({ sessions: sessionsPayload });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start Codex sessions.";
    res.status(500).json({ error: message });
  }
});

app.get("/api/sessions/:id/stream", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const writeEvent = (event: string, payload: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  writeEvent("session", {
    sessionId: session.id,
    status: session.status,
    pendingPermission: session.pendingPermission,
    previewUrl: session.status === "completed" ? `/api/sessions/${session.id}/preview/index.html` : null,
  });

  if (session.outputBuffer.length > 0) {
    for (const chunk of session.outputBuffer) {
      writeEvent("output", {
        source: chunk.source,
        text: chunk.text,
      });
    }
  }

  const eventHandler = ({ event, payload }: { event: string; payload: unknown }): void => {
    writeEvent(event, payload);
  };

  session.events.on("event", eventHandler);

  req.on("close", () => {
    session.events.off("event", eventHandler);
  });
});

app.post("/api/sessions/:id/permission", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  if (!session.pendingPermission) {
    res.status(409).json({ error: "No pending permission request." });
    return;
  }

  const decision = req.body?.decision as PermissionDecision | undefined;
  if (decision !== "approve" && decision !== "deny") {
    res.status(400).json({ error: "Decision must be 'approve' or 'deny'." });
    return;
  }

  const pending = session.pendingPermission;
  session.pendingPermission = null;

  session.process.stdin.write(decision === "approve" ? "y\n" : "n\n");
  emitEvent(session, "permission_result", {
    requestId: pending.id,
    decision,
  });

  res.status(200).json({ ok: true });
});

app.get("/api/sessions/:id/preview", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  sendPreviewFile(res, session, "index.html");
});

app.get("/api/sessions/:id/preview/*", (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found." });
    return;
  }

  const wildcardPath = (req.params as Record<string, string | undefined>)["0"];
  const requestedPath = typeof wildcardPath === "string" ? wildcardPath : "";
  sendPreviewFile(res, session, requestedPath);
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

process.once("SIGINT", () => {
  cleanupTmpRoot();
  process.exit(0);
});

process.once("SIGTERM", () => {
  cleanupTmpRoot();
  process.exit(0);
});

process.once("exit", () => {
  cleanupTmpRoot();
});

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
