export type AgentProvider = "deepseek" | "openai";

export interface AgentModel {
  provider: AgentProvider;
  model: string;
}

export interface AgentMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentChat extends AgentModel {
  id: string;
  updatedAt: number;
  messages: AgentMessage[];
}

export interface AgentHistory {
  provider: AgentProvider;
  models: Record<AgentProvider, string>;
  activeId: string | null;
  chats: AgentChat[];
}

const key = "rbl-library-agent";

const defaults: AgentHistory = {
  provider: "deepseek",
  models: { deepseek: "deepseek-flash", openai: "" },
  activeId: null,
  chats: [],
};

export function readAgentHistory(): AgentHistory {
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return defaults;
    const parsed = JSON.parse(saved) as Partial<AgentHistory> | null;
    if (parsed?.models && Array.isArray(parsed.chats)) return { ...defaults, ...parsed };
    return defaults;
  } catch {
    return defaults;
  }
}

export function saveAgentHistory(history: AgentHistory): void {
  try {
    localStorage.setItem(key, JSON.stringify(history));
  } catch {
    return;
  }
}

export function startAgentChat(model: AgentModel): AgentChat {
  return { ...model, id: crypto.randomUUID(), updatedAt: Date.now(), messages: [] };
}
