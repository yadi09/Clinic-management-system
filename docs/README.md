# Documentation Index

| Doc | Purpose |
|---|---|
| [PROJECT_CONTEXT.md](./PROJECT_CONTEXT.md) | One-page orientation: what the product is, architecture, stack, phases, status. **Start here.** |
| [roadmap.md](./roadmap.md) | Full delivery roadmap, Phases 0–10 (scope, deliverables, deps, risks, success criteria). |
| [OPEN_QUESTIONS.md](./OPEN_QUESTIONS.md) | Decisions awaiting a human + active risks/mitigations. |
| [adr/ADR-001-infra-reconciliation.md](./adr/ADR-001-infra-reconciliation.md) | How the MVP infra (single VPS / Docker / Postgres-search / Cloudinary) reconciles with the blueprint's heavy stack, with future seams. |
| [adr/ADR-002-multitenancy.md](./adr/ADR-002-multitenancy.md) | Multi-tenancy isolation: shared-schema + `tenant_id` + RLS, and the scaling/migration path. |
| [blueprints/](./blueprints/) | Readable Markdown of the source `.docx` blueprints (Parts 1, 2, 4, 3.0, 3.1, screens). The product source-of-truth. |
| [digests/](./digests/) | Dense, implementation-oriented digests of each blueprint part (entities, FR/NFR IDs, endpoints, screens). |

## Conventions
- **ADRs** are append-only. Supersede with a new ADR rather than rewriting an accepted one.
- **Blueprints** are the product source of truth; the `.docx` originals live in `../Documentations/`. When code and blueprint disagree, the blueprint wins unless an ADR records a deliberate deviation.
- **Requirement IDs** (`FR-*`, `NFR-*`) trace from blueprints → module specs → tests. Keep them in commit messages and test names.
