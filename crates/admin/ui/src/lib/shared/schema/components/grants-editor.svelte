<script lang="ts">
  import { Checkbox } from "$lib/components/ui/checkbox";
  import {
    API_ROLES,
    PRIVILEGES,
    type GrantDef,
    type Privilege,
    type ApiRole,
  } from "$lib/shared/schema/ddl";
  import { t } from "$lib/i18n/index.svelte";

  // `surface` contrasts with what holds it: a well in a sheet, a card in a well.
  let { grants = $bindable(), surface = "bg-well" }: { grants: GrantDef[]; surface?: string } =
    $props();

  const has = (role: ApiRole, privilege: Privilege) =>
    grants.find((g) => g.role === role)?.privileges.includes(privilege) ?? false;

  function toggle(role: ApiRole, privilege: Privilege, on: boolean) {
    const current = grants.find((g) => g.role === role)?.privileges ?? [];
    const privileges = on ? [...current, privilege] : current.filter((p) => p !== privilege);
    const ordered = PRIVILEGES.filter((p) => privileges.includes(p));
    grants = [...grants.filter((g) => g.role !== role), { role, privileges: ordered }].toSorted(
      (a, b) => API_ROLES.indexOf(a.role) - API_ROLES.indexOf(b.role),
    );
  }
</script>

<!-- Role × privilege matrix. RLS still filters the rows of anon and authenticated. -->
<div class={["overflow-x-auto rounded-2xl", surface]}>
  <table class="w-full text-sm">
    <thead>
      <tr class="bg-muted/60 text-xs text-muted-foreground">
        <th class="px-4 py-2.5 text-left font-medium">{t("policies.grants.role")}</th>
        {#each PRIVILEGES as privilege (privilege)}
          <th class="w-20 px-2 py-2.5 text-center font-mono font-medium uppercase">{privilege}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each API_ROLES as role (role)}
        <tr class="border-t">
          <td class="px-4 py-3">
            <span class="font-mono text-xs font-medium">{role}</span>
            <span class="block text-xs text-muted-foreground"
              >{t(`policies.grants.hints.${role}`)}</span
            >
          </td>
          {#each PRIVILEGES as privilege (privilege)}
            <td class="px-2 py-3 text-center">
              <Checkbox
                checked={has(role, privilege)}
                onCheckedChange={(v) => toggle(role, privilege, v === true)}
                aria-label={t("policies.grants.privilegeFor", { privilege, role })}
              />
            </td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
