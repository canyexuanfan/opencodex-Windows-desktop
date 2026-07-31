export function allowUnverifiedAdminTokenAcl(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.OPENCODEX_ALLOW_UNVERIFIED_ADMIN_TOKEN_ACL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Truthy install-time value to bake into Windows service environments. */
export function bakedAllowUnverifiedAdminTokenAcl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!allowUnverifiedAdminTokenAcl(env)) return undefined;
  return env.OPENCODEX_ALLOW_UNVERIFIED_ADMIN_TOKEN_ACL!.trim();
}
