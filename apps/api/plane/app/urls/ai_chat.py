# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.urls import path


from plane.app.views import AIChatThreadEndpoint, AIChatMessageEndpoint


urlpatterns = [
    path(
        "workspaces/<str:slug>/ai-chat/threads/",
        AIChatThreadEndpoint.as_view(),
        name="ai-chat-threads",
    ),
    path(
        "workspaces/<str:slug>/ai-chat/threads/<uuid:thread_id>/",
        AIChatThreadEndpoint.as_view(),
        name="ai-chat-thread",
    ),
    path(
        "workspaces/<str:slug>/ai-chat/threads/<uuid:thread_id>/messages/",
        AIChatMessageEndpoint.as_view(),
        name="ai-chat-thread-messages",
    ),
]
