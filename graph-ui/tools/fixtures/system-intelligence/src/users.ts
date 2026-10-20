export type Profile = { name: string; email: string };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function createUser(input: Profile): Profile {
  const email = normalizeEmail(input.email);
  return saveUser({ name: input.name, email });
}

export function saveUser(profile: Profile): Profile {
  // The fixture makes no claim that this in-memory function executes SQL.
  return profile;
}

export async function loadUsers(): Promise<unknown> {
  return fetch('/api/users').then((response) => response.json());
}
