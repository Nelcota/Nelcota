// The todos example (examples/todos.sql) through @nelcota/client, from Bun or Node.
//
// 1. Create the table, once, as the database owner. Either copy
//    examples/todos.sql to your project's migrations/ folder as
//    V1__todos.sql (or the next free version) and run `nelcota migrate`, or
//    paste it into the SQL editor of the panel (/admin/).
// 2. Copy this file into your consumer and run bun add --exact @nelcota/client@0.2.4
//    (or npm install --save-exact @nelcota/client@0.2.4)
// 3. NELCOTA_URL=http://127.0.0.1:8000 bun sdk-todos.mjs (or node sdk-todos.mjs)
//
// The demo signs up a fresh account and uses it at once, so the project must
// not require email confirmation (NELCOTA_EMAIL_CONFIRMATION_URL unset, the
// `nelcota dev` default).

import { createClient } from '@nelcota/client';

const nelcota = createClient(process.env.NELCOTA_URL ?? 'http://127.0.0.1:8000');

try {
  const email = `demo-${Date.now()}@example.com`;
  const signUp = await nelcota.auth.signUp({ email, password: 'a-demo-password' });
  if (signUp.error) throw signUp.error;
  if (!signUp.data.session) throw new Error('Confirm the signup email before using authenticated CRUD');

  // RLS fills user_id from the token (DEFAULT auth.uid()) and hides other users' rows.
  const { data: created } = await nelcota
    .from('todos')
    .insert([{ title: 'Write the migration' }, { title: 'Ship it' }])
    .select('id,title,done')
    .throwOnError();
  console.log('created', created);

  // Ask for the changed row back: an update that matches nothing (a wrong id,
  // or a row RLS hides) is not an error, it just changes zero rows.
  const { data: updated } = await nelcota
    .from('todos')
    .update({ done: true })
    .eq('id', created[0].id)
    .select('id,done')
    .throwOnError();
  if (updated.length !== 1) throw new Error(`expected to update 1 todo, updated ${updated.length}`);
  console.log('updated', updated[0]);

  const { data: open, count } = await nelcota
    .from('todos')
    .select('id,title', { count: 'exact' })
    .eq('done', false)
    .order('id')
    .throwOnError();
  console.log(`${count} open`, open);

  const signOut = await nelcota.auth.signOut();
  if (signOut.error) throw signOut.error;
} finally {
  nelcota.dispose();
}
