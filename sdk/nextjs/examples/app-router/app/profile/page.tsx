import { nelcota } from '../../lib/nelcota';
export const dynamic = 'force-dynamic';
export default async function Profile() {
  return (await nelcota()).server(async context => {
    const result = await context.getUser();
    if (result.error) return <main><h1>Signed out</h1></main>;
    return <main><h1>Profile</h1><p data-testid="email">{result.data.email}</p></main>;
  });
}
