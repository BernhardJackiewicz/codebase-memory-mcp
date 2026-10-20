# Architecture

## Components

[createUser](../src/users.ts) handles profile creation.

## Storage

The [users table](../schema.sql) records profiles.

The sample application currently stores profiles in memory. A relationship
between `saveUser` and the database must not be presented as proven.

## Diagram

See [the component sketch](components.mmd).
