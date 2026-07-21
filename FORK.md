# Plane fork — AI chat module

This fork adds a self-hosted AI chat assistant (Twenty CRM style) to Plane CE.

## Branches

- `ai-chat` — our feature branch, based on release tag `v1.3.1`. This is what production builds from.
- When upgrading Plane: create a new branch from the new release tag (e.g. `v1.4.0`),
  cherry-pick (or merge) the AI chat commit(s) onto it, build, deploy.

## Our changes (all additive — keep it that way)

### Backend (`apps/api`)
| File | Change |
|---|---|
| `plane/db/models/ai_chat.py` | NEW — `AIChatThread`, `AIChatMessage` |
| `plane/db/models/__init__.py` | +1 export line |
| `plane/db/migrations/0122_ai_chat.py` | NEW — hand-written migration (renumber when rebasing!) |
| `plane/app/views/ai_chat.py` | NEW — 5 workspace-scoped endpoints |
| `plane/app/views/__init__.py` | +1 re-export line |
| `plane/app/urls/ai_chat.py` | NEW — routes under `workspaces/<slug>/ai-chat/` |
| `plane/app/urls/__init__.py` | +2 lines (import + splat) |
| `plane/bgtasks/ai_chat_task.py` | NEW — Celery agent loop + 6 Plane tools |
| `plane/settings/common.py` | +1 line in `CELERY_IMPORTS` |
| `plane/utils/instance_config_variables/core.py` | +3 config keys (`AI_CHAT_API_KEY`, `AI_CHAT_BASE_URL`, `AI_CHAT_MODEL`) |

### Frontend (`apps/web`, `packages/services`)
| File | Change |
|---|---|
| `packages/services/src/ai/ai-chat.service.ts` | NEW — `AIChatService` |
| `packages/services/src/ai/index.ts` | +1 export line |
| `apps/web/ce/store/ai-chat.store.ts` | NEW — mobx store (polling 2s while `processing`) |
| `apps/web/ce/store/root.store.ts` | +4 lines (register store) |
| `apps/web/ce/hooks/store/use-ai-chat.ts`, `index.ts` | NEW / +1 export |
| `apps/web/ce/components/ai-chat/*` | NEW — dock panel, thread list, message list, composer |
| `apps/web/ce/components/common/modal/global.tsx` | +8 lines (lazy mount `AIChatDock`) |

## Merge rules for future updates

1. Never edit existing files beyond single registration lines (see tables above).
2. On rebase to a new Plane release:
   - re-check the touched `__init__.py` / `root.store.ts` / `global.tsx` / `core.py` files for upstream changes;
   - renumber the DB migration to be the latest + fix its `dependencies`;
   - verify `CELERY_IMPORTS` still lists `plane.bgtasks.ai_chat_task`.
3. Build only two images: `apps/api/Dockerfile.api` → backend (api, worker, beat-worker, migrator),
   `apps/web/Dockerfile.web` → frontend. All other services stay on official `makeplane/*` images.

## Runtime config

Set via env (or god-mode instance config — keys are registered):
- `AI_CHAT_API_KEY` — LLM API key (Kimi Code key works)
- `AI_CHAT_BASE_URL` — e.g. `https://api.kimi.com/coding/v1` (OpenAI-compatible)
- `AI_CHAT_MODEL` — e.g. `kimi-for-coding-highspeed`

## License

Upstream is AGPL-3.0; these changes inherit it.
