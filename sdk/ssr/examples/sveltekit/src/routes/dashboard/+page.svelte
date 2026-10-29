<script>let { data } = $props();
</script>

<h1>Dashboard</h1>
<p>Signed in as <strong data-testid="email">{data.email}</strong></p>
<form method="POST" action="/logout"><button type="submit">Sign out</button></form>
