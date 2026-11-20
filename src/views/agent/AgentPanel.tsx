import { AudioLines, Send } from "lucide-react";
import { memo, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArtworkDeleteIcon, GearIcon, HistoryIcon } from "@/components/icons";
import { errorMessage } from "@/lib/errorMessage";
import { useTranslation } from "@/i18n";
import { useEventCallback } from "@/store/useEventCallback";
import { agentDesktop, inAgentDesktop, inAgentPreview, type AgentToolCall } from "./desktop";
import { readAgentHistory, saveAgentHistory, startAgentChat, type AgentChat, type AgentModel, type AgentProvider } from "./history";
import { dispatchLibraryTool, type AgentToolUi } from "./tools";
import styles from "./AgentPanel.module.css";

const providerNames: Record<AgentProvider, string> = { deepseek: "DeepSeek", openai: "GPT (OpenAI)" };

function chatTitle(chat?: AgentChat): string | undefined {
  return chat?.messages[0]?.text.split(/\r?\n/, 1)[0]?.slice(0, 56);
}

async function previewAnswer(text: string, ui: AgentToolUi): Promise<string> {
  const bpm = text.match(/\b(\d+)\s*bpm\b/i)?.[1];
  if (/select|选中|選取/i.test(text)) {
    const context = await ui.getUiContext();
    return context.selection.tracks.map(({ title }) => title).join("\n") || "No tracks selected.";
  }
  const result = await dispatchLibraryTool("search_tracks", bpm ? { bpm: Number(bpm) } : { query: text }, ui);
  if (!result.ok) return result.error.message;
  const { total, tracks } = result.data as { total: number; tracks: { title: string; artist: string; bpm: number }[] };
  return [
    `${total} matching tracks`,
    ...tracks.map(({ title, artist, bpm }) => `${title} — ${artist} · ${bpm} BPM`),
  ].join("\n");
}

