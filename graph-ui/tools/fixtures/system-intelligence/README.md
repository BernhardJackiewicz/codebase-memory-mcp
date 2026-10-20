# Users system

This fixture describes a small user directory.

## Request handling

The [users endpoint](src/users.ts) accepts a profile, normalizes the email
address and passes it to the repository.

See the [architecture notes](docs/architecture.md#storage) and
[database schema](schema.sql).

## Deployment

The service is built with [Docker](Dockerfile) and runs with a
[PostgreSQL database](compose.yaml). The Kubernetes deployment is described
in [deployment.yaml](deployment.yaml).
