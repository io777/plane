/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { action, computed, makeObservable, observable, reaction, runInAction } from "mobx";
// services
import type { TAIChatMessage, TAIChatThread } from "@plane/services";
import { AIChatService } from "@plane/services";
// plane web store
import type { RootStore } from "@/plane-web/store/root.store";

const POLL_INTERVAL = 2000;
const PANEL_STATE_KEY = "plane-ai-chat-panel-state";

export interface IAIChatStore {
  // observables
  isOpen: boolean;
  threads: TAIChatThread[];
  currentThreadId: string | null;
  messages: TAIChatMessage[];
  isLoadingThreads: boolean;
  isLoadingMessages: boolean;
  isSending: boolean;
  error: string | null;
  // computed
  isAnyMessageProcessing: boolean;
  // actions
  togglePanel: (value?: boolean) => void;
  setOpen: (value: boolean) => void;
  fetchThreads: (workspaceSlug: string) => Promise<void>;
  createThread: (workspaceSlug: string) => Promise<void>;
  deleteThread: (workspaceSlug: string, threadId: string) => Promise<void>;
  selectThread: (workspaceSlug: string, threadId: string) => Promise<void>;
  sendMessage: (workspaceSlug: string, content: string) => Promise<void>;
  startPolling: (workspaceSlug: string) => void;
  stopPolling: () => void;
}

export class AIChatStore implements IAIChatStore {
  // observables
  isOpen: boolean = false;
  threads: TAIChatThread[] = [];
  currentThreadId: string | null = null;
  messages: TAIChatMessage[] = [];
  isLoadingThreads: boolean = false;
  isLoadingMessages: boolean = false;
  isSending: boolean = false;
  error: string | null = null;
  // internal
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private workspaceSlug: string | null = null;
  // ids of messages seen as "processing" in the previous poll tick
  private previouslyProcessingIds = new Set<string>();
  // service
  private aiChatService: AIChatService;

  constructor(_rootStore: RootStore) {
    makeObservable(this, {
      // observables
      isOpen: observable,
      threads: observable,
      currentThreadId: observable,
      messages: observable,
      isLoadingThreads: observable,
      isLoadingMessages: observable,
      isSending: observable,
      error: observable,
      // computed
      isAnyMessageProcessing: computed,
      // actions
      togglePanel: action,
      setOpen: action,
      fetchThreads: action,
      createThread: action,
      deleteThread: action,
      selectThread: action,
      sendMessage: action,
      stopPolling: action,
    });
    this.aiChatService = new AIChatService();

    // Restore panel state across page reloads (the page reloads when the agent
    // mutates workspace data — the chat should stay open with the same thread)
    try {
      const saved = window.sessionStorage.getItem(PANEL_STATE_KEY);
      if (saved) {
        const { isOpen, currentThreadId, workspaceSlug } = JSON.parse(saved);
        this.isOpen = isOpen ?? false;
        this.currentThreadId = currentThreadId ?? null;
        this.workspaceSlug = workspaceSlug ?? null;
      }
    } catch {
      // sessionStorage unavailable or corrupted state — start fresh
    }

    // Persist panel state on every change
    reaction(
      () => [this.isOpen, this.currentThreadId, this.workspaceSlug] as const,
      ([isOpen, currentThreadId, workspaceSlug]) => {
        try {
          window.sessionStorage.setItem(
            PANEL_STATE_KEY,
            JSON.stringify({ isOpen, currentThreadId, workspaceSlug }),
          );
        } catch {
          // ignore persistence errors
        }
      },
    );

    // After a reload, re-fetch messages of the restored open thread
    if (this.isOpen && this.currentThreadId && this.workspaceSlug) {
      void this.selectThread(this.workspaceSlug, this.currentThreadId);
    }
  }

  /**
   * Returns whether any message in the current thread is still being processed
   */
  get isAnyMessageProcessing(): boolean {
    return this.messages.some((message) => message.status === "processing");
  }

  /**
   * Toggles the AI chat panel
   * @param value - optional explicit open state
   */
  togglePanel = (value?: boolean) => {
    const nextValue = value !== undefined ? value : !this.isOpen;
    this.setOpen(nextValue);
  };

  /**
   * Opens or closes the AI chat panel; stops polling when closed
   * @param value
   */
  setOpen = (value: boolean) => {
    this.isOpen = value;
    if (!value) this.stopPolling();
  };

  /**
   * Fetches all AI chat threads for a workspace
   * @param workspaceSlug
   */
  fetchThreads = async (workspaceSlug: string) => {
    this.workspaceSlug = workspaceSlug;
    this.isLoadingThreads = true;
    try {
      const threads = await this.aiChatService.getThreads(workspaceSlug);
      runInAction(() => {
        this.threads = threads;
        this.isLoadingThreads = false;
        this.error = null;
      });
    } catch {
      runInAction(() => {
        this.isLoadingThreads = false;
        this.error = "Failed to load chats";
      });
    }
  };

  /**
   * Creates a new thread and selects it
   * @param workspaceSlug
   */
  createThread = async (workspaceSlug: string) => {
    try {
      const thread = await this.aiChatService.createThread(workspaceSlug);
      runInAction(() => {
        this.threads = [thread, ...this.threads];
        this.currentThreadId = thread.id;
        this.messages = [];
        this.error = null;
      });
      this.stopPolling();
    } catch {
      runInAction(() => {
        this.error = "Failed to create a new chat";
      });
    }
  };

