# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Django imports
from django.utils import timezone

# Third party imports
from rest_framework import status
from rest_framework.response import Response

# Module imports
from plane.app.permissions import ROLE, allow_permission
from plane.bgtasks.ai_chat_task import ai_chat_task
from plane.db.models import AIChatMessage, AIChatThread, Workspace

from .base import BaseAPIView


def serialize_thread(thread):
    return {
        "id": str(thread.id),
        "title": thread.title,
        "created_at": thread.created_at,
        "updated_at": thread.updated_at,
    }


def serialize_message(message):
    return {
        "id": str(message.id),
        "role": message.role,
        "content": message.content,
        "status": message.status,
        "error": message.error,
        "meta": message.meta,
        "created_at": message.created_at,
    }


class AIChatThreadEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug):
        threads = AIChatThread.objects.filter(
            workspace__slug=slug, user=request.user
        ).order_by("-updated_at")
        return Response(
            [serialize_thread(thread) for thread in threads],
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug):
        workspace = Workspace.objects.get(slug=slug)
        title = request.data.get("title") or "New chat"
        thread = AIChatThread.objects.create(
            workspace=workspace,
            user=request.user,
            title=title,
        )
        return Response(
            serialize_thread(thread),
            status=status.HTTP_201_CREATED,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def delete(self, request, slug, thread_id):
        thread = AIChatThread.objects.get(
            pk=thread_id, workspace__slug=slug, user=request.user
        )
        thread.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class AIChatMessageEndpoint(BaseAPIView):
    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def get(self, request, slug, thread_id):
        messages = AIChatMessage.objects.filter(
            thread_id=thread_id,
            thread__workspace__slug=slug,
            thread__user=request.user,
        ).order_by("created_at")
        return Response(
            [serialize_message(message) for message in messages],
            status=status.HTTP_200_OK,
        )

    @allow_permission([ROLE.ADMIN, ROLE.MEMBER], level="WORKSPACE")
    def post(self, request, slug, thread_id):
        content = (request.data.get("content") or "").strip()
        if not content:
            return Response(
                {"error": "Content is required"},
                status=status.HTTP_400_BAD_REQUEST,
            )

        thread = AIChatThread.objects.get(
            pk=thread_id, workspace__slug=slug, user=request.user
        )

        user_message = AIChatMessage.objects.create(
            thread=thread,
            workspace=thread.workspace,
            role="user",
            status="sent",
            content=content,
        )
        assistant_message = AIChatMessage.objects.create(
            thread=thread,
            workspace=thread.workspace,
            role="assistant",
            status="processing",
            content="",
        )

        # Bump the thread updated_at so recent chats float to the top
        thread.updated_at = timezone.now()
        thread.save(update_fields=["updated_at"])

        ai_chat_task.delay(
            thread_id=str(thread.id),
            message_id=str(assistant_message.id),
            user_id=str(request.user.id),
            slug=slug,
        )

        return Response(
            {
                "user_message": serialize_message(user_message),
                "assistant_message": serialize_message(assistant_message),
            },
            status=status.HTTP_201_CREATED,
        )
