<script>
  let { form } = $props();
</script>

<h1>Sign in</h1>
<form method="POST">
  <label>Email <input name="email" type="email" autocomplete="username" required /></label>
  <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
  <button type="submit">Sign in</button>
</form>
{#if form?.error}<p role="alert">{form.error}</p>{/if}