  /**
   * Deletes a thread; clears the current selection if it was deleted
   * @param workspaceSlug
   * @param threadId
   */
  deleteThread = async (workspaceSlug: string, threadId: string) => {
    try {
      await this.aiChatService.deleteThread(workspaceSlug, threadId);
      runInAction(() => {
        this.threads = this.threads.filter((thread) => thread.id !== threadId);
        if (this.currentThreadId === threadId) {
          this.currentThreadId = null;
          this.messages = [];
          this.stopPolling();
        }
        this.error = null;
      });
    } catch {
      runInAction(() => {
        this.error = "Failed to delete the chat";
      });
    }
  };

  /**
   * Selects a thread, fetches its messages and starts polling if needed
   * @param workspaceSlug
   * @param threadId
   */
  selectThread = async (workspaceSlug: string, threadId: string) => {
    this.workspaceSlug = workspaceSlug;
    this.currentThreadId = threadId;
    this.messages = [];
    this.isLoadingMessages = true;
    this.stopPolling();
    try {
      const messages = await this.aiChatService.getMessages(workspaceSlug, threadId);
      runInAction(() => {
        // guard against the user switching threads while the request was in flight
        if (this.currentThreadId !== threadId) return;
        this.messages = messages;
        this.isLoadingMessages = false;
        this.error = null;
      });
      if (this.currentThreadId === threadId && this.isAnyMessageProcessing) this.startPolling(workspaceSlug);
    } catch {
      runInAction(() => {
        this.isLoadingMessages = false;
        this.error = "Failed to load messages";
      });
    }
  };

  /**
   * Sends a message to the current thread with optimistic updates, then polls for the response
   * @param workspaceSlug
   * @param content
   */
  sendMessage = async (workspaceSlug: string, content: string) => {
    const threadId = this.currentThreadId;
    const trimmedContent = content.trim();
    if (!threadId || !trimmedContent || this.isSending) return;

    this.workspaceSlug = workspaceSlug;
    this.isSending = true;
    const now = new Date().toISOString();
    // optimistic placeholders
    const optimisticUserMessage: TAIChatMessage = {
      id: `optimistic-user-${now}`,
      role: "user",
      content: trimmedContent,
      status: "sent",
      error: null,
      created_at: now,
    };
    const optimisticAssistantMessage: TAIChatMessage = {
      id: `optimistic-assistant-${now}`,
      role: "assistant",
      content: "",
      status: "processing",
      error: null,
      created_at: now,
    };
    runInAction(() => {
      this.messages = [...this.messages, optimisticUserMessage, optimisticAssistantMessage];
    });

    try {
      const response = await this.aiChatService.sendMessage(workspaceSlug, threadId, trimmedContent);
      runInAction(() => {
        if (this.currentThreadId !== threadId) return;
        // replace the optimistic placeholders with the real messages
        this.messages = [
          ...this.messages.filter(
            (message) => message.id !== optimisticUserMessage.id && message.id !== optimisticAssistantMessage.id
          ),
          response.user_message,
          response.assistant_message,
        ];
        this.isSending = false;
        this.error = null;
      });
      if (this.currentThreadId === threadId && this.isAnyMessageProcessing) this.startPolling(workspaceSlug);
    } catch {
      runInAction(() => {
        if (this.currentThreadId === threadId) {
          // drop the optimistic placeholders on failure
          this.messages = this.messages.filter(
            (message) => message.id !== optimisticUserMessage.id && message.id !== optimisticAssistantMessage.id
          );
        }
        this.isSending = false;
        this.error = "Failed to send the message";
      });
    }
  };

  /**
   * Polls the current thread's messages every 2 seconds while any message is processing
   * @param workspaceSlug
   */
  startPolling = (workspaceSlug: string) => {
    if (this.pollingInterval) return;
    this.previouslyProcessingIds = new Set();
    this.pollingInterval = setInterval(async () => {
      const threadId = this.currentThreadId;
      if (!this.isOpen || !threadId) {
        this.stopPolling();
        return;
      }
      try {
        const messages = await this.aiChatService.getMessages(workspaceSlug, threadId);
        runInAction(() => {
          if (this.currentThreadId !== threadId) return;
          this.messages = messages;
        });
        // If an agent message that was processing in the previous tick finished
        // and it mutated workspace data, reload the page so the changes show up
        // without a manual refresh
        const finishedIds = [...this.previouslyProcessingIds].filter(
          (id) => !messages.some((m) => m.id === id && m.status === "processing"),
        );
        const mutated = finishedIds.some((id) => {
          const message = messages.find((m) => m.id === id);
          return message?.status === "completed" && message?.meta?.mutated === true;
        });
        this.previouslyProcessingIds = new Set(
          messages.filter((m) => m.status === "processing").map((m) => m.id),
        );
        if (mutated) {
          this.stopPolling();
          window.location.reload();
          return;
        }
        if (!this.isAnyMessageProcessing) this.stopPolling();
      } catch {
        // keep polling on transient errors; the next tick retries
      }
    }, POLL_INTERVAL);
  };

  /**
   * Stops polling for message updates
   */
  stopPolling = () => {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
  };
}
