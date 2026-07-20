# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.db import models
from django.conf import settings

# Module imports
from .workspace import WorkspaceBaseModel


class AIChatThread(WorkspaceBaseModel):
    title = models.CharField(max_length=255, blank=True, default="New chat")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="ai_chat_threads",
    )

    class Meta:
        verbose_name = "AI Chat Thread"
        verbose_name_plural = "AI Chat Threads"
        db_table = "ai_chat_threads"
        ordering = ("-updated_at",)

    def __str__(self):
        return f"{self.title} <{self.user.email}>"


class AIChatMessage(WorkspaceBaseModel):
    ROLE_CHOICES = (
        ("user", "User"),
        ("assistant", "Assistant"),
    )
    STATUS_CHOICES = (
        ("sent", "Sent"),
        ("processing", "Processing"),
        ("completed", "Completed"),
        ("error", "Error"),
    )

    thread = models.ForeignKey(
        "db.AIChatThread",
        on_delete=models.CASCADE,
        related_name="messages",
    )
    role = models.CharField(max_length=30, choices=ROLE_CHOICES)
    status = models.CharField(max_length=30, choices=STATUS_CHOICES, default="sent")
    content = models.TextField(blank=True, default="")
    error = models.TextField(null=True, blank=True)

    class Meta:
        verbose_name = "AI Chat Message"
        verbose_name_plural = "AI Chat Messages"
        db_table = "ai_chat_messages"
        ordering = ("created_at",)

    def __str__(self):
        return f"{self.role} <{self.thread_id}>"
