import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { redactSecrets, type AuthSnapshot, type ModelCapability } from "./contracts.ts";

export type RpcId = string | number;
export type RpcRequest = { id: RpcId; method: string; params?: unknown };
export type RpcNotification = { method: string; params?: unknown };
export type RpcResponse = { id: RpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export class RpcTimeoutError extends Error {
  readonly requestId: RpcId;
  constructor(requestId: RpcId, method: string) {
    super("App Server request timed out: " + method + " (" + String(requestId) + ")");
    this.name = "RpcTimeoutError";
    this.requestId = requestId;
  }
}

export class RpcClosedError extends Error {
  constructor(message = "App Server transport closed") {
    super(message);
    this.name = "RpcClosedError";
  }
}

type Pending = {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
};

export type RpcOptions = {
  maxLineBytes?: number;
  requestTimeoutMs?: number;
  onServerRequest?: (message: RpcRequest) => Promise<unknown>;
};

export class JsonLineRpc extends EventEmitter {
  private readonly pending = new Map<string, Pending>();
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly notifications: Array<{ method: string; params: unknown }> = [];
  private readonly waiters = new Map<string, Array<(params: unknown) => void>>();

  constructor(
    private readonly stdout: NodeJS.ReadableStream,
    private readonly stdin: NodeJS.WritableStream,
    private readonly options: RpcOptions = {},
  ) {
    super();
    this.maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    stdout.on("data", (chunk: Buffer | string) => this.onChunk(chunk));
    stdout.on("end", () => this.close(new RpcClosedError("App Server stdout ended")));
    stdout.on("error", (error) => this.close(error instanceof Error ? error : new Error(String(error))));
    stdin.on("error", (error) => this.close(error instanceof Error ? error : new Error(String(error))));
  }

  private onChunk(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes * 2) {
      this.close(new Error("App Server JSONL buffer exceeded the limit"));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.close(new Error("App Server JSONL message exceeded the limit"));
        return;
      }
      try {
        this.onMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        this.emit("protocolError", error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private onMessage(message: RpcMessage): void {
    if (!message || typeof message !== "object") return;
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) {
        this.emit("protocolError", new Error("response carried an unknown request id"));
        return;
      }
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if ("error" in message && message.error) {
        pending.reject(new Error("App Server " + pending.method + ": " + message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message as RpcRequest);
      return;
    }
    if ("method" in message) {
      const notification = message as RpcNotification;
      const params = notification.params;
      this.notifications.push({ method: notification.method, params });
      const waiters = this.waiters.get(notification.method) ?? [];
      this.waiters.delete(notification.method);
      for (const waiter of waiters) waiter(params);
      this.emit("notification", notification.method, params);
    }
  }

  private async handleServerRequest(message: RpcRequest): Promise<void> {
    try {
      const result = this.options.onServerRequest
        ? await this.options.onServerRequest(message)
        : await defaultServerRequest(message);
      await this.write({ id: message.id, result });
    } catch (error) {
      await this.write({
        id: message.id,
        error: {
          code: -32601,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async write(message: RpcMessage): Promise<void> {
    if (this.closed) throw new RpcClosedError();
    const line = JSON.stringify(message) + "\n";
    const ok = this.stdin.write(line);
    if (!ok) await once(this.stdin, "drain");
  }

  async request(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    if (this.closed) throw new RpcClosedError();
    const id = String(this.nextId++);
    const result = new Promise<unknown>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(id, method));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveResult, reject, timer });
    });
    try {
      await this.write({ id, method, ...(params === undefined ? {} : { params }) });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return result;
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean = () => true,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const found = this.notifications.find((item) => item.method === method && predicate(item.params));
    if (found) return found.params;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        const pending = this.waiters.get(method) ?? [];
        this.waiters.set(method, pending.filter((waiter) => waiter !== resolveResult));
        reject(new Error("notification timed out: " + method));
      }, timeoutMs);
      const waiter = (params: unknown) => {
        if (predicate(params)) {
          clearTimeout(timer);
          resolveResult(params);
        } else {
          const current = this.waiters.get(method) ?? [];
          this.waiters.set(method, [...current, waiter]);
        }
      };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), waiter]);
    });
  }

  close(error = new RpcClosedError()): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("closed", error);
  }
}

