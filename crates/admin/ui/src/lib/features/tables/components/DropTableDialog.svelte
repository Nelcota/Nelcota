<script lang="ts">
  import { onDestroy } from 'svelte'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { buttonVariants } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { toast } from 'svelte-sonner'
  import { ddl } from '$lib/shared/schema/ddl'
  import { errorMessage, t } from '$lib/i18n/index.svelte'

  let { open = $bindable(false), table, ondropped }: { open?: boolean; table: string; ondropped: () => void } = $props()

  let typed = $state('')
  let cascade = $state(false)
  let busy = $state(false)
  let active = true
  onDestroy(() => { active = false })

  $effect(() => {
    if (open) {
      typed = ''
      cascade = false
    }
  })

  async function confirm() {
    if (!active || busy || typed !== table) return
    const target = table
    busy = true
    try {
      const result = await ddl.dropTable(target, cascade)
      if (!active || table !== target) return
      toast.success(t('tables.toast.tableDropped'))
      open = false
      ondropped()
    } catch (e) {
      if (active && table === target) toast.error(errorMessage(e))
    } finally {
      busy = false
    }
  }
</script>

<!-- Confirmed by typing the name: deleting a table cannot be undone. -->
<AlertDialog.Root bind:open>
  <AlertDialog.Content>
    <AlertDialog.Header>
      <AlertDialog.Title>{t('tables.drop.title', { name: table })}</AlertDialog.Title>
      <AlertDialog.Description>
        {t('tables.drop.description')}
      </AlertDialog.Description>
    </AlertDialog.Header>
    <div class="grid gap-4">
      <label class="grid gap-2 text-sm">
        <span class="text-muted-foreground">{t('tables.drop.typeBefore')} <code class="text-foreground">{table}</code> {t('tables.drop.typeAfter')}</span>
        <Input bind:value={typed} autocomplete="off" class="font-mono" />
      </label>
      <label class="flex cursor-pointer items-start gap-3 text-sm">
        <Checkbox bind:checked={cascade} class="mt-0.5" />
        <span>
          {t('tables.drop.cascade')}
          <span class="mt-0.5 block text-sm text-muted-foreground">
            {t('tables.drop.cascadeHint')}
          </span>
        </span>
      </label>
    </div>
    <AlertDialog.Footer>
      <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
      <AlertDialog.Action
        class={buttonVariants({ variant: 'destructive' })}
        disabled={busy || typed !== table}
        onclick={confirm}>{t('tables.drop.submit')}</AlertDialog.Action
      >
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
