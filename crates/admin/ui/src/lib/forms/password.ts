const GENERATED_PASSWORD_LENGTH = 20;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const BYTE_CARDINALITY = 256;

// Random password for accounts created in the panel. No ambiguous characters
// (0/O, 1/l/I), so it can be read out or typed from the screen.

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

/** Uniform index in [0, n): discards bytes that would cause modulo bias. */
function uniform(n: number, random: () => number): number {
  const limit = BYTE_CARDINALITY - (BYTE_CARDINALITY % n);
  for (;;) {
    const byte = random();
    if (byte < limit) return byte % n;
  }
}

const cryptoByte = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(1));
  return new DataView(bytes.buffer).getUint8(0);
};

/** 20 characters from 59 symbols ≈ 117 bits of entropy. */
export function generatePassword(
  length = GENERATED_PASSWORD_LENGTH,
  random: () => number = cryptoByte,
): string {
  return Array.from({ length }, () => ALPHABET.charAt(uniform(ALPHABET.length, random))).join("");
}

/** What is wrong with a password; the panel shows it in the chosen language. */
export type PasswordProblem = "tooShort" | "tooLong";

/** Same rule as the server (nelcota_auth::validate_password), to warn before sending. */
export function passwordProblem(password: string): PasswordProblem | null {
  const length = Array.from(password).length;
  if (length < MIN_PASSWORD_LENGTH) return "tooShort";
  if (length > MAX_PASSWORD_LENGTH) return "tooLong";
  return null;
}
