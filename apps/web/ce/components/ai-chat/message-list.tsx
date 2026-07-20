/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { observer } from "mobx-react";
import { Sparkles } from "lucide-react";
// components
import { RichTextEditor } from "@/components/editor/rich-text";
// hooks
import { useAIChat } from "@/plane-web/hooks/store";

/**
 * The backend sends markdown; convert it minimally for the read-only editor:
 * escape HTML, then turn newlines into <br/> tags
 */
const htmlFor = (markdown: string): string =>
  markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br/>");

type TAIChatMessageListProps = {
  workspaceId: string;
  workspaceSlug: string;
};

export const AIChatMessageList = observer(function AIChatMessageList(props: TAIChatMessageListProps) {
  const { workspaceId, workspaceSlug } = props;
  // refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // store hooks
  const aiChatStore = useAIChat();
  const { messages, currentThreadId, isLoadingMessages, error } = aiChatStore;

  // scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, messages[messages.length - 1]?.status]);

  if (!currentThreadId)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
        <Sparkles className="size-5 text-tertiary" />
        <p className="text-13 text-tertiary">Start a new chat to ask the AI assistant anything.</p>
      </div>
    );

  return (
    <div className="vertical-scrollbar scrollbar-sm flex-1 overflow-y-auto px-4 py-3">
      {isLoadingMessages ? (
        <div className="py-6 text-center text-13 text-tertiary">Loading messages...</div>
      ) : (
        <div className="flex flex-col gap-3">
          {messages.map((message) => {
            if (message.role === "user")
              return (
                <div key={message.id} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-layer-1 px-3 py-2 text-13 text-primary">
                    {message.content}
                  </div>
                </div>
              );
            // assistant messages
            if (message.status === "processing")
              return (
                <div key={message.id} className="flex justify-start">
                  <div className="max-w-[85%] animate-pulse rounded-lg px-3 py-2 text-13 text-tertiary">
                    AI is thinking...
                  </div>
                </div>
              );
            if (message.status === "error")
              return (
                <div key={message.id} className="flex justify-start">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-13 text-red-500">
                    {message.error || "Something went wrong. Please try again."}
                  </div>
                </div>
              );
            return (
              <div key={message.id} className="flex justify-start">
                <div className="max-w-full flex-1 text-13 text-primary">
                  <RichTextEditor
                    displayConfig={{
                      fontSize: "small-font",
                    }}
                    editable={false}
                    id={`ai-chat-msg-${message.id}`}
                    initialValue={htmlFor(message.content)}
                    containerClassName="!p-0 border-none"
                    editorClassName="!pl-0"
                    workspaceId={workspaceId}
                    workspaceSlug={workspaceSlug}
                  />
                </div>
              </div>
            );
          })}
          {messages.length === 0 && (
            <div className="py-6 text-center text-13 text-tertiary">No messages yet. Say hello!</div>
          )}
        </div>
      )}
      {error && <div className="pt-2 text-center text-13 text-red-500">{error}</div>}
      <div ref={messagesEndRef} />
    </div>
  );
});
