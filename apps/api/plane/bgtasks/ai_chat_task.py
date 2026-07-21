# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Python imports
import json
import os
import re

# Идентификатор задачи вида PROJ-123 (project.identifier + sequence_id)
ISSUE_IDENTIFIER_RE = re.compile(r"^([A-Za-z][A-Za-z0-9]*)-(\d+)$")

# Эвристика "заявления о записи" в финальном тексте (для анти-галлюцинационной
# пометки, если инструменты записи не вызывались)
WRITE_CLAIM_RE = re.compile(
    r"(создал[аи]?|создан[аыо]?|перен[её]с|перенесен[аыо]?|перенесла"
    r"|изменил[аи]?|обновил[аи]?|обновлен[аыо]?|удалил[аи]?|удален[аыо]?"
    r"|created|moved|updated|deleted)\b",
    re.IGNORECASE,
)

# Django imports
from django.contrib.auth import get_user_model
from django.db.models import Q
from django.utils import timezone
from django.utils.html import escape

# Third party imports
from celery import shared_task
from openai import OpenAI

# Module imports
from plane.db.models import (
    AIChatMessage,
    Issue,
    IssueComment,
    Project,
    ProjectMember,
    State,
    Workspace,
    WorkspaceMember,
)
from plane.license.utils.instance_value import get_configuration_value
from plane.utils.exception_logger import log_exception

# Maximum number of LLM round-trips (tool call cycles) per message
MAX_AGENT_ITERATIONS = 8
# Number of thread messages sent to the LLM as conversation history
HISTORY_LIMIT = 20
# Hard cap on issues returned by the search_issues tool
SEARCH_LIMIT = 25
# Tools that modify data — used to flag messages that changed workspace data
WRITE_TOOLS = {"create_issue", "update_issue_state", "bulk_update_issue_state", "add_issue_comment"}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "list_projects",
            "description": "List the projects in the current workspace that the user is a member of.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_issues",
            "description": "Search issues by text in name/description or by identifier like PROJ-123. Returns compact issue summaries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Text to search for."},
                    "project_id": {"type": "string", "description": "Optional project UUID to restrict the search."},
                    "state_group": {
                        "type": "string",
                        "enum": ["backlog", "unstarted", "started", "completed", "cancelled"],
                        "description": "Optional state group filter.",
                    },
                    "limit": {"type": "integer", "description": "Max results, capped at 25."},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_issue",
            "description": "Get full details of a single issue (by UUID or identifier like PROJ-123), including description, state, assignees and recent comments.",
            "parameters": {
                "type": "object",
                "properties": {"issue_id": {"type": "string", "description": "Issue UUID or identifier like PROJ-123."}},
                "required": ["issue_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_issue",
            "description": "Create a new issue in a project the user is a member of.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "Project UUID."},
                    "name": {"type": "string", "description": "Issue title."},
                    "description_text": {"type": "string", "description": "Optional plain text description."},
                },
                "required": ["project_id", "name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_states",
            "description": "List the workflow states of a project (names like 'Backlog', 'Todo', 'In Progress', 'Done', 'Cancelled'). Call this BEFORE changing issue states to get exact state names.",
            "parameters": {
                "type": "object",
                "properties": {"project_id": {"type": "string", "description": "Project UUID."}},
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_issues",
            "description": "List issues of a project (or all member projects), optionally filtered by state group. Use this to enumerate issues before bulk operations.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "string", "description": "Optional project UUID."},
                    "state_group": {
                        "type": "string",
                        "enum": ["backlog", "unstarted", "started", "completed", "cancelled"],
                        "description": "Optional state group filter.",
                    },
                    "limit": {"type": "integer", "description": "Max results, capped at 50."},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bulk_update_issue_state",
            "description": "Move MULTIPLE issues to a different state in one call. Use this when the user asks to move/transfer several or all issues.",
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Issue UUIDs or identifiers like PROJ-123.",
                    },
                    "state_name": {"type": "string", "description": "Target state name (use list_states to discover exact names)."},
                },
                "required": ["issue_ids", "state_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "update_issue_state",
            "description": "Move a single issue to a different state. Provide either state_id or state_name.",
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_id": {"type": "string", "description": "Issue UUID or identifier like PROJ-123."},
                    "state_id": {"type": "string", "description": "State UUID."},
                    "state_name": {"type": "string", "description": "State name, e.g. 'In Progress'."},
                },
                "required": ["issue_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "add_issue_comment",
            "description": "Add a comment to an issue on behalf of the user.",
            "parameters": {
                "type": "object",
                "properties": {
                    "issue_id": {"type": "string", "description": "Issue UUID or identifier like PROJ-123."},
                    "comment_text": {"type": "string", "description": "Plain text comment."},
                },
                "required": ["issue_id", "comment_text"],
            },
        },
    },
]


