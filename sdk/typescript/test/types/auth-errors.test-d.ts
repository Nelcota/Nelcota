import { expectTypeOf, it } from 'vitest';
import type { ServerErrorCode } from '../../src/index.js';
it('includes the current backend link and OAuth error codes (#140)', () => {
  expectTypeOf<'recovery_disabled' | 'confirmation_disabled' | 'magiclink_disabled' | 'provider_error' | 'access_denied' | 'email_required' | 'email_conflict'>().toExtend<ServerErrorCode>();
});
