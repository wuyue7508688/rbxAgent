import type { Context } from "@deepseek-ai/cordis";
import * as piAi from "@deepseek-ai/dsh-llm-pi-ai";

export const name = "rbxport-responses";
export const inject = ["llm"];

export function apply(ctx: Context) {
  const model = process.env.RBXPORT_AGENT_MODEL;
  const responses = {
    api: "openai-responses",
    transport: "sse",
    timeoutMs: 120_000,
    defaultMaxTokens: 8192,
    retryPolicy: { mode: "normal", maxRetries: 1 },
  } as const;

  ctx.plugin(piAi, {
    providers: {
      deepseek: {
        ...responses,
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: "https://api.deepseek.com",
        compat: { supportsDeveloperRole: false },
        models: [{ id: model || "deepseek-flash" }],
      },
      openai: {
        ...responses,
        apiKeyEnv: "OPENAI_API_KEY",
        baseURL: "https://api.openai.com/v1",
        models: [{ id: model || "gpt-5-mini" }],
      },
    },
  });
}
