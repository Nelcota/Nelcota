const ENVIRONMENT = /^[a-zA-Z0-9_-]{1,40}$/;

/** Keeps preview, explicit application and verification separate, each pinned to one named API target. */
export function deploymentCommands(
  origin: string,
  environment: string,
): { preview: string; apply: string; verify: string } | null {
  if (ENVIRONMENT.test(environment) === false) return null;
  const quotedOrigin = `'${origin.replaceAll("'", "'\\''")}'`;
  return {
    preview: [
      `nelcota link --remote ${quotedOrigin} --env ${environment}`,
      `nelcota migrate --env ${environment} status`,
      `nelcota migrate --env ${environment} --dry-run`,
    ].join("\n"),
    apply: `nelcota migrate --env ${environment}`,
    verify: [
      `nelcota migrate --env ${environment} status`,
      `nelcota types --env ${environment} -o src/database.ts`,
    ].join("\n"),
  };
}
