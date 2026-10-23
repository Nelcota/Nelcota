<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import Plus from '@lucide/svelte/icons/plus'
  import Rows3 from '@lucide/svelte/icons/rows-3'
  import BookOpen from '@lucide/svelte/icons/book-open'
  import { href } from '$lib/navigation/router.svelte'
  import { t } from '$lib/i18n/index.svelte'

  let { oncreate }: { oncreate: () => void } = $props()
</script>

<div class="tables-workspace">
  <header class="workspace-heading">
    <div>
      <h1>{t('tables.sidebar.heading')}<span class="table-count">0</span></h1>
      <p>{t('tables.home.workspaceHint')}</p>
    </div>
    <a href={href('/guides/panel')} class="workspace-guide">
      <BookOpen class="size-4" aria-hidden="true" />{t('tables.home.emptyGuide')}
    </a>
  </header>
  <section class="table-welcome" aria-labelledby="first-table-title">
    <div class="welcome-content">
      <div class="welcome-icon" aria-hidden="true"><Rows3 class="size-7" strokeWidth={1.5} /></div>
      <h2 id="first-table-title">{t('tables.home.emptyTitle')}</h2>
      <p class="welcome-description">{t('tables.home.emptyHint')}</p>
      <Button onclick={oncreate}><Plus aria-hidden="true" />{t('tables.editor.newTable')}</Button>
      <p class="welcome-note">{t('tables.home.visualEditor')}</p>
    </div>
  </section>
</div>

<style>
  .tables-workspace { display: flex; min-height: 100%; flex-direction: column; padding-block: 1rem; }
  .workspace-guide { display: inline-flex; align-items: center; gap: .5rem; min-height: 2.75rem; border-radius: .375rem; color: var(--muted-foreground); font-size: .8125rem; text-underline-offset: .25rem; }
  .workspace-guide:hover { color: var(--foreground); text-decoration: underline; }
  .workspace-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem 1.5rem; padding-block: .5rem 1.5rem; }
  h1 { display: flex; align-items: center; gap: .75rem; font-size: 1.5rem; font-weight: 600; line-height: 1.4; letter-spacing: -.025em; }
  .table-count { display: inline-grid; min-width: 1.75rem; height: 1.5rem; place-items: center; border: 1px solid var(--border); border-radius: .375rem; padding-inline: .375rem; color: var(--muted-foreground); font-size: .75rem; font-weight: 400; letter-spacing: 0; }
  .workspace-heading p { margin-top: .375rem; color: var(--muted-foreground); font-size: .875rem; line-height: 1.6; }
  .table-welcome { display: grid; flex: 1; min-height: 24rem; place-items: center; border: 1px solid var(--border); border-radius: .75rem; background: var(--card); padding: 3rem 1.25rem; }
  .welcome-content { display: flex; width: 100%; max-width: 28rem; flex-direction: column; align-items: center; text-align: center; }
  .welcome-icon { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; border: 1px solid var(--border-strong); border-radius: 1rem; background: var(--well); color: var(--muted-foreground); }
  h2 { margin-top: 1.5rem; font-size: clamp(1.25rem, 2vw, 1.5rem); font-weight: 600; line-height: 1.4; letter-spacing: -.025em; text-wrap: balance; }
  .welcome-description { max-width: 24rem; margin-block: .75rem 1.75rem; color: var(--muted-foreground); font-size: .875rem; line-height: 1.75; text-wrap: pretty; }
  .welcome-note { margin-top: 1rem; color: var(--muted-foreground); font-size: .75rem; line-height: 1.6; }
  @media (max-width: 40rem) {
    .tables-workspace { padding-top: .5rem; }
    .workspace-heading { padding-block: .5rem 1.25rem; }
    .table-welcome { min-height: 22rem; padding: 2.5rem 1rem; }
  }
</style>
