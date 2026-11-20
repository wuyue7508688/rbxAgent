import { tauriInvoke } from "@/ipc/invoke";
import type { AgentModel, AgentProvider } from "./history";
import type { AgentToolResult } from "./tools";

export interface AgentToolCall {
  requestId: string;
  tool: string;
  arguments: unknown;
}

export const inAgentDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const inAgentPreview = typeof __RBL_MOCK_BACKEND__ !== "undefined" && __RBL_MOCK_BACKEND__ && !inAgentDesktop;

export const agentDesktop = {
  configure: async (route: AgentModel, apiKey: string) =>
    (await tauriInvoke())<void>("agent_configure", { ...route, apiKey }),
  hasKey: async (provider: AgentProvider) => (await tauriInvoke())<boolean>("agent_has_key", { provider }),
  test: async (route: AgentModel) => (await tauriInvoke())<void>("agent_test", { ...route }),
  run: async (route: AgentModel, sessionId: string, text: string) =>
    (await tauriInvoke())<{ text: string }>("agent_run", { ...route, sessionId, text }),
  stop: async () => (await tauriInvoke())<void>("agent_stop"),
  delete: async (sessionId: string) => (await tauriInvoke())<void>("agent_delete_session", { sessionId }),
  listen: async (onTool: (request: AgentToolCall) => void) =>
    (await import("@tauri-apps/api/event")).listen<AgentToolCall>("agent:tool", ({ payload }) => onTool(payload)),
  result: async (requestId: string, result: AgentToolResult) =>
    (await tauriInvoke())<void>("agent_tool_result", { requestId, result }),
};