const defaultServerRequest = async (message: RpcRequest): Promise<unknown> => {
  if (message.method === "item/commandExecution/requestApproval") return { decision: "decline" };
  if (message.method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (message.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn", strictAutoReview: null };
  }
  throw new Error("unsupported App Server request type: " + message.method);
};

export type ResolvedExecutable = {
  path: string;
  args: string[];
  source: "absolute" | "path";
  native: boolean;
};

const isShim = (path: string): boolean => [".cmd", ".bat", ".ps1"].includes(extname(path).toLowerCase());

export const resolveExecutable = (
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedExecutable | null => {
  if (!command.trim()) return null;
  const windows = process.platform === "win32";
  const direct = isAbsolute(command) || command.includes("/") || command.includes("\\");
  const directories = direct ? [""] : (env.PATH ?? "").split(windows ? ";" : ":");
  const extensions = windows
    ? [".exe", ".com"]
    : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = direct ? command : join(directory, command + extension);
      if (!existsSync(candidate)) continue;
      if (isShim(candidate)) continue;
      return {
        path: resolve(candidate),
        args: [],
        source: direct ? "absolute" : "path",
        native: !isShim(candidate),
      };
    }
  }
  return null;
};

export const environmentKind = (): "native-windows" | "wsl" | "unix" => {
  if (process.platform === "win32") return "native-windows";
  if (process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) return "wsl";
  return "unix";
};

export const sanitizedChildEnvironment = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      /(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION)/i.test(key) &&
      !["CODEX_HOME", "LOCALAPPDATA", "APPDATA"].includes(key)
    ) {
      continue;
    }
    output[key] = value;
  }
  return output;
};