def _member_project_ids(ctx):
    return set(
        ProjectMember.objects.filter(
            member=ctx["user"], is_active=True, project__workspace=ctx["workspace"]
        ).values_list("project_id", flat=True)
    )


def _serialize_issue_summary(issue):
    return {
        "id": str(issue.id),
        "sequence_id": issue.sequence_id,
        "identifier": f"{issue.project.identifier}-{issue.sequence_id}",
        "name": issue.name,
        "state": issue.state.name if issue.state else None,
        "priority": issue.priority,
        "target_date": issue.target_date.isoformat() if issue.target_date else None,
    }


def _tool_list_projects(ctx):
    projects = Project.objects.filter(id__in=ctx["project_ids"]).values("id", "name", "identifier")
    return [{"id": str(project["id"]), "name": project["name"], "identifier": project["identifier"]} for project in projects]


def _tool_search_issues(ctx, query, project_id=None, state_group=None, limit=10):
    issues = Issue.issue_objects.filter(project_id__in=ctx["project_ids"])
    # Поддержка поиска по идентификатору вида PROJ-123
    identifier_match = ISSUE_IDENTIFIER_RE.match((query or "").strip())
    if identifier_match:
        prefix, sequence_id = identifier_match.groups()
        issues = issues.filter(
            project__identifier__iexact=prefix, sequence_id=int(sequence_id)
        )
    else:
        issues = issues.filter(
            Q(name__icontains=query) | Q(description_stripped__icontains=query)
        )
    if project_id:
        issues = issues.filter(project_id=project_id)
    if state_group:
        issues = issues.filter(state__group=state_group)
    limit = max(1, min(int(limit or 10), SEARCH_LIMIT))
    return [_serialize_issue_summary(issue) for issue in issues.select_related("project", "state")[:limit]]


def _tool_get_issue(ctx, issue_id):
    issues = Issue.issue_objects.select_related("project", "state").filter(
        project_id__in=ctx["project_ids"]
    )
    # Поддержка как UUID, так и идентификатора вида PROJ-123
    identifier_match = ISSUE_IDENTIFIER_RE.match((issue_id or "").strip())
    if identifier_match:
        prefix, sequence_id = identifier_match.groups()
        issue = issues.get(
            project__identifier__iexact=prefix, sequence_id=int(sequence_id)
        )
    else:
        issue = issues.get(pk=issue_id)
    comments = (
        IssueComment.objects.filter(issue=issue)
        .select_related("actor")
        .order_by("-created_at")[:10]
    )
    return {
        **_serialize_issue_summary(issue),
        "description": issue.description_stripped,
        "start_date": issue.start_date.isoformat() if issue.start_date else None,
        "assignees": list(issue.assignees.values_list("email", flat=True)),
        "comments": [
            {
                "id": str(comment.id),
                "actor": comment.actor.email if comment.actor else None,
                "comment": comment.comment_stripped,
                "created_at": comment.created_at.isoformat(),
            }
            for comment in comments
        ],
    }


def _tool_create_issue(ctx, project_id, name, description_text=""):
    project = Project.objects.get(pk=project_id, id__in=ctx["project_ids"])
    issue = Issue.objects.create(
        project=project,
        workspace=ctx["workspace"],
        name=name,
        description_html=f"<p>{escape(description_text)}</p>" if description_text else "",
        created_by=ctx["user"],
    )
    return {
        "id": str(issue.id),
        "sequence_id": issue.sequence_id,
        "identifier": f"{project.identifier}-{issue.sequence_id}",
        "name": issue.name,
        "state": issue.state.name if issue.state else None,
    }


def _resolve_issue(ctx, issue_id):
    """Найти задачу по UUID или идентификатору вида PROJ-123."""
    issues = Issue.issue_objects.filter(project_id__in=ctx["project_ids"])
    identifier_match = ISSUE_IDENTIFIER_RE.match((issue_id or "").strip())
    if identifier_match:
        prefix, sequence_id = identifier_match.groups()
        return issues.get(
            project__identifier__iexact=prefix, sequence_id=int(sequence_id)
        )
    return issues.get(pk=issue_id)


def _tool_list_states(ctx, project_id):
    project = Project.objects.get(pk=project_id, id__in=ctx["project_ids"])
    states = State.objects.filter(project=project).order_by("sequence")
    return [
        {"id": str(state.id), "name": state.name, "group": state.group, "sequence": state.sequence}
        for state in states
    ]


