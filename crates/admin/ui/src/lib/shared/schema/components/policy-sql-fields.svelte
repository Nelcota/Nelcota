<script lang="ts">
  import * as Field from "$lib/components/ui/field";
  import * as Select from "$lib/components/ui/select";
  import { Checkbox } from "$lib/components/ui/checkbox";
  import { Textarea } from "$lib/components/ui/textarea";
  import { policyFields, type PolicyDef, type ApiRole, type PolicyCommand } from "../ddl";
  import { t } from "$lib/i18n/index.svelte";
  let {
    policy = $bindable(),
    ownerColumn = "user_id",
  }: { policy: PolicyDef; ownerColumn?: string } = $props();
  const fields = $derived(policyFields(policy.command));
  const roles: ApiRole[] = ["anon", "authenticated", "service_role"];
  const commands: PolicyCommand[] = ["select", "insert", "update", "delete", "all"];
</script>

<Field.Group>
  <Field.Field>
    <Field.Label for="policy-command">{t("policies.sheet.command")}</Field.Label>
    <Select.Root type="single" bind:value={policy.command}>
      <Select.Trigger id="policy-command" class="w-full"
        >{t(`policies.sheet.commands.${policy.command}`)}</Select.Trigger
      >
      <Select.Content
        ><Select.Group
          >{#each commands as command}<Select.Item value={command}
              >{t(`policies.sheet.commands.${command}`)}</Select.Item
            >{/each}</Select.Group
        ></Select.Content
      >
    </Select.Root>
  </Field.Field>
  <Field.Set
    ><Field.Legend>{t("policies.sheet.appliesTo")}</Field.Legend><Field.Group class="gap-3">
      {#each roles as role}<Field.Field orientation="horizontal"
          ><Checkbox
            id={`policy-role-${role}`}
            checked={policy.roles.includes(role)}
            onCheckedChange={(on) =>
              (policy.roles = on
                ? [...policy.roles, role]
                : policy.roles.filter((value) => value !== role))}
          /><Field.Label for={`policy-role-${role}`}
            >{role} · {t(`policies.sheet.roles.${role}`)}</Field.Label
          ></Field.Field
        >{/each}
    </Field.Group>{#if !policy.roles.length}<Field.Description
        >{t("policies.sheet.noRoles")}</Field.Description
      >{/if}</Field.Set
  >
  <Field.Field orientation="horizontal"
    ><Checkbox
      id="policy-restrictive"
      checked={!policy.permissive}
      onCheckedChange={(value) => (policy.permissive = value !== true)}
    /><Field.Content
      ><Field.Label for="policy-restrictive">{t("policies.sheet.restrictive")}</Field.Label
      ><Field.Description>{t("policies.sheet.restrictiveHint")}</Field.Description></Field.Content
    ></Field.Field
  >
  {#if fields.using}<Field.Field
      ><Field.Label for="policy-using">USING</Field.Label><Textarea
        id="policy-using"
        bind:value={() => policy.using ?? "", (value) => (policy.using = value)}
        placeholder={`${ownerColumn || "user_id"} = auth.uid()`}
        class="min-h-24 font-mono text-[0.8125rem]"
      /><Field.Description
        >{policy.command === "delete"
          ? t("policies.sheet.usingDeletes")
          : t("policies.sheet.usingSees")}</Field.Description
      ></Field.Field
    >{/if}
  {#if fields.check}<Field.Field
      ><Field.Label for="policy-check">WITH CHECK</Field.Label><Textarea
        id="policy-check"
        bind:value={() => policy.check ?? "", (value) => (policy.check = value)}
        placeholder={t("policies.sheet.checkPlaceholder")}
        class="min-h-24 font-mono text-[0.8125rem]"
      /><Field.Description>{t("policies.sheet.checkHint")}</Field.Description></Field.Field
    >{/if}
</Field.Group>