export const AgentPanel = memo(function AgentPanel({ ui }: { ui: AgentToolUi }) {
  const t = useTranslation();
  const [history, setHistory] = useState(readAgentHistory);
  const [screen, setScreen] = useState<"chat" | "history" | "settings">("chat");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [toolPhase, setToolPhase] = useState<"query" | "edit" | null>(null);
  const [feedback, setFeedback] = useState<{ chatId: string | null; text: string; error?: boolean }>();
  const [keyPresent, setKeyPresent] = useState<AgentProvider | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const listenerReady = useRef<Promise<() => void> | null>(null);
  const pendingKey = useRef<Promise<void>>(Promise.resolve());
  const activeTool = useRef<Promise<void>>(Promise.resolve());
  const stopRequest = useRef<Promise<void>>(Promise.resolve());
  const busy = useRef(false);
  const activeRun = useRef(false);
  const cancelled = useRef(false);
  const panelId = useId();
  const titleId = useId();
  const active = history.chats.find(({ id }) => id === history.activeId);
  const defaults: AgentModel = { provider: history.provider, model: history.models[history.provider].trim() };
  const model = active?.model;
  const messages = active?.messages;
  const visibleFeedback = feedback && (feedback.chatId === null || feedback.chatId === active?.id) ? feedback : undefined;

  useEffect(() => {
    saveAgentHistory(history);
  }, [history]);

  const dispatch = useEventCallback(async (request: AgentToolCall) => {
    if (!activeRun.current || cancelled.current) {
      await agentDesktop.result(request.requestId, { ok: false, error: { code: "cancelled", message: "The Agent is not running." } });
      return;
    }
    setToolPhase(["create_playlist", "add_tracks_to_playlist", "update_track_field"].includes(request.tool) ? "edit" : "query");
    try {
      const result = await dispatchLibraryTool(request.tool, request.arguments, ui);
      await agentDesktop.result(request.requestId, result);
    } finally {
      setToolPhase(null);
    }
  });

  useEffect(() => {
    if (!inAgentDesktop) return;
    let mounted = true;
    let removeListener: (() => void) | undefined;
    const listening = agentDesktop.listen((request) => {
      if (mounted) activeTool.current = dispatch(request).catch(() => {});
    });
    listenerReady.current = listening;
    void listening.then((remove) => {
      if (mounted) removeListener = remove;
      else remove();
    }, () => {});
    return () => {
      mounted = false;
      removeListener?.();
    };
  }, [dispatch]);

  useEffect(() => {
    if (open && screen === "chat" && transcript.current) transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages, open, screen]);

  useEffect(() => {
    if (!open || screen !== "settings" || !inAgentDesktop) return;
    let mounted = true;
    void pendingKey.current.catch(() => {}).then(() => agentDesktop.hasKey(history.provider)).then(
      (present) => { if (mounted) setKeyPresent(present ? history.provider : null); },
      (error) => { if (mounted) setFeedback({ chatId: null, text: errorMessage(error), error: true }); },
    );
    return () => { mounted = false; };
  }, [open, screen, history.provider]);

  function configureKey(): Promise<void> {
    const input = keyInput.current;
    const apiKey = input?.value.trim();
    if (!inAgentDesktop || !input || !apiKey) return pendingKey.current;
    if (!defaults.model) {
      setFeedback({ chatId: null, text: t("Enter a model ID."), error: true });
      return pendingKey.current;
    }
    input.value = "";
    const saving = pendingKey.current.catch(() => {}).then(() => agentDesktop.configure(defaults, apiKey));
    pendingKey.current = saving.catch(() => {});
    void saving.then(
      () => setKeyPresent(defaults.provider),
      (error) => setFeedback({ chatId: null, text: errorMessage(error), error: true }),
    );
    return saving;
  }

  async function showPanel() {
    dialog.current?.show();
    composer.current?.focus();
    setOpen(true);
    if (!inAgentDesktop) return;
    try {
      if (!active && screen === "chat" && !await agentDesktop.hasKey(defaults.provider) && dialog.current?.open) setScreen("settings");
    } catch (error) {
      setFeedback({ chatId: null, text: errorMessage(error), error: true });
    }
  }

  function newChat() {
    if (!defaults.model) {
      setScreen("settings");
      setFeedback({ chatId: null, text: t("Enter a model ID."), error: true });
      return;
    }
    const chat = startAgentChat(defaults);
    setHistory((current) => ({ ...current, activeId: chat.id, chats: [chat, ...current.chats] }));
    setDraft("");
    setScreen("chat");
  }

  async function deleteChat(chat: AgentChat) {
    if (busy.current) return;
    busy.current = true;
    try {
      if (inAgentDesktop) await agentDesktop.delete(chat.id);
      setHistory((current) => ({
        ...current,
        activeId: current.activeId === chat.id ? null : current.activeId,
        chats: current.chats.filter(({ id }) => id !== chat.id),
      }));
    } catch (error) {
      setFeedback({ chatId: null, text: errorMessage(error), error: true });
    } finally {
      busy.current = false;
    }
  }

  async function testConnection(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setRunning("test");
    setFeedback(undefined);
    try {
      await configureKey();
      if (inAgentDesktop) await agentDesktop.test(defaults);
      setFeedback({ chatId: null, text: t(inAgentDesktop ? "Connection successful." : "Open the desktop app to test the model connection.") });
    } catch (error) {
      setFeedback({ chatId: null, text: errorMessage(error), error: true });
    } finally {
      busy.current = false;
      setRunning(null);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy.current) return;
    const chat = active ?? startAgentChat(defaults);
    const route = { provider: chat.provider, model: chat.model };
    if (!route.model) {
      setScreen("settings");
      return;
    }
    busy.current = true;
    cancelled.current = false;
    setRunning(chat.id);
    setFeedback(undefined);
    let appended = false;
    try {
      await pendingKey.current;
      if (inAgentDesktop && !await agentDesktop.hasKey(route.provider)) {
        setScreen("settings");
        setFeedback({ chatId: null, text: t("Enter an API key to continue."), error: true });
        return;
      }
      if (inAgentDesktop) await listenerReady.current;
      if (cancelled.current) return;
      const underway: AgentChat = {
        ...chat, updatedAt: Date.now(), messages: [...chat.messages, { role: "user", text }],
      };
      setHistory((current) => ({
        ...current, activeId: current.activeId ?? chat.id,
        chats: [underway, ...current.chats.filter(({ id }) => id !== chat.id)],
      }));
      appended = true;
      setDraft((current) => current === draft ? "" : current);
      activeRun.current = true;
      const answer = inAgentPreview ? await previewAnswer(text, ui) : (await agentDesktop.run(route, chat.id, text)).text;
      if (cancelled.current) return;
      setHistory((current) => ({
        ...current,
        chats: current.chats.map((item) => item.id !== chat.id ? item : {
          ...item, updatedAt: Date.now(), messages: [...item.messages, { role: "assistant", text: answer }],
        }),
      }));
    } catch (error) {
      if (!cancelled.current) setFeedback({ chatId: appended ? chat.id : null, text: errorMessage(error), error: true });
    } finally {
      activeRun.current = false;
      await Promise.all([activeTool.current, stopRequest.current]);
      if (cancelled.current) setFeedback({ chatId: appended ? chat.id : null, text: t("Stopped.") });
      busy.current = false;
      cancelled.current = false;
      setRunning(null);
    }
  }

  function stop() {
    if (cancelled.current) return;
    cancelled.current = true;
    if (!inAgentDesktop) return;
    stopRequest.current = agentDesktop.stop().catch((error) => {
      cancelled.current = false;
      setFeedback({ chatId: null, text: errorMessage(error), error: true });
    });
  }

  return <>
    <button type="button" className={styles.launcher} aria-haspopup="dialog" aria-controls={panelId} aria-expanded={open}
      onClick={() => { if (dialog.current?.open) dialog.current.close(); else void showPanel(); }}>
      <AudioLines size={17} aria-hidden="true" />{t("Library Agent")}
    </button>
    <dialog id={panelId} aria-labelledby={titleId} className={styles.panel} ref={dialog}
      onClose={() => setOpen(dialog.current?.open ?? false)} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") dialog.current?.close();
      }}>
      <header className={styles.header}>
        <AudioLines size={19} className={styles.signal} aria-hidden="true" />
        <h2 id={titleId}>{t("Library Agent")}</h2>
        <button type="button" aria-label={t("Conversation history")} title={t("Conversation history")} aria-pressed={screen === "history"}
          onClick={() => setScreen(screen === "history" ? "chat" : "history")}><HistoryIcon width={17} height={17} /></button>
        <button type="button" aria-label={t("Model settings")} title={t("Model settings")} aria-pressed={screen === "settings"}
          onClick={() => setScreen(screen === "settings" ? "chat" : "settings")}><GearIcon width={16} height={16} /></button>
        <button type="button" aria-label={t("Minimize Agent")} title={t("Minimize Agent")}
          onClick={() => dialog.current?.close()}><span className={styles.symbol} aria-hidden="true">−</span></button>
      </header>
      {screen === "settings" ? (
        <form className={styles.settings} onSubmit={(event) => void testConnection(event)}>
          <h3>{t("Model settings")}</h3>
          <label htmlFor={`${panelId}-provider`}>{t("Default provider")}
            <select id={`${panelId}-provider`} value={history.provider} onChange={(event) => {
              const provider: AgentProvider = event.target.value === "openai" ? "openai" : "deepseek";
              setKeyPresent(null);
              setFeedback(undefined);
              setHistory((current) => ({ ...current, provider }));
            }}>
              <option value="deepseek">DeepSeek</option>
              <option value="openai">GPT (OpenAI)</option>
            </select>
          </label>
          <label htmlFor={`${panelId}-model`}>{t("Default model ID")}
            <input id={`${panelId}-model`} required value={history.models[history.provider]} autoComplete="off" spellCheck={false}
              onChange={(event) => {
                const value = event.target.value;
                setHistory((current) => ({ ...current, models: { ...current.models, [current.provider]: value } }));
              }} />
          </label>
          <label htmlFor={`${panelId}-key`}>{t("API key")}
            <input id={`${panelId}-key`} aria-describedby={`${panelId}-key-hint`} key={history.provider} ref={keyInput}
              type="password" autoComplete="off" spellCheck={false}
              disabled={!inAgentDesktop || !defaults.model} placeholder={keyPresent === history.provider ? t("Saved") : t("Enter an API key")}
              onBlur={() => { void configureKey().catch(() => {}); }} />
          </label>
          <p className={styles.hint} id={`${panelId}-key-hint`}>{t(inAgentDesktop ? "Your key saves automatically on this device." : "Browser preview uses the sample library.")}</p>
          <div className={styles.actions}>
            <button type="button" onClick={() => setScreen("chat")}>{t("Back to conversation")}</button>
            <button type="submit" className={styles.primary} disabled={running !== null || !defaults.model}>{t("Test connection")}</button>
          </div>
        </form>
      ) : screen === "history" ? (
        <section className={styles.history}>
          <div className={styles.historyHeading}>
            <h3>{t("Conversation history")}</h3>
            <button type="button" onClick={newChat}><span className={styles.symbol} aria-hidden="true">+</span>{t("New conversation")}</button>
          </div>
          {history.chats.length === 0 && <p className={styles.hint}>{t("No conversations yet.")}</p>}
          <ul>
            {[...history.chats].sort((a, b) => b.updatedAt - a.updatedAt).map((chat) => (
              <li key={chat.id} data-current={chat.id === active?.id ? "" : undefined}>
                <button type="button" className={styles.historyItem} aria-current={chat.id === active?.id ? "true" : undefined}
                  onClick={() => {
                    setHistory((current) => ({
                      ...current,
                      activeId: chat.id,
                      chats: current.chats.map((item) => item.id === chat.id ? { ...item, updatedAt: Date.now() } : item),
                    }));
                    setDraft("");
                    setScreen("chat");
                  }}>
                  <span data-i18n-ignore>{chatTitle(chat) ?? t("New conversation")}</span>
                  <small>{providerNames[chat.provider]} · <span data-i18n-ignore>{chat.model}</span></small>
                </button>
                <button type="button" disabled={running !== null} aria-label={t("Delete conversation")} title={t("Delete conversation")}
                  onClick={() => void deleteChat(chat)}><ArtworkDeleteIcon width={16} height={16} /></button>
              </li>
            ))}
          </ul>
        </section>
      ) : <>
        <div className={styles.threadBar}>
          <span className={styles.threadLabel} data-i18n-ignore>{chatTitle(active) ?? t("New conversation")}</span>
          {model && <span className={styles.model} data-i18n-ignore>{model}</span>}
          <button type="button" onClick={newChat} aria-label={t("New conversation")} title={t("New conversation")}><span className={styles.symbol} aria-hidden="true">+</span></button>
        </div>
        <div className={styles.transcript} ref={transcript} role="log" aria-label={t("Messages")} tabIndex={0}>
          {messages?.length ? messages.map(({ role, text }, index) => (
            <div className={styles.message} data-role={role} key={index}>
              <span>{t(role === "user" ? "You" : "Library Agent")}</span>
              <p data-i18n-ignore>{text}</p>
            </div>
          )) : <div className={styles.empty}>
            <AudioLines size={26} className={styles.signal} aria-hidden="true" />
            <p>{t("Ask about your collection.")}</p>
            <button type="button" onClick={() => { setDraft(t("Find tracks at 125 BPM")); composer.current?.focus(); }}>{t("Find tracks at 125 BPM")}</button>
          </div>}
        </div>
        <form className={styles.composer} onSubmit={(event) => void send(event)}>
          <textarea ref={composer} aria-label={t("Message")} placeholder={t("Ask about tracks and playlists…")} rows={2} autoFocus
            value={draft} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }} />
          {running && running !== "test" ? (
            <button type="button" onClick={stop} aria-label={t("Stop Agent")} title={t("Stop Agent")}><span className={styles.symbol} aria-hidden="true">▪</span></button>
          ) : (
            <button type="submit" className={styles.primary} disabled={running !== null || !draft.trim()} aria-label={t("Send message")} title={t("Send message")}><Send size={17} aria-hidden="true" /></button>
          )}
        </form>
      </>}
      <div className={styles.status} role={visibleFeedback?.error ? "alert" : "status"}>
        {running ? t(running === "test" ? "Testing connection…" : toolPhase === "query" ? "Reading the library…"
          : toolPhase === "edit" ? "Updating the library…" : "Agent is working…") : visibleFeedback?.text}
      </div>
    </dialog>
  </>;
});