def _tool_list_issues(ctx, project_id=None, state_group=None, limit=50):
    issues = Issue.issue_objects.filter(project_id__in=ctx["project_ids"])
    if project_id:
        issues = issues.filter(project_id=project_id)
    if state_group:
        issues = issues.filter(state__group=state_group)
    limit = max(1, min(int(limit or 50), 50))
    return [
        _serialize_issue_summary(issue)
        for issue in issues.select_related("project", "state").order_by("-created_at")[:limit]
    ]


# Алиасы названий состояний -> группа (частые варианты от пользователя/модели)
STATE_GROUP_ALIASES = {
    "canceled": "cancelled",
    "cancel": "cancelled",
    "отменено": "cancelled",
    "отмена": "cancelled",
    "done": "completed",
    "сделано": "completed",
    "готово": "completed",
    "завершено": "completed",
    "todo": "unstarted",
    "in progress": "started",
    "backlog": "backlog",
}


def _resolve_state(project, state_id=None, state_name=None):
    states = State.objects.filter(project=project)
    if state_id:
        return states.get(pk=state_id)
    if not state_name:
        raise ValueError("Either state_id or state_name is required")
    # Точное совпадение по имени
    try:
        return states.get(name__iexact=state_name)
    except State.DoesNotExist:
        pass
    # Совпадение по группе или алиасу
    group = STATE_GROUP_ALIASES.get(state_name.strip().lower())
    if group:
        try:
            return states.get(group=group)
        except State.DoesNotExist:
            pass
    available = ", ".join(states.values_list("name", flat=True))
    raise ValueError(
        f"State '{state_name}' not found. Available states: {available}"
    )


def _tool_update_issue_state(ctx, issue_id, state_id=None, state_name=None):
    issue = _resolve_issue(ctx, issue_id)
    state = _resolve_state(issue.project, state_id=state_id, state_name=state_name)
    issue.state = state
    issue.save()
    return {"id": str(issue.id), "state": state.name, "state_id": str(state.id)}


def _tool_bulk_update_issue_state(ctx, issue_ids, state_name):
    if not issue_ids:
        raise ValueError("issue_ids is required and must not be empty")
    updated, errors = [], []
    for issue_id in issue_ids[:50]:
        try:
            issue = _resolve_issue(ctx, issue_id)
            state = _resolve_state(issue.project, state_name=state_name)
            issue.state = state
            issue.save()
            updated.append({"id": str(issue.id), "state": state.name})
        except Exception as e:
            errors.append({"issue_id": issue_id, "error": str(e)})
    return {
        "updated_count": len(updated),
        "updated": updated,
        "errors": errors,
        "state": state.name if updated else None,
    }


def _tool_add_issue_comment(ctx, issue_id, comment_text):
    issue = _resolve_issue(ctx, issue_id)
    comment = IssueComment.objects.create(
        issue=issue,
        project=issue.project,
        workspace=ctx["workspace"],
        comment_html=f"<p>{escape(comment_text)}</p>",
        actor=ctx["user"],
        created_by=ctx["user"],
    )
    return {"id": str(comment.id), "issue_id": str(issue.id)}


TOOL_HANDLERS = {
    "list_projects": _tool_list_projects,
    "list_states": _tool_list_states,
    "list_issues": _tool_list_issues,
    "search_issues": _tool_search_issues,
    "get_issue": _tool_get_issue,
    "create_issue": _tool_create_issue,
    "update_issue_state": _tool_update_issue_state,
    "bulk_update_issue_state": _tool_bulk_update_issue_state,
    "add_issue_comment": _tool_add_issue_comment,
}


def _get_llm_client():
    api_key, base_url, model = get_configuration_value(
        [
            {"key": "AI_CHAT_API_KEY", "default": os.environ.get("AI_CHAT_API_KEY")},
            {"key": "AI_CHAT_BASE_URL", "default": os.environ.get("AI_CHAT_BASE_URL", "")},
            {"key": "AI_CHAT_MODEL", "default": os.environ.get("AI_CHAT_MODEL", "")},
        ]
    )
    if not api_key or not model:
        raise ValueError("AI chat is not configured (AI_CHAT_API_KEY and AI_CHAT_MODEL are required)")
    client = OpenAI(api_key=api_key, base_url=base_url or None, timeout=120)
    return client, model


