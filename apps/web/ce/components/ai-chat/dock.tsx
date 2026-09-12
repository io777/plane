/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useSWRConfig } from "swr";
import { Plus, Sparkles, X } from "lucide-react";
// plane imports
import { cn } from "@plane/utils";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
import useKeypress from "@/hooks/use-keypress";
import { useAIChat } from "@/plane-web/hooks/store";
// local imports
import { AIChatComposer } from "./composer";
import { AIChatMessageList } from "./message-list";
import { AIChatThreadList } from "./thread-list";

export const AIChatDock = observer(function AIChatDock() {
  // router
  const params = useParams();
  const workspaceSlug = params?.workspaceSlug?.toString() ?? "";
  // store hooks
  const { getWorkspaceBySlug } = useWorkspace();
  const aiChatStore = useAIChat();
  // derived values
  const workspaceId = getWorkspaceBySlug(workspaceSlug)?.id ?? "";
  const { isOpen, mutationNonce } = aiChatStore;
  const { mutate } = useSWRConfig();

  // When the agent mutates workspace data, revalidate work-item SWR caches in
  // place — pages refetch without a full reload and the chat stays open.
  // Deliberately narrow: a blanket revalidation also refetches fragile keys
  // (e.g. INSTANCE_INFORMATION), whose failure renders the maintenance screen.
  useEffect(() => {
    if (mutationNonce > 0) {
      void mutate(
        (key) => typeof key === "string" && /ISSUE|PROJECT/.test(key),
        undefined,
        { revalidate: true },
      );
    }
  }, [mutationNonce, mutate]);

  // restore the persisted panel state only after mount (SSR-safe)
  useEffect(() => {
    aiChatStore.hydrateFromStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // close the panel on Escape
  useKeypress("Escape", () => {
    if (isOpen) aiChatStore.setOpen(false);
  });

  // fetch the thread list whenever the panel is opened
  useEffect(() => {
    if (isOpen && workspaceSlug) aiChatStore.fetchThreads(workspaceSlug);
  }, [aiChatStore, isOpen, workspaceSlug]);

  if (!workspaceSlug) return null;

  return createPortal(
    <>
      {/* floating open button */}
      {!isOpen && (
        <button
          type="button"
          aria-label="Open AI Assistant"
          onClick={() => aiChatStore.setOpen(true)}
          className="fixed bottom-6 right-6 z-[25] grid size-11 place-items-center rounded-full border border-subtle bg-surface-1 text-secondary shadow-raised-100 outline-none transition-colors hover:bg-layer-1 hover:text-primary"
        >
          <Sparkles className="size-4" />
        </button>
      )}
      {/* side panel */}
      <div
        className={cn(
          "fixed top-0 right-0 bottom-0 z-[40] flex w-[420px] max-w-full flex-col overflow-hidden border-l border-subtle bg-surface-1 shadow-raised-200 transition-transform duration-200",
          {
            "translate-x-full pointer-events-none": !isOpen,
          }
        )}
      >
        {/* header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-secondary" />
            <span className="text-sm font-medium text-primary">AI Assistant</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="New chat"
              title="New chat"
              onClick={() => aiChatStore.createThread(workspaceSlug)}
              className="grid size-7 place-items-center rounded-sm text-secondary outline-none hover:bg-layer-1 hover:text-primary"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              aria-label="Close AI Assistant"
              onClick={() => aiChatStore.setOpen(false)}
              className="grid size-7 place-items-center rounded-sm text-secondary outline-none hover:bg-layer-1 hover:text-primary"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
        {/* threads */}
        <AIChatThreadList workspaceSlug={workspaceSlug} />
        {/* messages */}
        <AIChatMessageList workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
        {/* composer */}
        <AIChatComposer workspaceSlug={workspaceSlug} />
      </div>
    </>,
    document.body
  );
});
