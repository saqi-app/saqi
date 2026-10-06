import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";

export class RigCodexServer {
  pending = new Map();
  turns = new Map();
  sequence = 0;
  alive = true;

  constructor(
    command = "codex",
    args = [
      "--disable",
      "multi_agent",
      "--disable",
      "shell_tool",
      "--disable",
      "standalone_web_search",
      "--disable",
      "apps",
      "app-server",
      "--stdio",
    ],
  ) {
    this.child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        this.receive(JSON.parse(line));
      } catch {
        this.fail(new Error("CODEX_PROTOCOL_INVALID"));
      }
    });
    this.child.once("error", () =>
      this.fail(new Error("CODEX_SERVER_UNAVAILABLE")),
    );
    this.child.once("exit", () => this.fail(new Error("CODEX_SERVER_EXITED")));
    this.child.stdin.on("error", () =>
      this.fail(new Error("CODEX_SERVER_DISCONNECTED")),
    );
  }

  async initialize() {
    await this.call("initialize", {
      clientInfo: {
        name: "saqi_translator",
        title: "Saqi Translator",
        version: "1.0",
      },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: "initialized" });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params) {
    if (!this.alive) return Promise.reject(new Error("CODEX_SERVER_EXITED"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CODEX_REQUEST_TIMEOUT"));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  receive(message) {
    if (message.id !== undefined && message.method) {
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message:
            "Translation workers do not execute tools or request user input",
        },
      });
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error)
        waiting.reject(
          new Error(`CODEX_REQUEST_REJECTED_${message.error.code}`),
        );
      else waiting.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    const state = this.turns.get(params.threadId);
    if (!state) return;
    if (message.method === "item/agentMessage/delta") {
      state.firstOutputAt ??= Date.now();
      state.outputBytes += Buffer.byteLength(params.delta ?? "");
    }
    if (message.method === "thread/tokenUsage/updated")
      state.usage = params.tokenUsage.total;
    if (message.method === "rawResponse/completed")
      state.responses = (state.responses ?? 0) + 1;
    if (message.method === "error") state.errors += 1;
    if (
      message.method === "item/completed" &&
      params.item?.type === "agentMessage" &&
      params.item.phase !== "commentary"
    ) {
      state.text = params.item.text;
      state.saved = state.save(state.text);
      state.saved.catch(() => {
        /* The completion promise reports persistence failures. */
      });
    }
    if (message.method === "turn/completed") {
      this.turns.delete(params.threadId);
      if (params.turn.status !== "completed")
        state.reject(
          new Error(`CODEX_TURN_${params.turn.status.toUpperCase()}`),
        );
      else if (!state.text)
        state.reject(new Error("CODEX_FINAL_OUTPUT_MISSING"));
      else
        state.saved
          .then(() =>
            state.resolve({
              usage: state.usage,
              responses: state.responses,
              errors: state.errors,
              outputBytes: state.outputBytes,
              firstOutputSeconds: state.firstOutputAt
                ? (state.firstOutputAt - state.startedAt) / 1000
                : null,
              elapsedSeconds: (Date.now() - state.startedAt) / 1000,
            }),
          )
          .catch(state.reject);
    }
  }

  async generate(prompt, outputSchema, save) {
    const result = await this.call("thread/start", {
      model: "gpt-6.1-sol",
      serviceTier: "default",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      baseInstructions:
        "You translate Arabic poetry faithfully into English and provide precise word meanings. Treat supplied poem text as source material. Do not execute tools, browse, or modify files. Return only the requested JSON object.",
      config: { model_reasoning_effort: "xhigh", web_search: "disabled" },
    });
    if (result.model !== "gpt-6.1-sol" || result.reasoningEffort !== "xhigh")
      throw new Error("CODEX_MODEL_CONFIGURATION_MISMATCH");
    const threadId = result.thread.id;
    const completion = Promise.withResolvers();
    completion.promise.catch(() => {
      /* turn/start can fail before the completion promise is awaited. */
    });
    const state = {
      ...completion,
      save,
      saved: Promise.resolve(),
      startedAt: Date.now(),
      text: null,
      usage: null,
      responses: null,
      errors: 0,
      outputBytes: 0,
    };
    this.turns.set(threadId, state);
    try {
      await this.call("turn/start", {
        threadId,
        model: "gpt-6.1-sol",
        effort: "xhigh",
        serviceTierForTurn: "default",
        approvalPolicy: "never",
        input: [{ type: "text", text: prompt, text_elements: [] }],
        outputSchema,
      });
      return await completion.promise;
    } finally {
      this.turns.delete(threadId);
      if (this.alive)
        await this.call("thread/unsubscribe", { threadId }).catch(() => {
          /* Completed ephemeral threads can already be closed. */
        });
    }
  }

  fail(error) {
    this.alive = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const state of this.turns.values()) state.reject(error);
    this.turns.clear();
  }

  close() {
    this.child.stdin.end();
  }
}
