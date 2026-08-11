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
  // bumped when the agent mutates workspace data — the dock revalidates SWR caches
  mutationNonce: number;
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
  hydrateFromStorage: () => void;
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
  mutationNonce: number = 0;
  // internal
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private workspaceSlug: string | null = null;
  private rootStore: RootStore;
  // ids of messages seen as "processing" in the previous poll tick
  private previouslyProcessingIds = new Set<string>();
  // service
  private aiChatService: AIChatService;

  constructor(rootStore: RootStore) {
    this.rootStore = rootStore;
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
      mutationNonce: observable,
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
      hydrateFromStorage: action,
    });
    this.aiChatService = new AIChatService();

    // Persist panel state on every change
    reaction(
      () => [this.isOpen, this.currentThreadId, this.workspaceSlug] as const,
      ([isOpen, currentThreadId, workspaceSlug]) => {
        try {
          window.sessionStorage.setItem(PANEL_STATE_KEY, JSON.stringify({ isOpen, currentThreadId, workspaceSlug }));
        } catch {
          // ignore persistence errors
        }
      }
    );
  }

  /**
   * Restore panel state from sessionStorage AFTER mount (called from the dock's
   * useEffect). Doing this in the constructor breaks SSR hydration: the server
   * HTML has the panel closed while the client renders it open (React #418).
   */
  hydrateFromStorage = (): void => {
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

    // After a reload, re-fetch messages of the restored open thread
    if (this.isOpen && this.currentThreadId && this.workspaceSlug) {
      void this.selectThread(this.workspaceSlug, this.currentThreadId);
    }
  };

  /**
   * Returns whether any message in the current thread is still being processed
   */
  get isAnyMessageProcessing(): boolean {
    return this.messages.some((message) => message.status === "processing");
  }

  /**
   * Refreshes the active Plane stores after an AI write completes.
   * The AI tools write directly to the database and therefore do not emit the
   * realtime events used by the regular UI mutations.
   */
  private refreshVisibleData = async (workspaceSlug: string) => {
    const { router, issue } = this.rootStore;
    if (router.workspaceSlug !== workspaceSlug) return;

    const projectId = router.projectId;
    const refreshes: Promise<unknown>[] = [];

    if (router.globalViewId) {
      refreshes.push(
        issue.workspaceIssues.fetchIssuesWithExistingPagination(workspaceSlug, router.globalViewId, "mutation")
      );
    } else if (router.userId) {
      refreshes.push(issue.profileIssues.fetchIssuesWithExistingPagination(workspaceSlug, router.userId, "mutation"));
    } else if (router.teamspaceId && router.viewId && projectId) {
      refreshes.push(
        issue.teamViewIssues.fetchIssuesWithExistingPagination(workspaceSlug, projectId, router.viewId, "mutation")
      );
    } else if (router.teamspaceId && projectId) {
      refreshes.push(
        issue.teamProjectWorkItems.fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation")
      );
    } else if (router.viewId && projectId) {
      refreshes.push(
        issue.projectViewIssues.fetchIssuesWithExistingPagination(workspaceSlug, projectId, router.viewId, "mutation")
      );
    } else if (router.cycleId && projectId) {
      refreshes.push(
        issue.cycleIssues.fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation", router.cycleId)
      );
    } else if (router.moduleId && projectId) {
      refreshes.push(
        issue.moduleIssues.fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation", router.moduleId)
      );
    } else if (router.epicId && projectId) {
      refreshes.push(issue.projectEpics.fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation"));
    } else if (projectId) {
      refreshes.push(issue.projectIssues.fetchIssuesWithExistingPagination(workspaceSlug, projectId, "mutation"));
    }

    // Refresh the workspace project list as well (create_project is an AI write).
    refreshes.push(this.rootStore.projectRoot.project.fetchProjects(workspaceSlug));

    // Keep project/cycle/module counters in sync with the refreshed issue list.
    if (projectId) {
      refreshes.push(this.rootStore.projectRoot.project.fetchProjectDetails(workspaceSlug, projectId));
    }
    if (projectId && router.cycleId) {
      refreshes.push(this.rootStore.cycle.fetchCycleDetails(workspaceSlug, projectId, router.cycleId));
    }
    if (projectId && router.moduleId) {
      refreshes.push(this.rootStore.module.fetchModuleDetails(workspaceSlug, projectId, router.moduleId));
    }

    // Issue detail has separate stores for the issue, comments and activity.
    if (projectId && router.issueId) {
      refreshes.push(issue.issueDetail.fetchIssue(workspaceSlug, projectId, router.issueId));
    }

    // A peek modal can be open while the URL still points at a list view.
    const peekIssue = issue.issueDetail.peekIssue;
    if (peekIssue && peekIssue.workspaceSlug === workspaceSlug && peekIssue.issueId !== router.issueId) {
      refreshes.push(issue.issueDetail.fetchIssue(workspaceSlug, peekIssue.projectId, peekIssue.issueId));
    }

    await Promise.allSettled(refreshes);
  };

  private markMutation = (workspaceSlug: string) => {
    runInAction(() => {
      this.mutationNonce += 1;
    });
    void this.refreshVisibleData(workspaceSlug);
  };

  /**
   * Toggles the AI chat panel
   * @param value - optional explicit open state
   */
  togglePanel = (value?: boolean) => {
    const nextValue = value !== undefined ? value : !this.isOpen;
    this.setOpen(nextValue);
  };

  /**
   * Opens or closes the AI chat panel; keep polling while an answer is processing
   * so a completed mutation is refreshed even if the panel is closed.
   * @param value
   */
  setOpen = (value: boolean) => {
    this.isOpen = value;
    if (!value && !this.isAnyMessageProcessing) this.stopPolling();
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
      if (this.currentThreadId === threadId) {
        if (this.isAnyMessageProcessing) {
          this.startPolling(workspaceSlug);
        } else if (response.assistant_message.meta?.mutated) {
          this.markMutation(workspaceSlug);
        }
      }
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
    // Seed from the messages already in the store so a response that finishes
    // before the very first poll is still recognized as a completed mutation.
    this.previouslyProcessingIds = new Set(
      this.messages.filter((message) => message.status === "processing").map((message) => message.id)
    );
    this.pollingInterval = setInterval(async () => {
      const threadId = this.currentThreadId;
      if (!threadId) {
        this.stopPolling();
        return;
      }
      try {
        const messages = await this.aiChatService.getMessages(workspaceSlug, threadId);
        runInAction(() => {
          if (this.currentThreadId !== threadId) return;
          this.messages = messages;
        });
        if (this.currentThreadId !== threadId) return;

        // If an agent message that was processing in the previous tick finished
        // and it mutated workspace data, refresh both SWR and MobX stores.
        const finishedIds = [...this.previouslyProcessingIds].filter(
          (id) => !messages.some((m) => m.id === id && m.status === "processing")
        );
        const shouldRefresh = finishedIds.some((id) => {
          const message = messages.find((m) => m.id === id);
          return message?.status === "error" || (message?.status === "completed" && message?.meta?.mutated === true);
        });
        this.previouslyProcessingIds = new Set(messages.filter((m) => m.status === "processing").map((m) => m.id));
        // An error can happen after an earlier tool call already committed data,
        // so terminal error responses refresh the visible stores defensively too.
        if (shouldRefresh) this.markMutation(workspaceSlug);
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
