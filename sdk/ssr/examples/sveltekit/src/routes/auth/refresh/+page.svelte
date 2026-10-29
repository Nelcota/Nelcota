<script>import { onMount } from 'svelte';

  /** @type {HTMLFormElement} */
  let form;
  onMount(() => form.requestSubmit());
</script>

<h1>Refreshing your session…</h1>
<form method="POST" bind:this={form}><button type="submit">Continue</button></form>
