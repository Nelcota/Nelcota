import { expectTypeOf, it } from 'vitest';
import type { ServerErrorCode } from '../../src/index.js';
it('includes the current backend link and OAuth error codes (#140)', () => {
  expectTypeOf<'recovery_disabled' | 'confirmation_disabled' | 'magiclink_disabled' | 'provider_error' | 'access_denied' | 'email_required' | 'email_conflict'>().toExtend<ServerErrorCode>();
});
it('lists only codes the server sends', () => {
  // Sign-in with a wrong email or password is `invalid_grant`; the panel's
  // own login, not the client API, answers `invalid_credentials`.
  expectTypeOf<'invalid_grant' | 'email_not_confirmed'>().toExtend<ServerErrorCode>();
  expectTypeOf<'invalid_credentials'>().not.toExtend<ServerErrorCode>();
  expectTypeOf<'bad_verification_code'>().not.toExtend<ServerErrorCode>();
});
