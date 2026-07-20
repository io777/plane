/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { observer } from "mobx-react";
import { CircleArrowUp } from "lucide-react";
// plane imports
import { cn } from "@plane/utils";
// hooks
import { useAIChat } from "@/plane-web/hooks/store";

type TAIChatComposerProps = {
  workspaceSlug: string;
};

export const AIChatComposer = observer(function AIChatComposer(props: TAIChatComposerProps) {
  const { workspaceSlug } = props;
  // states
  const [value, setValue] = useState("");
  // refs
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // store hooks
  const aiChatStore = useAIChat();
  const { isSending } = aiChatStore;
  // derived values
  const isDisabled = isSending || value.trim().length === 0;

  const resizeTextarea = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  };

  const handleSend = async () => {
    const trimmedValue = value.trim();
    if (!trimmedValue || isSending) return;
    setValue("");
    requestAnimationFrame(resizeTextarea);
    // auto-create a thread when none is selected
    if (!aiChatStore.currentThreadId) await aiChatStore.createThread(workspaceSlug);
    await aiChatStore.sendMessage(workspaceSlug, trimmedValue);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex-shrink-0 border-t border-subtle p-3">
      <div className="flex items-end gap-2 rounded-lg border border-subtle bg-layer-1 px-3 py-2 focus-within:border-strong">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            resizeTextarea();
          }}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything..."
          rows={1}
          className="vertical-scrollbar scrollbar-sm max-h-40 flex-1 resize-none bg-transparent text-13 text-primary placeholder:text-placeholder outline-none"
        />
        <button
          type="button"
          aria-label="Send message"
          onClick={handleSend}
          disabled={isDisabled}
          className={cn("grid size-7 flex-shrink-0 place-items-center rounded-full text-secondary outline-none", {
            "cursor-not-allowed opacity-40": isDisabled,
            "hover:text-primary": !isDisabled,
          })}
        >
          <CircleArrowUp className="size-5" />
        </button>
      </div>
    </div>
  );
});
