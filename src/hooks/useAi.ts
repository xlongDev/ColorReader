import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, isDesktopRuntime, onAiStream } from "@/lib/ipc";
import type { AiConfig, AiMessage, RagHit } from "@/types/ipc";

/** Browser dev mode has no backend; the settings form still needs a shape. */
const OFFLINE_CONFIG: AiConfig = {
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  systemPrompt: "",
  embeddingModel: "",
  rerankModel: "",
};

/** Persisted AI config. `staleTime: Infinity` — it only changes through this app. */
export function useAiConfig() {
  return useQuery<AiConfig>({
    queryKey: ["ai", "config"],
    queryFn: () => (isDesktopRuntime ? ipc.aiGetConfig() : Promise.resolve(OFFLINE_CONFIG)),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Saves the config; the query is refreshed so the form shows what is stored. */
export function useSaveAiConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: AiConfig) => ipc.aiSetConfig(config),
    onSettled: (saved) => {
      queryClient.setQueryData(["ai", "config"], saved);
    },
  });
}

/** Proves endpoint, key and model work together. Does not persist anything. */
export function useTestAiConfig() {
  return useMutation({ mutationFn: (config: AiConfig) => ipc.aiTest(config) });
}

interface ChatState {
  /** Answer accumulated so far. */
  text: string;
  streaming: boolean;
  error: string | null;
  /** RAG sources, set on the final event of a retrieval-backed answer. */
  citations: RagHit[];
}

const IDLE: ChatState = { text: "", streaming: false, error: null, citations: [] };

/** One question and its streamed answer. A new send replaces the old exchange:
 * a reading assistant answers one thing at a time, and history belongs to the
 * annotations phase, not here.
 */
export function useAiChat() {
  const [state, setState] = useState<ChatState>(IDLE);
  // Read inside the event listener, written inside callbacks — never during
  // render — so a late stream from an abandoned request is dropped, not shown.
  const activeRequest = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onAiStream((delta) => {
      if (delta.requestId !== activeRequest.current) return;
      if (delta.error) {
        setState({ text: "", streaming: false, error: delta.error, citations: [] });
        return;
      }
      setState((prev) => ({
        text: delta.text === null ? prev.text : prev.text + delta.text,
        streaming: !delta.done,
        error: null,
        citations: delta.citations ?? prev.citations,
      }));
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  }, []);

  const start = useCallback((run: (requestId: string) => Promise<void>) => {
    const requestId = crypto.randomUUID();
    activeRequest.current = requestId;
    setState({ text: "", streaming: true, error: null, citations: [] });
    run(requestId).catch((err: unknown) => {
      if (activeRequest.current !== requestId) return;
      setState({ text: "", streaming: false, error: String(err), citations: [] });
    });
  }, []);

  const send = useCallback(
    (messages: AiMessage[]) => start((requestId) => ipc.aiChat(requestId, messages)),
    [start],
  );

  /** Retrieval-backed variant; citations arrive on the final stream event. */
  const askRag = useCallback(
    (question: string, bookId: string | null) =>
      start((requestId) => ipc.ragChat(requestId, question, bookId)),
    [start],
  );

  const reset = useCallback(() => {
    activeRequest.current = null;
    setState(IDLE);
  }, []);

  return { ...state, send, askRag, reset };
}