def _build_system_prompt(workspace):
    return (
        "You are an AI assistant inside Plane, a project management tool. "
        f"Today's date is {timezone.now().date().isoformat()}. "
        f"You are operating in the workspace '{workspace.slug}'. "
        "You may use the provided tools to query and modify issues in the projects the user is a member of. "
        "Answer concisely and always in the user's language. "
        "When listing issues, always include the issue identifier (e.g. PROJ-123) and its state. "
        "The tools understand identifiers like PROJ-123 — prefer them when the user references a specific issue. "
        "CRITICAL: never claim that you created, updated or deleted anything unless the corresponding tool "
        "was actually called and returned a success result. If you did not call a tool, honestly say "
        "that no changes were made and explain why. "
        "When asked to change issue states, first call list_states to get the exact state names of the project. "
        "When asked to move or update multiple issues, first enumerate them with list_issues, then use "
        "bulk_update_issue_state (or update_issue_state per issue). Never simulate a bulk change in text only."
    )


def _load_history(thread_id, exclude_message_id):
    messages = (
        AIChatMessage.objects.filter(thread_id=thread_id)
        .exclude(pk=exclude_message_id)
        .exclude(content="")
        .order_by("-created_at")[:HISTORY_LIMIT]
    )
    return [{"role": message.role, "content": message.content} for message in reversed(messages)]


def _run_agent(user, workspace, thread_id, exclude_message_id):
    client, model = _get_llm_client()
    ctx = {"user": user, "workspace": workspace}
    ctx["project_ids"] = _member_project_ids(ctx)

    messages = [{"role": "system", "content": _build_system_prompt(workspace)}]
    messages.extend(_load_history(thread_id, exclude_message_id))

    final_text = ""
    tools_used = []
    for iteration in range(MAX_AGENT_ITERATIONS):
        response = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOL_SCHEMAS,
            # Первый вызов за ход — принудительно с инструментом: иначе модель
            # может "ответить текстом" и сымитировать действие без tool calls
            tool_choice="required" if iteration == 0 else "auto",
        )
        choice = response.choices[0]
        assistant_message = choice.message

        if choice.finish_reason != "tool_calls" or not assistant_message.tool_calls:
            final_text = assistant_message.content or ""
            break

        messages.append(
            {
                "role": "assistant",
                "content": assistant_message.content,
                "tool_calls": [tool_call.model_dump() for tool_call in assistant_message.tool_calls],
            }
        )
        for tool_call in assistant_message.tool_calls:
            handler = TOOL_HANDLERS.get(tool_call.function.name)
            tools_used.append(tool_call.function.name)
            try:
                if handler is None:
                    raise ValueError(f"Unknown tool: {tool_call.function.name}")
                arguments = json.loads(tool_call.function.arguments or "{}")
                result = handler(ctx, **arguments)
            except Exception as e:
                result = {"error": str(e)}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result, default=str),
                }
            )
    else:
        final_text = final_text or "I reached the maximum number of tool calls for this message. Please try again."

    meta = {
        "tools_used": tools_used,
        "mutated": any(tool in WRITE_TOOLS for tool in tools_used),
    }

    # Страховка от галлюцинаций: если в финальном тексте заявлено изменение
    # данных, а инструменты записи не вызывались — честно предупреждаем
    if not meta["mutated"] and WRITE_CLAIM_RE.search(final_text or ""):
        final_text += (
            "\n\n⚠️ Внимание: в ответе заявлено изменение данных, но инструменты "
            "записи не вызывались — скорее всего, никаких изменений не было. "
            "Попробуйте переформулировать запрос."
        )

    return final_text, meta


@shared_task
def ai_chat_task(thread_id, message_id, user_id, slug):
    message = None
    try:
        message = AIChatMessage.objects.get(pk=message_id, thread_id=thread_id)
        message.status = "processing"
        message.save(update_fields=["status", "updated_at"])

        workspace = Workspace.objects.get(slug=slug)
        user = get_user_model().objects.get(pk=user_id)

        # Re-check that the user is still an active member of the workspace
        is_member = WorkspaceMember.objects.filter(
            workspace=workspace, member=user, is_active=True
        ).exists()
        if not is_member:
            message.status = "error"
            message.error = "permission denied"
            message.save(update_fields=["status", "error", "updated_at"])
            return

        final_text, meta = _run_agent(
            user=user,
            workspace=workspace,
            thread_id=thread_id,
            exclude_message_id=message.id,
        )
        message.content = final_text
        message.meta = meta
        message.status = "completed"
        message.save(update_fields=["content", "meta", "status", "updated_at"])
    except Exception as e:
        log_exception(e)
        if message is not None:
            message.status = "error"
            message.error = str(e)[:500]
            message.save(update_fields=["status", "error", "updated_at"])
