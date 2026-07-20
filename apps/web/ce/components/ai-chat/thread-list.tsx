/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { ChevronDown, Trash2 } from "lucide-react";
// plane imports
import { cn } from "@plane/utils";
// hooks
import { useAIChat } from "@/plane-web/hooks/store";

type TAIChatThreadListProps = {
  workspaceSlug: string;
};

export const AIChatThreadList = observer(function AIChatThreadList(props: TAIChatThreadListProps) {
  const { workspaceSlug } = props;
  // states
  const [isExpanded, setIsExpanded] = useState(false);
  // store hooks
  const aiChatStore = useAIChat();
  const { threads, currentThreadId, isLoadingThreads } = aiChatStore;
  // derived values
  const currentThread = threads.find((thread) => thread.id === currentThreadId);

  const handleSelectThread = (threadId: string) => {
    setIsExpanded(false);
    if (threadId !== currentThreadId) aiChatStore.selectThread(workspaceSlug, threadId);
  };

  return (
    <div className="flex-shrink-0 border-b border-subtle">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left outline-none hover:bg-layer-1"
      >
        <span className="truncate text-13 text-secondary">
          {isLoadingThreads ? "Loading chats..." : (currentThread?.title ?? "Select a chat")}
        </span>
        <ChevronDown
          className={cn("size-3.5 flex-shrink-0 text-tertiary transition-transform", {
            "rotate-180": isExpanded,
          })}
        />
      </button>
      {isExpanded && (
        <div className="vertical-scrollbar scrollbar-sm max-h-48 overflow-y-auto border-t border-subtle py-1">
          {threads.length === 0 && <div className="px-4 py-2 text-13 text-tertiary">No chats yet</div>}
          {threads.map((thread) => (
            <div
              key={thread.id}
              className={cn("group flex items-center gap-1 px-2 py-0.5", {
                "bg-layer-1": thread.id === currentThreadId,
              })}
            >
              <button
                type="button"
                onClick={() => handleSelectThread(thread.id)}
                className="flex-1 truncate rounded-sm px-2 py-1.5 text-left text-13 text-secondary outline-none hover:bg-layer-1 hover:text-primary"
              >
                {thread.title || "Untitled chat"}
              </button>
              <button
                type="button"
                aria-label="Delete chat"
                title="Delete chat"
                onClick={() => aiChatStore.deleteThread(workspaceSlug, thread.id)}
                className="grid size-6 flex-shrink-0 place-items-center rounded-sm text-tertiary opacity-0 outline-none transition-opacity hover:bg-layer-2 hover:text-red-500 group-hover:opacity-100"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
