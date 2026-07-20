/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// plane web constants
import { API_BASE_URL } from "@plane/constants";
// services
import { APIService } from "../api.service";

/**
 * AI chat thread
 * @typedef {Object} TAIChatThread
 * @property {string} id - Unique identifier of the thread
 * @property {string} title - Title of the thread
 * @property {string} created_at - ISO timestamp of creation
 * @property {string} updated_at - ISO timestamp of last update
 */
export type TAIChatThread = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
};

export type TAIChatMessageStatus = "sent" | "processing" | "completed" | "error";

/**
 * AI chat message
 * @typedef {Object} TAIChatMessage
 * @property {string} id - Unique identifier of the message
 * @property {"user" | "assistant"} role - Author of the message
 * @property {string} content - Message content (markdown)
 * @property {TAIChatMessageStatus} status - Delivery/processing status
 * @property {string | null} error - Error text when status is "error"
 * @property {string} created_at - ISO timestamp of creation
 */
export type TAIChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: TAIChatMessageStatus;
  error: string | null;
  created_at: string;
};

export type TAIChatSendMessageResponse = {
  user_message: TAIChatMessage;
  assistant_message: TAIChatMessage;
};

/**
 * Service class for handling AI chat API operations
 * Extends the base APIService class to interact with AI chat endpoints
 * @extends {APIService}
 */
export class AIChatService extends APIService {
  constructor(BASE_URL?: string) {
    super(BASE_URL || API_BASE_URL);
  }

  /**
   * Fetches all AI chat threads for a workspace
   * @param {string} workspaceSlug - The unique identifier for the workspace
   * @returns {Promise<TAIChatThread[]>} List of threads ordered by -updated_at
   * @throws {Error} Throws the response error if the request fails
   */
  async getThreads(workspaceSlug: string): Promise<TAIChatThread[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/ai-chat/threads/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }

  /**
   * Creates a new AI chat thread
   * @param {string} workspaceSlug - The unique identifier for the workspace
   * @returns {Promise<TAIChatThread>} The newly created thread
   * @throws {Error} Throws the response error if the request fails
   */
  async createThread(workspaceSlug: string): Promise<TAIChatThread> {
    return this.post(`/api/workspaces/${workspaceSlug}/ai-chat/threads/`, {})
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }

  /**
   * Deletes an AI chat thread
   * @param {string} workspaceSlug - The unique identifier for the workspace
   * @param {string} threadId - The unique identifier of the thread
   * @returns {Promise<void>}
   * @throws {Error} Throws the response error if the request fails
   */
  async deleteThread(workspaceSlug: string, threadId: string): Promise<void> {
    return this.delete(`/api/workspaces/${workspaceSlug}/ai-chat/threads/${threadId}/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }

  /**
   * Fetches all messages of an AI chat thread ordered by created_at asc
   * @param {string} workspaceSlug - The unique identifier for the workspace
   * @param {string} threadId - The unique identifier of the thread
   * @returns {Promise<TAIChatMessage[]>} List of messages
   * @throws {Error} Throws the response error if the request fails
   */
  async getMessages(workspaceSlug: string, threadId: string): Promise<TAIChatMessage[]> {
    return this.get(`/api/workspaces/${workspaceSlug}/ai-chat/threads/${threadId}/messages/`)
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }

  /**
   * Sends a user message to an AI chat thread
   * @param {string} workspaceSlug - The unique identifier for the workspace
   * @param {string} threadId - The unique identifier of the thread
   * @param {string} content - The message content
   * @returns {Promise<TAIChatSendMessageResponse>} The created user and assistant messages
   * @throws {Error} Throws the response error if the request fails
   */
  async sendMessage(workspaceSlug: string, threadId: string, content: string): Promise<TAIChatSendMessageResponse> {
    return this.post(`/api/workspaces/${workspaceSlug}/ai-chat/threads/${threadId}/messages/`, { content })
      .then((response) => response?.data)
      .catch((error) => {
        throw error?.response;
      });
  }
}