export const runExecutable = async (
  executable: ResolvedExecutable,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  const child = spawn(executable.path, [...executable.args, ...args], {
    cwd: options.cwd,
    env: sanitizedChildEnvironment(options.env),
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  let timer: NodeJS.Timeout | undefined;
  const exit = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", resolveExit);
  });
  if (options.timeoutMs) timer = setTimeout(() => child.kill(), options.timeoutMs);
  try {
    return { code: await exit, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const protocolFile = join(dirname(fileURLToPath(import.meta.url)), "..", "protocol", "codex-app-server.v2.schemas.json");
let protocolText: string | null = null;
export const protocolSchemaAvailable = (): boolean => existsSync(protocolFile);
export const protocolContainsMethod = (method: string): boolean => {
  if (!protocolSchemaAvailable()) return false;
  protocolText ??= readFileSync(protocolFile, "utf8");
  return protocolText.includes('"' + method + '"');
};

export const assertInstalledProtocol = (methods: string[]): void => {
  const missing = methods.filter((method) => !protocolContainsMethod(method));
  if (missing.length > 0) throw new Error("installed protocol snapshot lacks: " + missing.join(", "));
};

export type AdapterOptions = {
  executable: ResolvedExecutable;
  cwd: string;
  protocolVersion?: string;
  requestTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  allowLive?: boolean;
};

export type WorkerRunResult = {
  threadId: string;
  turnId: string;
  actualModelId: string | null;
  actualEffort: string | null;
  status: string;
  messages: string[];
  rawCompletion: unknown;
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value ? value : null;

const authFromAccount = (response: unknown, observedAt = new Date().toISOString()): AuthSnapshot => {
  const value = object(response);
  const account = object(value.account);
  const provider = account.type === "chatgpt" ? "chatgpt" : account.type === "apiKey" ? "api" : "unknown";
  return {
    provider,
    authenticated: Boolean(account.type),
    managedLogin: provider === "chatgpt",
    accountId: null,
    planType: stringValue(account.planType),
    requiresOpenaiAuth: typeof value.requiresOpenaiAuth === "boolean" ? value.requiresOpenaiAuth : null,
    observedAt,
  };
};

export class CodexAppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: JsonLineRpc;
  private activeThreadId: string | null = null;
  private activeTurnId: string | null = null;
  private readonly stderr: string[] = [];

  private constructor(child: ChildProcessWithoutNullStreams, options: AdapterOptions) {
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.stderr.push(redactSecrets(String(chunk)).text.slice(0, 2000));
      if (this.stderr.length > 20) this.stderr.shift();
    });
    this.rpc = new JsonLineRpc(child.stdout, child.stdin, {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    child.once("close", () => this.rpc.close(new RpcClosedError("owned App Server exited")));
  }

  static start(options: AdapterOptions): CodexAppServer {
    assertInstalledProtocol([
      "initialize",
      "thread/start",
      "turn/start",
      "turn/interrupt",
      "model/list",
      "account/read",
      "account/rateLimits/read",
      "command/exec",
    ]);
    const child = spawn(options.executable.path, [...options.executable.args, "app-server", "--stdio"], {
      cwd: options.cwd,
      env: sanitizedChildEnvironment(options.env),
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServer(child, options);
  }

  diagnostics(): { stderr: string[]; pid: number | undefined; alive: boolean } {
    return { stderr: [...this.stderr], pid: this.child.pid, alive: !this.child.killed && this.child.exitCode === null };
  }

  async initialize(): Promise<unknown> {
    const response = await this.rpc.request("initialize", {
      clientInfo: {
        name: "codex-quota-orchestrator",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: false,
      },
    });
    await this.rpc.notify("initialized");
    return response;
  }

  async account(): Promise<{ raw: unknown; auth: AuthSnapshot }> {
    const raw = await this.rpc.request("account/read", { refreshToken: false });
    return { raw, auth: authFromAccount(raw) };
  }

  async models(): Promise<ModelCapability[]> {
    const models: ModelCapability[] = [];
    let cursor: string | null = null;
    for (;;) {
      const raw = object(await this.rpc.request("model/list", { cursor, limit: 100, includeHidden: false }));
      const data = Array.isArray(raw.data) ? raw.data : [];
      for (const item of data) {
        const value = object(item);
        const id = stringValue(value.id) ?? stringValue(value.model);
        if (!id) continue;
        const efforts = Array.isArray(value.supportedReasoningEfforts)
          ? value.supportedReasoningEfforts
              .map((effort) => object(effort).reasoningEffort)
              .filter((effort): effort is string => typeof effort === "string")
          : [];
        models.push({
          id,
          model: stringValue(value.model) ?? undefined,
          isDefault: value.isDefault === true,
          supportedReasoningEfforts: efforts,
          inputModalities: Array.isArray(value.inputModalities)
            ? value.inputModalities.filter((item): item is string => typeof item === "string")
            : undefined,
          serviceTiers: Array.isArray(value.serviceTiers)
            ? value.serviceTiers
                .map((tier) => object(tier).id)
                .filter((tier): tier is string => typeof tier === "string")
            : undefined,
          defaultReasoningEffort: stringValue(value.defaultReasoningEffort) ?? undefined,
        });
      }
      cursor = stringValue(raw.nextCursor);
      if (!cursor) break;
    }
    return models;
  }

  async rateLimits(): Promise<unknown> {
    return this.rpc.request("account/rateLimits/read", {});
  }

  async startThread(modelId: string, cwd: string): Promise<{ raw: unknown; threadId: string; actualModelId: string | null }> {
    const raw = await this.rpc.request("thread/start", {
      model: modelId,
      cwd,
      ephemeral: true,
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      allowProviderModelFallback: false,
      serviceTier: "default",
    });
    const value = object(raw);
    const thread = object(value.thread);
    const threadId = stringValue(thread.id);
    if (!threadId) throw new Error("thread/start returned no thread id");
    return {
      raw,
      threadId,
      actualModelId: stringValue(value.model),
    };
  }

  async runTurn(
    modelId: string,
    effort: string | null,
    cwd: string,
    prompt: string,
  ): Promise<WorkerRunResult> {
    const started = await this.startThread(modelId, cwd);
    this.activeThreadId = started.threadId;
    const rawStart = object(
      await this.rpc.request("turn/start", {
        threadId: started.threadId,
        input: [{ type: "text", text: prompt }],
        model: modelId,
        effort,
        cwd,
        serviceTierForTurn: "default",
      }),
    );
    const turn = object(rawStart.turn);
    const turnId = stringValue(turn.id);
    if (!turnId) throw new Error("turn/start returned no turn id");
    this.activeTurnId = turnId;
    const messages: string[] = [];
    const onNotification = (method: string, params: unknown) => {
      const value = object(params);
      if (method === "item/agentMessage/delta" && typeof value.delta === "string") {
        messages.push(value.delta);
      }
    };
    this.rpc.on("notification", onNotification);
    try {
      const completion = await this.rpc.waitForNotification(
        "turn/completed",
        (params) => {
          const value = object(params);
          return value.threadId === started.threadId && value.turnId === turnId;
        },
      );
      const completed = object(completion);
      const completedTurn = object(completed.turn);
      return {
        threadId: started.threadId,
        turnId,
        actualModelId: stringValue(completedTurn.model) ?? started.actualModelId,
        actualEffort: stringValue(completedTurn.reasoningEffort) ?? effort,
        status: stringValue(completedTurn.status) ?? "unknown",
        messages,
        rawCompletion: completion,
      };
    } finally {
      this.rpc.off("notification", onNotification);
      this.activeThreadId = null;
      this.activeTurnId = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.activeThreadId || !this.activeTurnId) return;
    await this.rpc.request("turn/interrupt", {
      threadId: this.activeThreadId,
      turnId: this.activeTurnId,
    });
  }

  async runSandboxedCommand(
    command: string[],
    cwd: string,
    timeoutMs: number,
    writableRoots: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (command.length === 0) throw new Error("verification command cannot be empty");
    const raw = object(
      await this.rpc.request("command/exec", {
        command,
        cwd,
        timeoutMs,
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots,
          networkAccess: false,
        },
      }),
    );
    return {
      exitCode: typeof raw.exitCode === "number" ? raw.exitCode : -1,
      stdout: typeof raw.stdout === "string" ? raw.stdout : "",
      stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    };
  }

  async close(): Promise<void> {
    this.rpc.close();
    if (!this.child.killed && this.child.exitCode === null) {
      this.child.kill();
      await once(this.child, "close").catch(() => undefined);
    }
  }
}
